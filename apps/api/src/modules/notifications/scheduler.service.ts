import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit.service';
import { DbService, TenantTx } from '../../common/db.service';
import { emitEvent, queueNotification } from '../../common/outbox';

/** Per-tenant rules (tenant_settings key `scheduler`); any field may be overridden. */
export interface SchedulerRules {
  /** Days after issue on which unpaid payment advices get a reminder. */
  paymentReminderDays: number[];
  /** Block the paying party (FINANCE_BLOCK) when an advice becomes overdue. */
  blockOnOverdue: boolean;
  /** Days past due before an open task is escalated to the assignee's manager. */
  taskEscalationDays: number;
  /** Tell the log owner when a finding reaches its resolve-by date. */
  findingDueReminder: boolean;
}
export const DEFAULT_RULES: SchedulerRules = {
  paymentReminderDays: [3, 6],
  blockOnOverdue: true,
  taskEscalationDays: 3,
  findingDueReminder: true,
};

/**
 * Time-based rules, evaluated on every job pass. Each action is recorded in
 * scheduled_actions under (rule, entity, step) before anything is sent, so it
 * fires exactly once even with several workers or after a restart.
 */
@Injectable()
export class SchedulerService {
  private readonly log = new Logger('Scheduler');

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async runOnce(now = new Date()): Promise<number> {
    const tenants = await this.db.system<{ id: string }>('SELECT id FROM active_tenant_ids()');
    let fired = 0;
    for (const t of tenants) {
      try {
        fired += await this.db.withTenant(t.id, null, (tx) => this.runTenant(tx, now));
      } catch (e) {
        this.log.error(`Tenant ${t.id}: ${(e as Error).message}`);
      }
    }
    return fired;
  }

  private async rules(tx: TenantTx): Promise<SchedulerRules> {
    const row = await tx.maybeOne<{ value: Partial<SchedulerRules> }>(`SELECT value FROM tenant_settings WHERE key = 'scheduler'`);
    return { ...DEFAULT_RULES, ...(row?.value ?? {}) };
  }

  /** Claims (rule, entity, step); false if it already fired. */
  private async claim(tx: TenantTx, rule: string, entityId: string, step = 0): Promise<boolean> {
    const rows = await tx.query(
      `INSERT INTO scheduled_actions (tenant_id, rule, entity_id, step) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING rule`,
      [tx.tenantId, rule, entityId, step],
    );
    return rows.length === 1;
  }

  private async notifyParty(tx: TenantTx, partyId: string, templateCode: string, paId: string) {
    for (const channel of ['EMAIL', 'SMS'] as const) {
      await queueNotification(tx, { recipientType: 'PARTY', recipientId: partyId, channel, templateCode, payload: {}, entityType: 'PAYMENT_ADVICE', entityId: paId });
    }
  }

