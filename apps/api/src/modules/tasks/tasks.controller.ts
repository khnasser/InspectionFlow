import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { AuthUser, CurrentUser, Roles } from '../../common/auth';
import { DbService, TenantTx } from '../../common/db.service';
import { parse } from '../../common/validation';

const MANAGERS = ['SECTION_MANAGER', 'ADMIN'];

const reassignSchema = z.object({ userId: z.string().uuid() });
const bulkSchema = z.object({ taskIds: z.array(z.string().uuid()).min(1).max(500), userId: z.string().uuid() });
const delegationSchema = z
  .object({
    delegatorId: z.string().uuid().optional(),
    delegateId: z.string().uuid(),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    reason: z.string().max(500).optional(),
  })
  .refine((d) => Date.parse(d.endsAt) > Date.parse(d.startsAt), 'endsAt must be after startsAt');

@Controller('v1')
export class TasksController {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /**
   * My work: tasks assigned to me, unassigned tasks for my roles, and (with
   * includeDelegated) tasks still assigned to people who delegate to me now.
   */
  @Get('me/tasks')
  myTasks(@CurrentUser() user: AuthUser, @Query('includeDelegated') includeDelegated?: string) {
    const withDelegated = includeDelegated === 'true';
    return this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.query(
        `WITH delegators AS (
           SELECT delegator_id FROM user_delegations
            WHERE delegate_id = $1 AND is_active AND valid_during @> now()
         )
         SELECT t.id, t.task_type, t.status, t.priority, t.due_at, t.form_key, t.inspection_id, t.log_id,
                t.assignee_id, t.original_assignee_id, t.candidate_role,
                (t.assignee_id IS DISTINCT FROM $1 AND t.assignee_id IN (SELECT delegator_id FROM delegators)) AS via_delegation,
                l.log_number, l.inspectable_id, ins.name AS inspectable_name, ins.identifier, p.code AS process_code,
                (t.due_at IS NOT NULL AND t.due_at < now()) AS overdue
           FROM tasks t
           LEFT JOIN inspection_logs l ON l.id = t.log_id
           LEFT JOIN inspectables ins ON ins.id = l.inspectable_id
           LEFT JOIN inspection_processes p ON p.id = l.process_id
          WHERE t.status IN ('OPEN','CLAIMED','IN_PROGRESS')
            AND ( t.assignee_id = $1
               OR (t.assignee_id IS NULL AND t.candidate_role = ANY($2))
               OR ($3 AND t.assignee_id IN (SELECT delegator_id FROM delegators)) )
          ORDER BY t.priority, t.due_at NULLS LAST, t.created_at`,
        [user.userId, user.roles, withDelegated],
      ),
    );
  }

  @Post('tasks/:id/claim')
  claim(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const rows = await tx.query(
        `UPDATE tasks SET assignee_id = $2, status = 'CLAIMED'
          WHERE id = $1 AND assignee_id IS NULL AND candidate_role = ANY($3) AND status = 'OPEN'
          RETURNING id, status`,
        [id, user.userId, user.roles],
      );
      if (!rows.length) throw new NotFoundException('Task not available to claim');
      await this.audit.record(tx, { action: 'task.claimed', entityType: 'TASK', entityId: id });
      return rows[0];
    });
  }

  @Post('tasks/:id/reassign')
  reassign(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { userId } = parse(reassignSchema, body);
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const task = await tx.maybeOne<{ assignee_id: string | null }>(`SELECT assignee_id FROM tasks WHERE id = $1 FOR UPDATE`, [id]);
      if (!task) throw new NotFoundException('Task not found');
      const isManager = user.roles.some((r) => MANAGERS.includes(r));
      if (!isManager && task.assignee_id !== user.userId) throw new ForbiddenException('Only the assignee or a manager can reassign');
      await this.assertUser(tx, userId);
      await tx.query(`UPDATE tasks SET assignee_id = $2, status = 'OPEN' WHERE id = $1`, [id, userId]);
      await this.audit.record(tx, { action: 'task.reassigned', entityType: 'TASK', entityId: id, oldValue: { assignee: task.assignee_id }, newValue: { assignee: userId } });
      return { id, assigneeId: userId };
    });
  }

  /** Bulk reassignment. */
  @Post('tasks/bulk-reassign')
  @Roles(...MANAGERS)
  bulkReassign(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const { taskIds, userId } = parse(bulkSchema, body);
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      await this.assertUser(tx, userId);
      const rows = await tx.query(
        `UPDATE tasks SET assignee_id = $2, status = 'OPEN'
          WHERE id = ANY($1::uuid[]) AND status IN ('OPEN','CLAIMED','IN_PROGRESS') RETURNING id`,
        [taskIds, userId],
      );
      await this.audit.record(tx, { action: 'task.bulk_reassigned', entityType: 'TASK', newValue: { taskIds: rows.map((r) => r.id), userId } });
      return { reassigned: rows.length };
    });
  }

  @Get('delegations')
  delegations(@CurrentUser() user: AuthUser) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.query(
        `SELECT d.id, d.delegator_id, a.display_name AS delegator, d.delegate_id, b.display_name AS delegate,
                lower(d.valid_during) AS starts_at, upper(d.valid_during) AS ends_at, d.reason, d.is_active,
                (d.is_active AND d.valid_during @> now()) AS in_effect
           FROM user_delegations d JOIN users a ON a.id = d.delegator_id JOIN users b ON b.id = d.delegate_id
          WHERE d.delegator_id = $1 OR d.delegate_id = $1 OR $2
          ORDER BY lower(d.valid_during) DESC`,
        [user.userId, user.roles.some((r) => MANAGERS.includes(r))],
      ),
    );
  }

  /** PRD 3.7 "تفويض المهام": a user delegates their own tasks; managers may delegate for team members. */
  @Post('delegations')
  createDelegation(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const d = parse(delegationSchema, body);
    const delegator = d.delegatorId ?? user.userId;
    if (delegator !== user.userId && !user.roles.some((r) => MANAGERS.includes(r))) {
      throw new ForbiddenException('Only managers can delegate on behalf of others');
    }
    if (delegator === d.delegateId) throw new BadRequestException('Cannot delegate to yourself');
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      await this.assertUser(tx, d.delegateId);
      try {
        const row = await tx.one(
          `INSERT INTO user_delegations (tenant_id, delegator_id, delegate_id, valid_during, reason, created_by)
           VALUES ($1,$2,$3,tstzrange($4,$5,'[)'),$6,$7) RETURNING id`,
          [tx.tenantId, delegator, d.delegateId, d.startsAt, d.endsAt, d.reason ?? null, user.userId],
        );
        await this.audit.record(tx, { action: 'delegation.created', entityType: 'DELEGATION', entityId: row.id, newValue: d });
        return row;
      } catch (err: any) {
        if (err?.code === '23P01') throw new BadRequestException('Overlaps an existing active delegation');
        throw err;
      }
    });
  }

  @Post('delegations/:id/deactivate')
  deactivate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const rows = await tx.query(
        `UPDATE user_delegations SET is_active = false
          WHERE id = $1 AND (delegator_id = $2 OR $3) RETURNING id`,
        [id, user.userId, user.roles.some((r) => MANAGERS.includes(r))],
      );
      if (!rows.length) throw new NotFoundException('Delegation not found');
      await this.audit.record(tx, { action: 'delegation.deactivated', entityType: 'DELEGATION', entityId: id });
      return { id, isActive: false };
    });
  }

  /** PRD 3.8: team dashboard for the caller's teams. */
  @Get('team/dashboard')
  @Roles(...MANAGERS)
  dashboard(@CurrentUser() user: AuthUser) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.query(
        `SELECT u.id AS user_id, u.display_name,
                COUNT(DISTINCT t.id) FILTER (WHERE t.status IN ('OPEN','CLAIMED','IN_PROGRESS'))::int AS open_tasks,
                COUNT(DISTINCT t.id) FILTER (WHERE t.status IN ('OPEN','CLAIMED','IN_PROGRESS') AND t.due_at < now())::int AS overdue,
                COUNT(DISTINCT t.id) FILTER (WHERE t.status IN ('OPEN','CLAIMED','IN_PROGRESS')
                                    AND (t.due_at AT TIME ZONE ten.timezone)::date = (now() AT TIME ZONE ten.timezone)::date)::int AS due_today,
                (SELECT b.display_name FROM user_delegations d JOIN users b ON b.id = d.delegate_id
                  WHERE d.delegator_id = u.id AND d.is_active AND d.valid_during @> now() LIMIT 1) AS delegated_to
           FROM teams tm
           JOIN tenants ten ON ten.id = tm.tenant_id
           JOIN team_members m ON m.team_id = tm.id AND m.is_active
           JOIN users u ON u.id = m.user_id
           LEFT JOIN tasks t ON t.assignee_id = u.id
          WHERE tm.manager_id = $1 OR $2
          GROUP BY u.id, u.display_name, ten.timezone
          ORDER BY overdue DESC, open_tasks DESC`,
        [user.userId, user.roles.includes('ADMIN')],
      ),
    );
  }

  @Get('users')
  users(@CurrentUser() user: AuthUser, @Query('role') role?: string) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.query(
        `SELECT u.id, u.display_name, u.email,
                COALESCE(array_agg(r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles
           FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id
          WHERE u.is_active
          GROUP BY u.id
         HAVING $1::text IS NULL OR $1 = ANY(array_agg(r.code))
          ORDER BY u.display_name`,
        [role ?? null],
      ),
    );
  }

  private async assertUser(tx: TenantTx, userId: string) {
    const u = await tx.maybeOne(`SELECT id FROM users WHERE id = $1 AND is_active`, [userId]);
    if (!u) throw new BadRequestException('Unknown or inactive user');
  }
}
