import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  approvalChainFor,
  EngineConfigError,
  evaluateInspection,
  FindingInput,
  InspectionResult,
  overridePolicy,
  PriorOccurrence,
  ReviewLevel,
  Severity,
  ViolationRule,
} from '@inspectionflow/engine';
import { AuditService } from '../../common/audit.service';
import { AuthUser } from '../../common/auth';
import { TenantTx } from '../../common/db.service';
import { emitEvent, queueNotification } from '../../common/outbox';
import { ConfigService, ProcessRow } from '../config/config.service';
import { AssignmentService } from '../tasks/assignment.service';
import { SubmitInspection } from './inspection.schemas';

const OPEN_FINDING = ['OPEN', 'CLIENT_REPLIED', 'NOT_RESOLVED'];
const OPEN_LOG = ['OPEN', 'PENDING_CLIENT', 'PENDING_PAYMENT'];
const SEVERITY_RANK: Record<Severity, number> = { MINOR: 1, MAJOR: 2, CRITICAL: 3 };

export interface SubmitResult {
  inspectionId: string;
  logId: string;
  logNumber: string;
  cycleNumber: number;
  status: string;
  category: string;
  totalFine: number;
  followUpDate: string | null;
  review: ReviewLevel;
  approvalChain: string[];
  findings: Array<{
    id: string;
    violationCode: string;
    occurrence: number;
    severity: Severity;
    actionCode: string;
    fine: number;
    resolveBy: string;
    overrideStatus: string;
    carriedForward: boolean;
  }>;
  paymentAdvice: { id: string; number: string; amount: number } | null;
  replay: boolean;
}

@Injectable()
export class InspectionService {
  constructor(
    private readonly config: ConfigService,
    private readonly assignment: AssignmentService,
    private readonly audit: AuditService,
  ) {}

  /** Server-side, side-effect-free evaluation (provisional preview). */
  async evaluate(
    tx: TenantTx,
    input: { processCode: string; inspectableId: string; inspectionDate?: string; findings: Array<{ violationCode: string; partyIds: string[] }> },
  ): Promise<InspectionResult> {
    const tenant = await this.config.tenant(tx);
    const process = await this.config.processByCode(tx, input.processCode);
    const rules = await this.config.rulesForProcess(tx, process);
    const findings: FindingInput[] = input.findings.map((f) => ({ ...f, inspectableId: input.inspectableId }));
    const prior = await this.priorOccurrences(tx, input.inspectableId, findings);
    return this.runEngine(() =>
      evaluateInspection({
        findings,
        rules,
        prior,
        thresholds: [],
        ctx: {
          inspectionDate: input.inspectionDate ?? new Date().toISOString(),
          timeZone: tenant.timezone,
          weekendDays: tenant.weekend_days,
        },
      }),
    );
  }