  private async runTenant(tx: TenantTx, now: Date): Promise<number> {
    const r = await this.rules(tx);
    let fired = 0;

    // 1. Payment reminders on the configured days after issue, while not yet due.
    for (const day of r.paymentReminderDays) {
      const due = await tx.query<{ id: string; party_id: string }>(
        `SELECT id, party_id FROM payment_advices
          WHERE status IN ('ISSUED','PARTIAL') AND issued_at + make_interval(days => $2) <= $1
            AND (due_at IS NULL OR due_at > $1)`,
        [now, day],
      );
      for (const pa of due) {
        if (!(await this.claim(tx, 'pa.reminder', pa.id, day))) continue;
        await this.notifyParty(tx, pa.party_id, 'PAYMENT_REMINDER', pa.id);
        fired++;
      }
    }

    // 2. Overdue: mark, notify, and block the party in licensing systems if the tenant wants it.
    const overdue = await tx.query<{ id: string; party_id: string; pa_number: string; amount: string }>(
      `SELECT id, party_id, pa_number, amount FROM payment_advices WHERE status IN ('ISSUED','PARTIAL') AND due_at < $1 FOR UPDATE`,
      [now],
    );
    for (const pa of overdue) {
      if (!(await this.claim(tx, 'pa.overdue', pa.id))) continue;
      await tx.query(`UPDATE payment_advices SET status = 'OVERDUE' WHERE id = $1`, [pa.id]);
      await this.audit.record(tx, { action: 'payment_advice.overdue', entityType: 'PAYMENT_ADVICE', entityId: pa.id, actorType: 'SYSTEM' });
      await emitEvent(tx, 'PAYMENT_ADVICE', pa.id, 'payment_advice.overdue', { number: pa.pa_number, amount: Number(pa.amount), partyId: pa.party_id });
      await this.notifyParty(tx, pa.party_id, 'PAYMENT_OVERDUE', pa.id);
      if (r.blockOnOverdue) {
        const blocked = await tx.query(
          `UPDATE parties SET blocked_status = 'FINANCE_BLOCK' WHERE id = $1 AND blocked_status = 'NONE' RETURNING id`,
          [pa.party_id],
        );
        if (blocked.length) {
          await this.audit.record(tx, { action: 'party.blocked', entityType: 'PARTY', entityId: pa.party_id, actorType: 'SYSTEM', newValue: { reason: 'OVERDUE', paymentAdviceId: pa.id } });
          await emitEvent(tx, 'PARTY', pa.party_id, 'party.blocked', { reason: 'OVERDUE', paymentAdviceId: pa.id });
        }
      }
      fired++;
    }

    // 3. Escalate open tasks overdue by N days to the assignee's manager (else the section managers).
    const late = await tx.query(
      `SELECT t.id, t.task_type, t.due_at, t.assignee_id, u.display_name AS assignee, u.manager_id, ins.name AS site
         FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
         LEFT JOIN inspection_logs l ON l.id = t.log_id LEFT JOIN inspectables ins ON ins.id = l.inspectable_id
        WHERE t.status IN ('OPEN','CLAIMED','IN_PROGRESS') AND t.escalated_at IS NULL
          AND t.due_at < $1::timestamptz - make_interval(days => $2)`,
      [now, r.taskEscalationDays],
    );
    for (const t of late) {
      if (!(await this.claim(tx, 'task.escalated', t.id))) continue;
      await tx.query(`UPDATE tasks SET escalated_at = $2 WHERE id = $1`, [t.id, now]);
      const managers: string[] = t.manager_id
        ? [t.manager_id]
        : (await tx.query<{ user_id: string }>(
            `SELECT ur.user_id FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id JOIN users u ON u.id = ur.user_id
              WHERE ro.code = 'SECTION_MANAGER' AND u.is_active`,
          )).map((x) => x.user_id);
      for (const m of managers) {
        await queueNotification(tx, {
          recipientType: 'USER',
          recipientId: m,
          channel: 'IN_APP',
          templateCode: 'TASK_ESCALATED',
          payload: { taskId: t.id, taskType: t.task_type, siteName: t.site ?? '', assignee: t.assignee ?? '-', dueDate: new Date(t.due_at).toISOString().slice(0, 10) },
          entityType: 'TASK',
          entityId: t.id,
        });
      }
      await emitEvent(tx, 'TASK', t.id, 'task.escalated', { managers, dueAt: t.due_at });
      fired++;
    }

    // 4. Findings reaching their resolve-by date: tell the log owner to verify close-out.
    if (r.findingDueReminder) {
      const dueFindings = await tx.query(
        `SELECT f.id, vt.code, l.owner_id, l.log_number, ins.name AS site
           FROM inspection_findings f JOIN violation_templates vt ON vt.id = f.violation_template_id
           JOIN inspection_logs l ON l.id = f.log_id JOIN inspectables ins ON ins.id = l.inspectable_id
          WHERE f.status IN ('OPEN','CLIENT_REPLIED') AND f.resolve_by <= $1 AND l.owner_id IS NOT NULL`,
        [now],
      );
      for (const f of dueFindings) {
        if (!(await this.claim(tx, 'finding.due', f.id))) continue;
        await queueNotification(tx, {
          recipientType: 'USER',
          recipientId: f.owner_id,
          channel: 'IN_APP',
          templateCode: 'FINDING_DUE',
          payload: { findingId: f.id, code: f.code, siteName: f.site, logNumber: f.log_number },
          entityType: 'FINDING',
          entityId: f.id,
        });
        fired++;
      }
    }
    return fired;
  }
}
