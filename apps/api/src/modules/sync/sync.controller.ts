import { Body, Controller, Get, HttpException, Post } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { parse } from '../../common/validation';
import { submitInspectionSchema } from '../inspections/inspection.schemas';
import { InspectionService } from '../inspections/inspection.service';

const pushSchema = z.object({
  batchId: z.string().uuid(),
  deviceId: z.string().uuid(),
  platform: z.enum(['IOS', 'ANDROID', 'WEB']).default('ANDROID'),
  appVersion: z.string().max(40).optional(),
  mutations: z
    .array(
      z.object({
        clientMutationId: z.string().uuid(),
        type: z.literal('inspection.submit'),
        payload: z.unknown(),
      }),
    )
    .max(200),
});

type MutationResult = {
  clientMutationId: string;
  status: 'APPLIED' | 'REPLAYED' | 'REJECTED';
  result?: unknown;
  error?: { status: number; message: unknown };
};

/**
 * Offline sync. Push applies each mutation in its own transaction (one bad
 * record never blocks the rest) and is idempotent per clientMutationId. Pull
 * returns the user's work package plus the occurrence history the device needs
 * to show provisional engine results offline.
 */
@Controller('v1/sync')
export class SyncController {
  constructor(private readonly db: DbService, private readonly inspections: InspectionService) {}

  @Post('push')
  @Roles('INSPECTOR', 'SENIOR_INSPECTOR')
  async push(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const batch = parse(pushSchema, body);
    await this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      await tx.query(
        `INSERT INTO devices (id, tenant_id, user_id, platform, app_version, last_sync_at)
         VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (id) DO UPDATE SET last_sync_at = now(), app_version = EXCLUDED.app_version`,
        [batch.deviceId, tx.tenantId, user.userId, batch.platform, batch.appVersion ?? null],
      );
      await tx.query(
        `INSERT INTO sync_batches (id, tenant_id, device_id, user_id, direction, mutation_count, status)
         VALUES ($1,$2,$3,$4,'PUSH',$5,'RECEIVED') ON CONFLICT (id) DO NOTHING`,
        [batch.batchId, tx.tenantId, batch.deviceId, user.userId, batch.mutations.length],
      );
    });

    const results: MutationResult[] = [];
    for (const m of batch.mutations) {
      try {
        const payload = parse(submitInspectionSchema, { ...(m.payload as object), clientMutationId: m.clientMutationId, deviceId: batch.deviceId });
        const r = await this.db.withTenant(user.tenantId, user.userId, (tx) => this.inspections.submit(tx, user, payload));
        results.push({ clientMutationId: m.clientMutationId, status: r.replay ? 'REPLAYED' : 'APPLIED', result: r });
      } catch (err) {
        const status = err instanceof HttpException ? err.getStatus() : 500;
        const message = err instanceof HttpException ? err.getResponse() : 'Internal error';
        results.push({ clientMutationId: m.clientMutationId, status: 'REJECTED', error: { status, message } });
      }
    }
    const failed = results.filter((r) => r.status === 'REJECTED').length;
    await this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.query(`UPDATE sync_batches SET status = $2, applied_at = now() WHERE id = $1`, [
        batch.batchId,
        failed === 0 ? 'APPLIED' : failed === results.length ? 'FAILED' : 'PARTIAL',
      ]),
    );
    return { batchId: batch.batchId, results, serverTime: new Date().toISOString() };
  }

  @Get('pull')
  pull(@CurrentUser() user: AuthUser) {
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const tasks = await tx.query(
        `SELECT t.id, t.task_type, t.status, t.due_at, t.priority, t.log_id, t.inspection_id, l.inspectable_id,
                l.log_number, p.code AS process_code, t.updated_at
           FROM tasks t LEFT JOIN inspection_logs l ON l.id = t.log_id LEFT JOIN inspection_processes p ON p.id = l.process_id
          WHERE (t.assignee_id = $1 OR (t.assignee_id IS NULL AND t.candidate_role = ANY($2)))
            AND t.status IN ('OPEN','CLAIMED','IN_PROGRESS')`,
        [user.userId, user.roles],
      );
      const inspectableIds = Array.from(new Set(tasks.map((t) => t.inspectable_id).filter(Boolean)));
      const inspectables = await tx.query(
        `SELECT i.id, i.identifier, i.name, i.name_i18n, i.address, i.latitude, i.longitude, ty.code AS type_code,
                COALESCE(json_agg(json_build_object('partyId', l.party_id, 'role', l.role, 'isPrimary', l.is_primary,
                  'name', COALESCE(p.company_name, p.first_name || ' ' || COALESCE(p.last_name,''))))
                  FILTER (WHERE l.id IS NOT NULL), '[]') AS parties
           FROM inspectables i JOIN inspectable_types ty ON ty.id = i.type_id
           LEFT JOIN inspectable_party_links l ON l.inspectable_id = i.id
           LEFT JOIN parties p ON p.id = l.party_id
          WHERE i.id = ANY($1::uuid[])
          GROUP BY i.id, ty.code`,
        [inspectableIds],
      );
      const openFindings = await tx.query(
        `SELECT f.id, f.log_id, vt.code AS violation_code, f.final_severity, f.resolve_by, f.remarks, l.inspectable_id
           FROM inspection_findings f JOIN inspection_logs l ON l.id = f.log_id
           JOIN violation_templates vt ON vt.id = f.violation_template_id
           JOIN inspections i ON i.id = f.inspection_id
          WHERE l.inspectable_id = ANY($1::uuid[]) AND f.status IN ('OPEN','CLIENT_REPLIED','NOT_RESOLVED')
            AND i.status IN ('APPROVED','CLOSED')`,
        [inspectableIds],
      );
      const partyIds = Array.from(new Set(inspectables.flatMap((i) => i.parties.map((p: any) => p.partyId))));
      const occurrences = await tx.query(
        `SELECT violation_code AS "violationCode", scope_type AS "scopeType", inspectable_id AS "inspectableId",
                party_id AS "partyId", occurred_at AS "occurredAt", is_counted AS "isCounted"
           FROM violation_occurrences
          WHERE is_counted AND occurred_at > now() - interval '2 years'
            AND (inspectable_id = ANY($1::uuid[]) OR party_id = ANY($2::uuid[]))`,
        [inspectableIds, partyIds],
      );
      return { serverTime: new Date().toISOString(), tasks, inspectables, openFindings, occurrences };
    });
  }
}