  /**
   * Submit a completed inspection (online or from the offline sync queue).
   * Idempotent on clientMutationId: a replay returns the stored outcome.
   */
  async submit(tx: TenantTx, user: AuthUser, input: SubmitInspection): Promise<SubmitResult> {
    const existing = await tx.maybeOne<{ id: string; client_mutation_id: string }>(
      `SELECT id, client_mutation_id FROM inspections WHERE client_mutation_id = $1 OR id = $2`,
      [input.clientMutationId, input.id],
    );
    if (existing) {
      if (existing.client_mutation_id !== input.clientMutationId || existing.id !== input.id) {
        throw new ConflictException('Inspection id was already used by a different submission');
      }
      return { ...(await this.summary(tx, existing.id)), replay: true };
    }

    const tenant = await this.config.tenant(tx);
    const process = await this.config.processByCode(tx, input.processCode);
    if (!process.allowed_kinds.includes(input.kind)) {
      throw new BadRequestException(`Process ${process.code} does not allow ${input.kind} inspections`);
    }
    const inspectable = await tx.maybeOne(`SELECT id, name FROM inspectables WHERE id = $1`, [input.inspectableId]);
    if (!inspectable) throw new NotFoundException('Inspectable not found');

    // 1. Log: attach to the open log for this inspectable + process, else open a new one.
    const log = await this.openOrCreateLog(tx, user, process, input);
    const cycle = await tx.one<{ n: number }>(
      `SELECT COALESCE(MAX(cycle_number), 0) + 1 AS n FROM inspections WHERE log_id = $1`,
      [log.id],
    );

    // 2. Earlier open findings: resolved, carried forward, or left pending.
    const openFindings = await tx.query<{ id: string; code: string }>(
      `SELECT f.id, vt.code FROM inspection_findings f
         JOIN violation_templates vt ON vt.id = f.violation_template_id
        WHERE f.log_id = $1 AND f.status = ANY($2)`,
      [log.id, OPEN_FINDING],
    );
    const unknownResolved = input.resolvedFindingIds.filter((id) => !openFindings.some((o) => o.id === id));
    if (unknownResolved.length) {
      throw new BadRequestException(`Not open findings of this log: ${unknownResolved.join(', ')}`);
    }
    const carriedFrom = new Map<string, string>(); // code -> earlier finding id
    for (const o of openFindings) {
      // Verified as resolved -> a same-code finding in this cycle is a NEW occurrence.
      if (input.resolvedFindingIds.includes(o.id)) continue;
      if (input.findings.some((f) => f.violationCode === o.code)) carriedFrom.set(o.code, o.id);
    }

    // 3. Responsible parties (default: the inspectable's primary party).
    const primary = await tx.maybeOne<{ party_id: string }>(
      `SELECT party_id FROM inspectable_party_links WHERE inspectable_id = $1 AND is_primary LIMIT 1`,
      [input.inspectableId],
    );
    const findingInputs: FindingInput[] = input.findings.map((f) => ({
      violationCode: f.violationCode,
      inspectableId: input.inspectableId,
      partyIds: f.partyIds.length ? f.partyIds : primary ? [primary.party_id] : [],
      carriedForward: carriedFrom.has(f.violationCode),
    }));

    // 4. Engine (authoritative).
    const rules = await this.config.rulesForProcess(tx, process);
    const prior = await this.priorOccurrences(tx, input.inspectableId, findingInputs);
    const result = this.runEngine(() =>
      evaluateInspection({
        findings: findingInputs,
        rules,
        prior,
        thresholds: [],
        ctx: { inspectionDate: input.completedAt, timeZone: tenant.timezone, weekendDays: tenant.weekend_days },
      }),
    );
    const thresholds = await this.config.thresholds(tx, process.id);

    // 5. Severity overrides requested by the inspector.
    let needsOverrideApproval = false;
    const overrides = new Map<string, { severity: Severity; reason: string; status: 'PENDING' | 'APPROVED' }>();
    for (const f of input.findings) {
      if (!f.override) continue;
      const rule = rules[f.violationCode];
      const policy = overridePolicy(rule);
      if (!policy.allowed) throw new BadRequestException(`Severity of ${f.violationCode} cannot be overridden`);
      overrides.set(f.id, { ...f.override, status: policy.needsApproval ? 'PENDING' : 'APPROVED' });
      if (policy.needsApproval) needsOverrideApproval = true;
    }

    let review: ReviewLevel = result.review;
    if (needsOverrideApproval && review === 'NONE') review = 'MANAGER';
    const approvalChain = approvalChainFor(review, result.totalFine, thresholds);

    // 6. Persist inspection, checklist, findings, occurrences, decisions.
    await tx.query(
      `INSERT INTO inspections (id, tenant_id, log_id, cycle_number, performed_by, started_at, completed_at,
                                latitude, longitude, category, status, general_remarks, site_status,
                                client_mutation_id, device_id, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'SUBMITTED',$11,$12,$13,$14,$5)`,
      [
        input.id,
        tx.tenantId,
        log.id,
        cycle.n,
        user.userId,
        input.startedAt ?? null,
        input.completedAt,
        input.latitude ?? null,
        input.longitude ?? null,
        result.category,
        input.generalRemarks ?? null,
        input.siteStatus ?? null,
        input.clientMutationId,
        await this.knownDevice(tx, input.deviceId),
      ],
    );

    for (const c of input.checklist) {
      await tx.query(
        `INSERT INTO inspection_checklist_responses (id, tenant_id, inspection_id, checklist_item_id, response_value, responded_by)
         VALUES (uuid_generate_v7(), $1, $2, $3, $4, $5)`,
        [tx.tenantId, input.id, c.itemId, JSON.stringify(c.value ?? null), user.userId],
      );
    }

    if (input.resolvedFindingIds.length) {
      await tx.query(
        `UPDATE inspection_findings SET status = 'RESOLVED', resolved_at = now(), resolved_by = $2
          WHERE id = ANY($1::uuid[])`,
        [input.resolvedFindingIds, user.userId],
      );
    }
    if (carriedFrom.size) {
      // Superseded by the carried-forward finding in this cycle (linked via carried_from_id).
      await tx.query(`UPDATE inspection_findings SET status = 'CLOSED' WHERE id = ANY($1::uuid[])`, [
        Array.from(carriedFrom.values()),
      ]);
    }

    const actionIds = await this.actionIds(tx);
    const findingsOut: SubmitResult['findings'] = [];
    for (let i = 0; i < input.findings.length; i++) {
      const f = input.findings[i];
      const r = result.findings[i];
      const rule = rules[f.violationCode] as ViolationRule & { templateId: string };
      const ov = overrides.get(f.id);
      const finalSeverity = ov ? ov.severity : r.severity;
      const linkIds = await this.ensurePartyLinks(tx, user, input.inspectableId, findingInputs[i].partyIds, input.id);
      await tx.query(
        `INSERT INTO inspection_findings (id, tenant_id, log_id, inspection_id, violation_template_id, carried_from_id,
                                          parameters, remarks, calculated_occurrence, approved_occurrence,
                                          calculated_action_id, final_action_id, calculated_severity, final_severity,
                                          override_reason, override_status, fine_amount, responsible_party_link_ids,
                                          status, resolve_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$10,$11,$12,$13,$14,$15,$16,'OPEN',$17)`,
        [
          f.id,
          tx.tenantId,
          log.id,
          input.id,
          rule.templateId,
          carriedFrom.get(f.violationCode) ?? null,
          f.parameters ? JSON.stringify(f.parameters) : null,
          f.remarks ?? null,
          r.occurrence,
          actionIds[r.actionCode] ?? null,
          r.severity,
          finalSeverity,
          ov?.reason ?? null,
          ov ? ov.status : 'NONE',
          r.fine,
          linkIds,
          r.resolveBy,
        ],
      );
      if (r.recordOccurrence) {
        for (const s of r.scopeOccurrences) {
          await tx.query(
            `INSERT INTO violation_occurrences (tenant_id, violation_code, scope_type, inspectable_id, party_id,
                                                period_key, finding_id, occurred_at, occurrence_no)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [tx.tenantId, f.violationCode, s.scopeType, s.inspectableId, s.partyId, s.periodKey, f.id, input.completedAt, s.occurrenceNo],
          );
        }
      }
      findingsOut.push({
        id: f.id,
        violationCode: f.violationCode,
        occurrence: r.occurrence,
        severity: finalSeverity,
        actionCode: r.actionCode,
        fine: r.fine,
        resolveBy: r.resolveBy,
        overrideStatus: ov ? ov.status : 'NONE',
        carriedForward: carriedFrom.has(f.violationCode),
      });
    }
    for (const code of new Set(result.findings.map((r) => r.actionCode))) {
      if (actionIds[code]) {
        await tx.query(
          `INSERT INTO inspection_decisions (tenant_id, inspection_id, action_id, decided_by) VALUES ($1,$2,$3,$4)`,
          [tx.tenantId, input.id, actionIds[code], user.userId],
        );
      }
    }

    if (input.signature) {
      await tx.query(
        `INSERT INTO client_signatures (id, tenant_id, inspection_id, method, signer_name, signer_role,
                                        signature_sha256, signed_payload_sha256, latitude, longitude)
         VALUES (uuid_generate_v7(),$1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          tx.tenantId,
          input.id,
          input.signature.method,
          input.signature.signerName,
          input.signature.signerRole ?? null,
          input.signature.signatureSha256 ?? null,
          input.signature.signedPayloadSha256,
          input.latitude ?? null,
          input.longitude ?? null,
        ],
      );
      if (input.signature.method !== 'REFUSED') {
        await tx.query(`UPDATE inspections SET is_signed = true, edit_locked = true WHERE id = $1`, [input.id]);
      }
    }

    if (input.taskId) await this.assignment.completeTask(tx, input.taskId);

    await this.audit.record(tx, {
      action: 'inspection.submitted',
      entityType: 'INSPECTION',
      entityId: input.id,
      newValue: { logId: log.id, cycle: cycle.n, category: result.category, totalFine: result.totalFine, review },
      deviceId: input.deviceId ?? null,
    });
    await emitEvent(tx, 'INSPECTION', input.id, 'inspection.submitted', {
      inspectableId: input.inspectableId,
      category: result.category,
    });

    // 7. Route: auto-issue or start the approval chain.
    if (review === 'NONE') {
      await this.finalizeApproved(tx, input.id);
    } else {
      await this.startApprovals(tx, input.id, user, approvalChain, review);
    }
    return { ...(await this.summary(tx, input.id)), replay: false };
  }

  private runEngine<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof EngineConfigError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  private async knownDevice(tx: TenantTx, deviceId?: string): Promise<string | null> {
    if (!deviceId) return null;
    const d = await tx.maybeOne(`SELECT id FROM devices WHERE id = $1`, [deviceId]);
    return d ? deviceId : null;
  }

  private async openOrCreateLog(tx: TenantTx, user: AuthUser, process: ProcessRow, input: SubmitInspection) {
    // Serialise concurrent submissions for the same inspectable + process.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`log:${input.inspectableId}:${process.id}`]);
    const open = await tx.maybeOne<{ id: string; log_number: string }>(
      `SELECT id, log_number FROM inspection_logs
        WHERE inspectable_id = $1 AND process_id = $2 AND status = ANY($3)
        ORDER BY opened_at DESC LIMIT 1 FOR UPDATE`,
      [input.inspectableId, process.id, OPEN_LOG],
    );
    if (open) {
      await tx.query(`UPDATE inspection_logs SET status = 'OPEN' WHERE id = $1`, [open.id]);
      return open;
    }
    const seq = await tx.one<{ n: string }>(`SELECT next_counter($1) AS n`, [`log:${process.code}`]);
    const year = new Date(input.completedAt).getUTCFullYear();
    const logNumber = `${process.code}-${year}-${String(seq.n).padStart(6, '0')}`;
    return tx.one<{ id: string; log_number: string }>(
      `INSERT INTO inspection_logs (tenant_id, log_number, inspectable_id, process_id, kind, owner_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, log_number`,
      [tx.tenantId, logNumber, input.inspectableId, process.id, input.kind, user.userId],
    );
  }

  /** Counted ledger rows relevant to these findings (inspectable or any responsible party). */
  async priorOccurrences(tx: TenantTx, inspectableId: string, findings: FindingInput[]): Promise<PriorOccurrence[]> {
    if (findings.length === 0) return [];
    const codes = findings.map((f) => f.violationCode);
    const parties = Array.from(new Set(findings.flatMap((f) => f.partyIds)));
    const rows = await tx.query(
      `SELECT violation_code, scope_type, inspectable_id, party_id, occurred_at, is_counted
         FROM violation_occurrences
        WHERE is_counted AND violation_code = ANY($1)
          AND (inspectable_id = $2 OR party_id = ANY($3::uuid[]))`,
      [codes, inspectableId, parties],
    );
    return rows.map((r) => ({
      violationCode: r.violation_code,
      scopeType: r.scope_type,
      inspectableId: r.inspectable_id,
      partyId: r.party_id,
      occurredAt: new Date(r.occurred_at).toISOString(),
      isCounted: r.is_counted,
    }));
  }

  private async actionIds(tx: TenantTx): Promise<Record<string, string>> {
    const rows = await tx.query<{ id: string; code: string }>(`SELECT id, code FROM action_master`);
    return Object.fromEntries(rows.map((r) => [r.code, r.id]));
  }

  /** PRD 3.2: a party named during inspection is linked to the inspectable if not already. */
  private async ensurePartyLinks(
    tx: TenantTx,
    user: AuthUser,
    inspectableId: string,
    partyIds: string[],
    inspectionId: string,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const partyId of partyIds) {
      const party = await tx.maybeOne(`SELECT id FROM parties WHERE id = $1`, [partyId]);
      if (!party) throw new BadRequestException(`Unknown party ${partyId}`);
      const link = await tx.maybeOne<{ id: string }>(
        `SELECT id FROM inspectable_party_links WHERE inspectable_id = $1 AND party_id = $2 ORDER BY is_primary DESC LIMIT 1`,
        [inspectableId, partyId],
      );
      if (link) {
        ids.push(link.id);
        continue;
      }
      const created = await tx.one<{ id: string }>(
        `INSERT INTO inspectable_party_links (tenant_id, inspectable_id, party_id, role, added_during_inspection_id, added_by)
         VALUES ($1,$2,$3,'RESPONSIBLE',$4,$5) RETURNING id`,
        [tx.tenantId, inspectableId, partyId, inspectionId, user.userId],
      );
      ids.push(created.id);
    }
    return ids;
  }

  private async startApprovals(tx: TenantTx, inspectionId: string, user: AuthUser, chain: string[], review: ReviewLevel) {
    for (let i = 0; i < chain.length; i++) {
      await tx.query(
        `INSERT INTO approvals (tenant_id, subject_type, subject_id, step_no, approver_role)
         VALUES ($1,'INSPECTION',$2,$3,$4)`,
        [tx.tenantId, inspectionId, i + 1, chain[i]],
      );
    }
    await tx.query(`UPDATE inspections SET status = $2 WHERE id = $1`, [
      inspectionId,
      review === 'COMMITTEE' ? 'COMMITTEE_REVIEW' : 'UNDER_REVIEW',
    ]);
    await this.createReviewTask(tx, inspectionId, chain[0], user.userId);
  }

  /** REVIEW task: to the inspector's line manager for SECTION_MANAGER steps, else to the role pool. */
  async createReviewTask(tx: TenantTx, inspectionId: string, role: string, inspectorId: string) {
    const insp = await tx.one<{ log_id: string }>(`SELECT log_id FROM inspections WHERE id = $1`, [inspectionId]);
    let assigneeId: string | null = null;
    if (role === 'SECTION_MANAGER') {
      const mgr = await tx.maybeOne<{ manager_id: string }>(
        `SELECT t.manager_id FROM team_members m JOIN teams t ON t.id = m.team_id
          WHERE m.user_id = $1 AND m.is_active LIMIT 1`,
        [inspectorId],
      );
      assigneeId = mgr?.manager_id ?? null;
    }
    await this.assignment.createTask(tx, {
      taskType: 'REVIEW',
      logId: insp.log_id,
      inspectionId,
      assigneeId,
      candidateRole: role,
      priority: 2,
      dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      formKey: 'inspection-review',
    });
  }

  /**
   * Approved outcome: one payment advice for the inspection's fines, client
   * letters, follow-up task at the earliest resolve-by date, log status.
   */
  async finalizeApproved(tx: TenantTx, inspectionId: string): Promise<void> {
    const insp = await tx.one(
      `SELECT i.id, i.log_id, i.performed_by, i.category, i.completed_at, l.inspectable_id, l.process_id,
              p.billing_party_role
         FROM inspections i JOIN inspection_logs l ON l.id = i.log_id
         JOIN inspection_processes p ON p.id = l.process_id
        WHERE i.id = $1`,
      [inspectionId],
    );
    await tx.query(`UPDATE inspections SET status = 'APPROVED' WHERE id = $1`, [inspectionId]);
    await tx.query(`UPDATE inspectables SET last_inspected_at = $2 WHERE id = $1`, [insp.inspectable_id, insp.completed_at]);

    const findings = await tx.query(
      `SELECT id, fine_amount, resolve_by, responsible_party_link_ids FROM inspection_findings
        WHERE inspection_id = $1 AND status <> 'CANCELLED'`,
      [inspectionId],
    );
    const total = findings.reduce((s, f) => s + Number(f.fine_amount ?? 0), 0);

    let paId: string | null = null;
    if (total > 0) {
      const partyId = await this.billingParty(tx, insp.inspectable_id, insp.billing_party_role, findings);
      if (!partyId) throw new BadRequestException('No billing party: link a party to the inspectable');
      const seq = await tx.one<{ n: string }>(`SELECT next_counter('payment_advice') AS n`);
      const number = `PA-${new Date().getUTCFullYear()}-${String(seq.n).padStart(6, '0')}`;
      const pa = await tx.one<{ id: string }>(
        `INSERT INTO payment_advices (tenant_id, pa_number, log_id, inspection_id, party_id, kind, amount, due_at)
         VALUES ($1,$2,$3,$4,$5,'PENALTY',$6, now() + interval '7 days') RETURNING id`,
        [tx.tenantId, number, insp.log_id, inspectionId, partyId, total],
      );
      paId = pa.id;
      await emitEvent(tx, 'PAYMENT_ADVICE', pa.id, 'payment_advice.issued', { number, amount: total, partyId });
      for (const channel of ['EMAIL', 'SMS'] as const) {
        await queueNotification(tx, {
          recipientType: 'PARTY',
          recipientId: partyId,
          channel,
          templateCode: 'PAYMENT_ADVICE_ISSUED',
          payload: { number, amount: total, currency: 'AED' },
          entityType: 'PAYMENT_ADVICE',
          entityId: pa.id,
        });
      }
    }

    // Client letter for the inspection outcome.
    const letter =
      insp.category === 'PENALTY_CRITICAL' ? 'PENALTY_LETTER' : insp.category === 'WARNING' ? 'WARNING_LETTER' : 'INSPECTION_REPORT';
    const owner = await this.billingParty(tx, insp.inspectable_id, insp.billing_party_role, findings);
    if (owner) {
      await queueNotification(tx, {
        recipientType: 'PARTY',
        recipientId: owner,
        channel: 'EMAIL',
        templateCode: letter,
        payload: { inspectionId, category: insp.category },
        entityType: 'INSPECTION',
        entityId: inspectionId,
      });
    }

    await this.refreshLogStatus(tx, insp.log_id, insp.performed_by);
    await this.audit.record(tx, {
      action: 'inspection.approved',
      entityType: 'INSPECTION',
      entityId: inspectionId,
      newValue: { totalFine: total, paymentAdviceId: paId },
    });
    await emitEvent(tx, 'INSPECTION', inspectionId, 'inspection.closed', { category: insp.category, totalFine: total });
  }

  private async billingParty(
    tx: TenantTx,
    inspectableId: string,
    billingRole: string | null,
    findings: Array<{ responsible_party_link_ids: string[] | null }>,
  ): Promise<string | null> {
    if (billingRole) {
      const byRole = await tx.maybeOne<{ party_id: string }>(
        `SELECT party_id FROM inspectable_party_links WHERE inspectable_id = $1 AND role = $2 ORDER BY is_primary DESC LIMIT 1`,
        [inspectableId, billingRole],
      );
      if (byRole) return byRole.party_id;
    }
    const firstLink = findings.flatMap((f) => f.responsible_party_link_ids ?? [])[0];
    if (firstLink) {
      const l = await tx.maybeOne<{ party_id: string }>(`SELECT party_id FROM inspectable_party_links WHERE id = $1`, [firstLink]);
      if (l) return l.party_id;
    }
    const primary = await tx.maybeOne<{ party_id: string }>(
      `SELECT party_id FROM inspectable_party_links WHERE inspectable_id = $1 ORDER BY is_primary DESC LIMIT 1`,
      [inspectableId],
    );
    return primary?.party_id ?? null;
  }

  /**
   * Log status after any change: open findings -> PENDING_CLIENT (+ follow-up
   * task at the earliest resolve-by date); unpaid advice -> PENDING_PAYMENT;
   * otherwise CLOSED.
   */
  async refreshLogStatus(tx: TenantTx, logId: string, inspectorId: string | null): Promise<string> {
    const open = await tx.maybeOne<{ n: number; due: string | null }>(
      `SELECT COUNT(*)::int AS n, MIN(resolve_by) AS due FROM inspection_findings f
         JOIN inspections i ON i.id = f.inspection_id
        WHERE f.log_id = $1 AND f.status = ANY($2) AND i.status IN ('APPROVED','CLOSED')`,
      [logId, OPEN_FINDING],
    );
    const unpaid = await tx.maybeOne<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM payment_advices WHERE log_id = $1 AND status IN ('ISSUED','PARTIAL','OVERDUE','BLOCKED_PREPAID')`,
      [logId],
    );
    let status = 'CLOSED';
    if (open && open.n > 0) status = 'PENDING_CLIENT';
    else if (unpaid && unpaid.n > 0) status = 'PENDING_PAYMENT';

    await tx.query(
      `UPDATE inspection_logs SET status = $2, closed_at = CASE WHEN $2 = 'CLOSED' THEN now() ELSE NULL END WHERE id = $1`,
      [logId, status],
    );
    if (status === 'PENDING_CLIENT' && inspectorId) {
      const hasTask = await tx.maybeOne(
        `SELECT id FROM tasks WHERE log_id = $1 AND task_type = 'INSPECT' AND status IN ('OPEN','CLAIMED','IN_PROGRESS')`,
        [logId],
      );
      if (!hasTask) {
        await this.assignment.createTask(tx, {
          taskType: 'INSPECT',
          logId,
          assigneeId: inspectorId,
          dueAt: open!.due ? new Date(open!.due).toISOString() : null,
          formKey: 'follow-up-inspection',
        });
      }
    }
    return status;
  }

  async summary(tx: TenantTx, inspectionId: string): Promise<Omit<SubmitResult, 'replay'>> {
    const i = await tx.maybeOne(
      `SELECT i.id, i.status, i.category, i.cycle_number, l.id AS log_id, l.log_number
         FROM inspections i JOIN inspection_logs l ON l.id = i.log_id WHERE i.id = $1`,
      [inspectionId],
    );
    if (!i) throw new NotFoundException('Inspection not found');
    const findings = await tx.query(
      `SELECT f.id, vt.code, f.approved_occurrence, f.final_severity, a.code AS action_code, f.fine_amount,
              f.resolve_by, f.override_status, f.carried_from_id
         FROM inspection_findings f
         JOIN violation_templates vt ON vt.id = f.violation_template_id
         LEFT JOIN action_master a ON a.id = f.final_action_id
        WHERE f.inspection_id = $1 ORDER BY f.created_at, f.id`,
      [inspectionId],
    );
    const approvals = await tx.query(
      `SELECT approver_role FROM approvals WHERE subject_type = 'INSPECTION' AND subject_id = $1 AND decision IS NULL
        ORDER BY step_no`,
      [inspectionId],
    );
    const pa = await tx.maybeOne(
      `SELECT id, pa_number, amount FROM payment_advices WHERE inspection_id = $1 AND status <> 'CANCELLED' LIMIT 1`,
      [inspectionId],
    );
    const ymd = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d));
    const resolveDates = findings.filter((f) => f.resolve_by).map((f) => ymd(f.resolve_by)).sort();
    const totalFine = findings.reduce((s, f) => s + Number(f.fine_amount ?? 0), 0);
    const maxSev = findings.reduce((m, f) => Math.max(m, SEVERITY_RANK[f.final_severity as Severity] ?? 0), 0);
    return {
      inspectionId: i.id,
      logId: i.log_id,
      logNumber: i.log_number,
      cycleNumber: i.cycle_number,
      status: i.status,
      category: i.category ?? (maxSev === 0 ? 'NO_FINDINGS' : 'MINOR'),
      totalFine,
      followUpDate: resolveDates[0] ?? null,
      review: approvals.length ? (approvals.some((a) => a.approver_role === 'COMMITTEE') ? 'COMMITTEE' : 'MANAGER') : 'NONE',
      approvalChain: approvals.map((a) => a.approver_role),
      findings: findings.map((f) => ({
        id: f.id,
        violationCode: f.code,
        occurrence: f.approved_occurrence,
        severity: f.final_severity,
        actionCode: f.action_code,
        fine: Number(f.fine_amount ?? 0),
        resolveBy: ymd(f.resolve_by),
        overrideStatus: f.override_status,
        carriedForward: f.carried_from_id !== null,
      })),
      paymentAdvice: pa ? { id: pa.id, number: pa.pa_number, amount: Number(pa.amount) } : null,
    };
  }

  async detail(tx: TenantTx, inspectionId: string) {
    const summary = await this.summary(tx, inspectionId);
    const head = await tx.one(
      `SELECT i.completed_at, i.general_remarks, i.site_status, i.is_signed, i.edit_locked, i.performed_by,
              u.display_name AS inspector, ins.id AS inspectable_id, ins.name AS inspectable_name, ins.identifier,
              p.code AS process_code, p.name_i18n AS process_name
         FROM inspections i JOIN inspection_logs l ON l.id = i.log_id
         JOIN inspectables ins ON ins.id = l.inspectable_id
         JOIN inspection_processes p ON p.id = l.process_id
         JOIN users u ON u.id = i.performed_by
        WHERE i.id = $1`,
      [inspectionId],
    );
    const findings = await tx.query(
      `SELECT f.id, vt.code, vt.description_i18n, f.remarks, f.parameters, f.calculated_severity, f.final_severity,
              f.override_reason, f.override_status, f.status
         FROM inspection_findings f JOIN violation_templates vt ON vt.id = f.violation_template_id
        WHERE f.inspection_id = $1`,
      [inspectionId],
    );
    const approvals = await tx.query(
      `SELECT a.id, a.step_no, a.approver_role, a.decision, a.comment, a.decided_at, u.display_name AS approver
         FROM approvals a LEFT JOIN users u ON u.id = a.approver_id
        WHERE a.subject_type = 'INSPECTION' AND a.subject_id = $1 ORDER BY a.step_no, a.id`,
      [inspectionId],
    );
    const signature = await tx.maybeOne(
      `SELECT method, signer_name, signer_role, signed_at, cleared_at, clear_reason
         FROM client_signatures WHERE inspection_id = $1 ORDER BY signed_at DESC LIMIT 1`,
      [inspectionId],
    );
    return {
      ...summary,
      ...head,
      findingDetails: findings,
      approvals,
      signature,
    };
  }

  /** PRD 3.9: senior clears a signature with a reason; editing unlocks; audit keeps both. */
  async clearSignature(tx: TenantTx, user: AuthUser, inspectionId: string, reason: string) {
    const sig = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM client_signatures WHERE inspection_id = $1 AND cleared_at IS NULL ORDER BY signed_at DESC LIMIT 1`,
      [inspectionId],
    );
    if (!sig) throw new NotFoundException('No active signature on this inspection');
    await tx.query(
      `UPDATE client_signatures SET cleared_by = $2, cleared_at = now(), clear_reason = $3 WHERE id = $1`,
      [sig.id, user.userId, reason],
    );
    await tx.query(`UPDATE inspections SET is_signed = false, edit_locked = false WHERE id = $1`, [inspectionId]);
    await this.audit.record(tx, {
      action: 'signature.cleared',
      entityType: 'INSPECTION',
      entityId: inspectionId,
      newValue: { reason },
    });
    return { cleared: true };
  }

