import { Injectable } from '@nestjs/common';
import { TenantTx } from '../../common/db.service';

export interface NewTask {
  taskType: 'INSPECT' | 'REVIEW' | 'MORE_INFO' | 'PAYMENT_FOLLOW_UP' | 'CLOSE_OUT';
  logId?: string | null;
  inspectionId?: string | null;
  /** Intended assignee; delegation may redirect it. */
  assigneeId?: string | null;
  candidateRole?: string | null;
  candidateTeamId?: string | null;
  dueAt?: string | null;
  priority?: number;
  formKey?: string | null;
}

/**
 * Task creation with delegation resolved at assignment time (PRD 3.7):
 * if the intended assignee has an active delegation now, the task goes to the
 * delegate and the original assignee is kept. Tasks created before a delegation
 * starts are not moved (BCC/CPR rule); the delegate still sees them through
 * includeDelegated.
 */
@Injectable()
export class AssignmentService {
  async resolveAssignee(tx: TenantTx, userId: string, at: Date = new Date()): Promise<string> {
    // Follow a chain of delegations (A -> B -> C) but never loop.
    let current = userId;
    const seen = new Set<string>([current]);
    for (let i = 0; i < 5; i++) {
      const d = await tx.maybeOne<{ delegate_id: string }>(
        `SELECT delegate_id FROM user_delegations
          WHERE delegator_id = $1 AND is_active AND valid_during @> $2::timestamptz
            AND (scope IS NULL OR scope = '{}'::jsonb)
          LIMIT 1`,
        [current, at.toISOString()],
      );
      if (!d || seen.has(d.delegate_id)) break;
      current = d.delegate_id;
      seen.add(current);
    }
    return current;
  }

  async createTask(tx: TenantTx, t: NewTask): Promise<{ id: string; assigneeId: string | null }> {
    const assignee = t.assigneeId ? await this.resolveAssignee(tx, t.assigneeId) : null;
    const row = await tx.one<{ id: string }>(
      `INSERT INTO tasks (tenant_id, task_type, log_id, inspection_id, assignee_id, original_assignee_id,
                          candidate_role, candidate_team_id, priority, due_at, form_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        tx.tenantId,
        t.taskType,
        t.logId ?? null,
        t.inspectionId ?? null,
        assignee,
        t.assigneeId ?? null,
        t.candidateRole ?? null,
        t.candidateTeamId ?? null,
        t.priority ?? 3,
        t.dueAt ?? null,
        t.formKey ?? null,
      ],
    );
    return { id: row.id, assigneeId: assignee };
  }

  async completeTask(tx: TenantTx, taskId: string): Promise<void> {
    await tx.query(
      `UPDATE tasks SET status = 'COMPLETED', completed_at = now()
        WHERE id = $1 AND status NOT IN ('COMPLETED','CANCELLED')`,
      [taskId],
    );
  }
}
