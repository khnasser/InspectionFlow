import { Injectable, NotFoundException } from '@nestjs/common';
import { ApprovalThreshold, ViolationRule } from '@inspectionflow/engine';
import { TenantTx } from '../../common/db.service';

export interface ProcessRow {
  id: string;
  code: string;
  version: number;
  name_i18n: Record<string, string>;
  billing_type: 'ROUTINE' | 'SERVICE';
  allowed_kinds: string[];
  repetition_strategy: ViolationRule['repetitionStrategy'];
  billing_party_role: string | null;
  workflow_key: string;
  one_open_log_per_inspectable: boolean;
}

export interface TenantProfile {
  id: string;
  code: string;
  timezone: string;
  weekend_days: number[];
  default_locale: string;
}

/**
 * Reads the tenant's versioned configuration and turns it into engine inputs.
 * Only active versions (effective now) are returned.
 */
@Injectable()
export class ConfigService {
  async tenant(tx: TenantTx): Promise<TenantProfile> {
    return tx.one<TenantProfile>(
      `SELECT id, code, timezone, weekend_days, default_locale FROM tenants WHERE id = $1`,
      [tx.tenantId],
    );
  }

  async processByCode(tx: TenantTx, code: string): Promise<ProcessRow> {
    const row = await tx.maybeOne<ProcessRow>(
      `SELECT id, code, version, name_i18n, billing_type, allowed_kinds, repetition_strategy,
              billing_party_role, workflow_key, one_open_log_per_inspectable
         FROM inspection_processes
        WHERE code = $1 AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())
        ORDER BY version DESC LIMIT 1`,
      [code],
    );
    if (!row) throw new NotFoundException(`Unknown inspection process ${code}`);
    return row;
  }

  /** Engine rules for every active violation template usable by the process. */
  async rulesForProcess(tx: TenantTx, process: ProcessRow): Promise<Record<string, ViolationRule & { templateId: string }>> {
    const templates = await tx.query(
      `SELECT DISTINCT ON (vt.code) vt.id, vt.code, r.repetition_strategy, r.repeat_window_days, r.reset_policy,
              r.fine_mode, r.base_fine, r.fine_multiplier, r.fine_cap, r.follow_up_days, r.calendar_days,
              r.severity_override
         FROM violation_templates vt
         JOIN violation_rules r ON r.violation_template_id = vt.id
        WHERE vt.status = 'ACTIVE' AND (vt.process_id IS NULL OR vt.process_id = $1)
          AND vt.effective_from <= now() AND (vt.effective_to IS NULL OR vt.effective_to > now())
        ORDER BY vt.code, vt.version DESC`,
      [process.id],
    );
    if (templates.length === 0) return {};
    const ladder = await tx.query(
      `SELECT l.violation_template_id, l.from_occurrence, l.to_occurrence, a.code AS action_code, l.severity,
              l.fine_amount, l.requires_manager_review, l.requires_committee_review, l.suspension_days
         FROM violation_action_ladder l JOIN action_master a ON a.id = l.action_id
        WHERE l.violation_template_id = ANY($1::uuid[])
        ORDER BY l.from_occurrence`,
      [templates.map((t) => t.id)],
    );
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    const out: Record<string, ViolationRule & { templateId: string }> = {};
    for (const t of templates) {
      out[t.code] = {
        templateId: t.id,
        violationCode: t.code,
        repetitionStrategy: t.repetition_strategy ?? process.repetition_strategy,
        repeatWindowDays: t.repeat_window_days,
        resetPolicy: t.reset_policy,
        fineMode: t.fine_mode,
        baseFine: num(t.base_fine),
        fineMultiplier: num(t.fine_multiplier),
        fineCap: num(t.fine_cap),
        followUpDays: t.follow_up_days,
        calendarDays: t.calendar_days,
        severityOverride: t.severity_override,
        ladder: ladder
          .filter((l) => l.violation_template_id === t.id)
          .map((l) => ({
            fromOccurrence: l.from_occurrence,
            toOccurrence: l.to_occurrence,
            actionCode: l.action_code,
            severity: l.severity,
            fineAmount: num(l.fine_amount),
            requiresManagerReview: l.requires_manager_review,
            requiresCommitteeReview: l.requires_committee_review,
            suspensionDays: l.suspension_days,
          })),
      };
    }
    return out;
  }

  async thresholds(tx: TenantTx, processId: string): Promise<ApprovalThreshold[]> {
    const rows = await tx.query(
      `SELECT min_amount, max_amount, approval_chain FROM approval_thresholds
        WHERE process_id = $1 OR process_id IS NULL
        ORDER BY (process_id IS NULL), min_amount`,
      [processId],
    );
    return rows.map((r) => ({
      minAmount: Number(r.min_amount),
      maxAmount: r.max_amount === null ? null : Number(r.max_amount),
      approvalChain: r.approval_chain,
    }));
  }

  /** Everything the mobile app needs to work offline for this tenant. */
  async bundle(tx: TenantTx) {
    const tenant = await this.tenant(tx);
    const processes = await tx.query<ProcessRow>(
      `SELECT DISTINCT ON (code) id, code, version, name_i18n, billing_type, allowed_kinds, repetition_strategy,
              billing_party_role, workflow_key, one_open_log_per_inspectable
         FROM inspection_processes
        WHERE effective_from <= now() AND (effective_to IS NULL OR effective_to > now())
        ORDER BY code, version DESC`,
    );
    const result = [];
    for (const p of processes) {
      const rules = await this.rulesForProcess(tx, p);
      const templates = await tx.query(
        `SELECT DISTINCT ON (code) id, code, version, category, description_i18n, default_severity, parameters, regulation_ref
           FROM violation_templates
          WHERE status = 'ACTIVE' AND (process_id IS NULL OR process_id = $1)
          ORDER BY code, version DESC`,
        [p.id],
      );
      const checklists = await tx.query(
        `SELECT c.id, c.code, c.version, c.name_i18n,
                COALESCE(json_agg(json_build_object('id', s.id, 'code', s.code, 'name', s.name_i18n, 'order', s.order_num,
                  'items', (SELECT COALESCE(json_agg(json_build_object('id', i.id, 'code', i.code, 'label', i.label_i18n,
                              'type', i.field_type, 'options', i.options, 'required', i.is_required) ORDER BY i.order_num), '[]')
                              FROM checklist_items i WHERE i.section_id = s.id))
                  ORDER BY s.order_num) FILTER (WHERE s.id IS NOT NULL), '[]') AS sections
           FROM checklists c LEFT JOIN checklist_sections s ON s.checklist_id = c.id
          WHERE c.process_id = $1 AND c.status = 'PUBLISHED'
          GROUP BY c.id`,
        [p.id],
      );
      result.push({
        ...p,
        thresholds: await this.thresholds(tx, p.id),
        violations: templates.map((t) => ({ ...t, rule: rules[t.code] ?? null })),
        checklists,
      });
    }
    const actions = await tx.query(
      `SELECT code, name_i18n, rank FROM action_master WHERE is_active ORDER BY rank`,
    );
    return {
      tenant: {
        id: tenant.id,
        code: tenant.code,
        timeZone: tenant.timezone,
        weekendDays: tenant.weekend_days,
        defaultLocale: tenant.default_locale,
      },
      actions,
      processes: result,
      generatedAt: new Date().toISOString(),
    };
  }
}