  /** Inspector answers a "more info" request; the pending review step is reopened. */
  async respond(tx: TenantTx, user: AuthUser, inspectionId: string, remarks: string) {
    const insp = await tx.maybeOne<{ status: string; performed_by: string; general_remarks: string | null }>(
      `SELECT status, performed_by, general_remarks FROM inspections WHERE id = $1 FOR UPDATE`,
      [inspectionId],
    );
    if (!insp) throw new NotFoundException('Inspection not found');
    if (insp.status !== 'MORE_INFO') throw new ConflictException('Inspection is not waiting for more information');
    if (insp.performed_by !== user.userId) throw new ForbiddenException('Only the inspector can respond');
    const last = await tx.one<{ step_no: number; approver_role: string }>(
      `SELECT step_no, approver_role FROM approvals WHERE subject_type = 'INSPECTION' AND subject_id = $1
        AND decision = 'MORE_INFO' ORDER BY decided_at DESC LIMIT 1`,
      [inspectionId],
    );
    await tx.query(
      `INSERT INTO approvals (tenant_id, subject_type, subject_id, step_no, approver_role)
       VALUES ($1,'INSPECTION',$2,$3,$4)`,
      [tx.tenantId, inspectionId, last.step_no, last.approver_role],
    );
    const remarksText = [insp.general_remarks, `[${new Date().toISOString()}] ${remarks}`].filter(Boolean).join('\n');
    await tx.query(`UPDATE inspections SET status = 'UNDER_REVIEW', general_remarks = $2 WHERE id = $1`, [inspectionId, remarksText]);
    await tx.query(
      `UPDATE tasks SET status = 'COMPLETED', completed_at = now()
        WHERE inspection_id = $1 AND task_type = 'MORE_INFO' AND status IN ('OPEN','CLAIMED','IN_PROGRESS')`,
      [inspectionId],
    );
    await this.createReviewTask(tx, inspectionId, last.approver_role, insp.performed_by);
    await this.audit.record(tx, { action: 'inspection.more_info_answered', entityType: 'INSPECTION', entityId: inspectionId, newValue: { remarks } });
    return this.summary(tx, inspectionId);
  }
}
