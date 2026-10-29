import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { overrideCounterDelta, Severity } from '@inspectionflow/engine';
import { AuditService } from '../../common/audit.service';
import { AuthUser } from '../../common/auth';
import { TenantTx } from '../../common/db.service';
import { AssignmentService } from '../tasks/assignment.service';
import { InspectionService } from './inspection.service';

/**
 * Multi-step approval of inspections (manager -> committee -> director -> CEO,
 * per the tenant's approval thresholds). The step's role must match the caller.
 */
@Injectable()
export class ReviewService {
  constructor(
    private readonly inspections: InspectionService,
    private readonly assignment: AssignmentService,
    private readonly audit: AuditService,
  ) {}

  /** Pending approval steps the caller can act on now. */
  async pending(tx: TenantTx, user: AuthUser) {
    return tx.query(
      `SELECT a.id AS approval_id, a.step_no, a.approver_role, i.id AS inspection_id, i.status, i.category,
              i.completed_at, l.log_number, ins.name AS inspectable_name, u.display_name AS inspector,
              (SELECT COALESCE(SUM(fine_amount),0) FROM inspection_findings f WHERE f.inspection_id = i.id) AS total_fine
         FROM approvals a
         JOIN inspections i ON i.id = a.subject_id AND a.subject_type = 'INSPECTION'
         JOIN inspection_logs l ON l.id = i.log_id
         JOIN inspectables ins ON ins.id = l.inspectable_id
         JOIN users u ON u.id = i.performed_by
        WHERE a.decision IS NULL
          AND a.approver_role = ANY($1)
          AND i.status IN ('UNDER_REVIEW','COMMITTEE_REVIEW')
          AND a.step_no = (SELECT MIN(a2.step_no) FROM approvals a2
                            WHERE a2.subject_id = a.subject_id AND a2.decision IS NULL)
        ORDER BY i.completed_at`,
      [user.roles],
    );
  }

  async decide(
    tx: TenantTx,
    user: AuthUser,
    approvalId: string,
    body: { decision: 'APPROVED' | 'REJECTED' | 'MORE_INFO'; comment?: string; overrides: Array<{ findingId: string; approve: boolean }> },
  ) {
    const a = await tx.maybeOne<{ id: string; subject_id: string; step_no: number; approver_role: string; decision: string | null }>(
      `SELECT id, subject_id, step_no, approver_role, decision FROM approvals WHERE id = $1 FOR UPDATE`,
      [approvalId],
    );
    if (!a) throw new NotFoundException('Approval not found');
    if (a.decision) throw new ConflictException('This step has already been decided');
    if (!user.roles.includes(a.approver_role) && !user.roles.includes('ADMIN')) {
      throw new ForbiddenException(`Step requires role ${a.approver_role}`);
    }
    const current = await tx.one<{ step: number }>(
      `SELECT MIN(step_no) AS step FROM approvals WHERE subject_id = $1 AND decision IS NULL`,
      [a.subject_id],
    );
    if (current.step !== a.step_no) throw new ConflictException('An earlier approval step is still pending');

    const insp = await tx.one<{ id: string; status: string; performed_by: string; log_id: string }>(
      `SELECT id, status, performed_by, log_id FROM inspections WHERE id = $1 FOR UPDATE`,
      [a.subject_id],
    );
    if (!['UNDER_REVIEW', 'COMMITTEE_REVIEW'].includes(insp.status)) {
      throw new ConflictException(`Inspection is ${insp.status}`);
    }
    if (insp.performed_by === user.userId) {
      throw new ForbiddenException('Inspectors cannot approve their own inspections');
    }

    await tx.query(
      `UPDATE approvals SET decision = $2, comment = $3, approver_id = $4, decided_at = now() WHERE id = $1`,
      [a.id, body.decision, body.comment ?? null, user.userId],
    );
    await tx.query(
      `UPDATE tasks SET status = 'COMPLETED', completed_at = now()
        WHERE inspection_id = $1 AND task_type = 'REVIEW' AND status IN ('OPEN','CLAIMED','IN_PROGRESS')`,
      [insp.id],
    );
    await this.audit.record(tx, {
      action: `review.${body.decision.toLowerCase()}`,
      entityType: 'INSPECTION',
      entityId: insp.id,
      newValue: { step: a.step_no, role: a.approver_role, comment: body.comment ?? null },
    });

    if (body.decision === 'MORE_INFO') {
      await tx.query(`UPDATE inspections SET status = 'MORE_INFO' WHERE id = $1`, [insp.id]);
      // Remaining later steps stay pending; the answered step is re-created on respond().
      await this.assignment.createTask(tx, {
        taskType: 'MORE_INFO',
        logId: insp.log_id,
        inspectionId: insp.id,
        assigneeId: insp.performed_by,
        priority: 1,
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
        formKey: 'more-info',
      });
      return this.inspections.summary(tx, insp.id);
    }

    if (body.decision === 'REJECTED') {
      await tx.query(`UPDATE inspections SET status = 'REJECTED' WHERE id = $1`, [insp.id]);
      await tx.query(`UPDATE approvals SET decision = 'REJECTED', decided_at = now() WHERE subject_id = $1 AND decision IS NULL`, [insp.id]);
      await tx.query(`UPDATE inspection_findings SET status = 'CANCELLED' WHERE inspection_id = $1`, [insp.id]);
      // Rejected findings do not count as occurrences.
      await tx.query(
        `UPDATE violation_occurrences SET is_counted = false
          WHERE finding_id IN (SELECT id FROM inspection_findings WHERE inspection_id = $1)`,
        [insp.id],
      );
      await this.inspections.refreshLogStatus(tx, insp.log_id, null);
      return this.inspections.summary(tx, insp.id);
    }

    // APPROVED: next step, or final approval.
    const next = await tx.maybeOne<{ approver_role: string }>(
      `SELECT approver_role FROM approvals WHERE subject_id = $1 AND decision IS NULL ORDER BY step_no LIMIT 1`,
      [insp.id],
    );
    if (next) {
      await this.inspections.createReviewTask(tx, insp.id, next.approver_role, insp.performed_by);
      return this.inspections.summary(tx, insp.id);
    }
    await this.applyOverrideDecisions(tx, insp.id, body.overrides);
    await this.inspections.finalizeApproved(tx, insp.id);
    return this.inspections.summary(tx, insp.id);
  }

  /**
   * Pending severity overrides: approved -> keep requested severity and adjust
   * the occurrence counter (demotion -1, escalation +1, construction-safety rules);
   * rejected -> restore the calculated severity, counter unchanged.
   */
  private async applyOverrideDecisions(tx: TenantTx, inspectionId: string, decisions: Array<{ findingId: string; approve: boolean }>) {
    const pending = await tx.query<{ id: string; calculated_severity: Severity; final_severity: Severity; calculated_occurrence: number }>(
      `SELECT id, calculated_severity, final_severity, calculated_occurrence FROM inspection_findings
        WHERE inspection_id = $1 AND override_status = 'PENDING'`,
      [inspectionId],
    );
    for (const f of pending) {
      const approve = decisions.find((d) => d.findingId === f.id)?.approve ?? true;
      if (!approve) {
        await tx.query(
          `UPDATE inspection_findings SET override_status = 'REJECTED', final_severity = calculated_severity WHERE id = $1`,
          [f.id],
        );
        continue;
      }
      const delta = overrideCounterDelta(f.calculated_severity, f.final_severity, true);
      await tx.query(
        `UPDATE inspection_findings SET override_status = 'APPROVED', approved_occurrence = GREATEST(1, calculated_occurrence + $2)
          WHERE id = $1`,
        [f.id, delta],
      );
      if (delta < 0) {
        // Demotion: this finding no longer counts towards future repeats.
        await tx.query(`UPDATE violation_occurrences SET is_counted = false WHERE finding_id = $1`, [f.id]);
      } else if (delta > 0) {
        // Escalation: count one extra occurrence for the same scope keys.
        await tx.query(
          `INSERT INTO violation_occurrences (tenant_id, violation_code, scope_type, inspectable_id, party_id, period_key,
                                              finding_id, occurred_at, occurrence_no)
           SELECT tenant_id, violation_code, scope_type, inspectable_id, party_id, period_key, finding_id, occurred_at,
                  occurrence_no + 1
             FROM violation_occurrences WHERE finding_id = $1 AND is_counted`,
          [f.id],
        );
      }
    }
  }
}
