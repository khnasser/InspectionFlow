import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from 'pg';
import request from 'supertest';
import { uuidv7 } from '@inspectionflow/engine';
import { AppModule } from '../src/app.module';
import { loadConfig } from '../src/common/config';
import { SchedulerService } from '../src/modules/notifications/scheduler.service';
import { signWebhook } from '../src/modules/payments/payments.controller';

const state = JSON.parse(readFileSync(join(tmpdir(), 'inspectionflow-test-db.json'), 'utf8'));
const DOMAIN = 'demoauth.inspectionflow.test';
const WEBHOOK_SECRET = 'scheduler-test-webhook-secret';

let app: INestApplication;
let http: any;
let db: Client;
let scheduler: SchedulerService;
const tokens: Record<string, string> = {};
const api = (who: string) => ({
  get: (url: string) => request(http).get(url).set('Authorization', `Bearer ${tokens[who]}`),
  post: (url: string, b?: object) => request(http).post(url).set('Authorization', `Bearer ${tokens[who]}`).send(b ?? {}),
});
const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

let paId = '';
let partyId = '';
let logId = '';
let inspectionId = '';

beforeAll(async () => {
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: state.appUrl,
    AUTH_MODE: 'dev',
    NODE_ENV: 'test',
    REPORT_WORKER: 'off',
    PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STORAGE_LOCAL_DIR: join(tmpdir(), 'inspectionflow-test-storage'),
  });
  app = await NestFactory.create(AppModule.register(config), { logger: false });
  await app.init();
  http = app.getHttpServer();
  scheduler = app.get(SchedulerService);
  for (const k of ['ahmed', 'sara']) {
    tokens[k] = (await request(http).post('/v1/dev/login').send({ tenantCode: 'DEMO-AUTH', email: `${k}@${DOMAIN}` }).expect(201)).body.accessToken;
  }
  db = new Client({ connectionString: state.adminUrl });
  await db.connect();

  // An approved CS-02 penalty on a fresh site owned by a fresh party.
  const party = (await api('ahmed').post('/v1/parties', { type: 'COMPANY', companyName: 'Scheduler LLC', email: 'pay@sched.test', phone: '0501112233' }).expect(201)).body;
  partyId = party.id;
  const site = (await api('ahmed').post('/v1/inspectables', { typeCode: 'BUILDING_PROJECT', identifier: 'P-4001', name: 'Scheduler site' }).expect(201)).body;
  await api('ahmed').post(`/v1/inspectables/${site.id}/parties`, { partyId, role: 'OWNER', isPrimary: true }).expect(201);
  inspectionId = uuidv7();
  const sub = await api('ahmed')
    .post('/v1/inspections/submit', {
      id: inspectionId, clientMutationId: uuidv7(), processCode: 'CONSTRUCTION_SAFETY', inspectableId: site.id, kind: 'RANDOM',
      completedAt: new Date().toISOString(), findings: [{ id: uuidv7(), violationCode: 'CS-02' }],
    })
    .expect(201);
  logId = sub.body.logId;
  const step = (await api('sara').get('/v1/reviews').expect(200)).body.find((p: any) => p.inspection_id === inspectionId);
  await api('sara').post(`/v1/approvals/${step.approval_id}/decide`, { decision: 'APPROVED' }).expect(201);
  paId = (await q(`SELECT id FROM payment_advices WHERE inspection_id = $1`, [inspectionId]))[0].id;
});

afterAll(async () => {
  await db?.query(`UPDATE tasks SET status = 'CANCELLED' WHERE log_id = $1`, [logId]);
  await db?.end();
  await app?.close();
});

const notes = (template: string, entityId: string) =>
  q(`SELECT channel, recipient_type, recipient_id FROM notifications WHERE template_code = $1 AND entity_id = $2 ORDER BY channel`, [template, entityId]);

describe('scheduler', () => {
  it('sends the day-3 payment reminder once, by email and SMS', async () => {
    await q(`UPDATE payment_advices SET issued_at = now() - interval '4 days', due_at = now() + interval '3 days' WHERE id = $1`, [paId]);
    await scheduler.runOnce();
    await scheduler.runOnce();
    expect(await notes('PAYMENT_REMINDER', paId)).toEqual([
      { channel: 'EMAIL', recipient_type: 'PARTY', recipient_id: partyId },
      { channel: 'SMS', recipient_type: 'PARTY', recipient_id: partyId },
    ]);
  });

  it('marks an unpaid advice overdue, notifies, blocks the party and publishes the events — once', async () => {
    await q(`UPDATE payment_advices SET issued_at = now() - interval '8 days', due_at = now() - interval '1 hour' WHERE id = $1`, [paId]);
    await scheduler.runOnce();
    await scheduler.runOnce();
    expect((await q(`SELECT status FROM payment_advices WHERE id = $1`, [paId]))[0].status).toBe('OVERDUE');
    expect(await notes('PAYMENT_OVERDUE', paId)).toHaveLength(2);
    // The day-6 reminder no longer goes out once the advice is past due.
    expect(await notes('PAYMENT_REMINDER', paId)).toHaveLength(2);
    expect((await q(`SELECT blocked_status FROM parties WHERE id = $1`, [partyId]))[0].blocked_status).toBe('FINANCE_BLOCK');
    const events = await q(`SELECT event_type FROM outbox WHERE aggregate_id = ANY($1::uuid[]) AND event_type IN ('payment_advice.overdue','party.blocked')`, [[paId, partyId]]);
    expect(events.map((e) => e.event_type).sort()).toEqual(['party.blocked', 'payment_advice.overdue']);
    const audit = await q(`SELECT action FROM audit_logs WHERE entity_id = ANY($1::uuid[]) AND action IN ('payment_advice.overdue','party.blocked')`, [[paId, partyId]]);
    expect(audit).toHaveLength(2);
  });

  it('payment of the overdue advice lifts the block', async () => {
    const amount = Number((await q(`SELECT amount FROM payment_advices WHERE id = $1`, [paId]))[0].amount);
    const payload = { tenantId: state.tenantA, paymentAdviceId: paId, gateway: 'MOCK', gatewayTxnId: `txn-${paId}`, amount, currency: 'AED', status: 'CAPTURED' };
    const res = await request(http).post('/v1/webhooks/payments').set('x-signature', signWebhook(WEBHOOK_SECRET, payload)).send(payload).expect(201);
    expect(res.body.status).toBe('PAID');
    expect((await q(`SELECT blocked_status FROM parties WHERE id = $1`, [partyId]))[0].blocked_status).toBe('NONE');
    expect(await q(`SELECT 1 FROM outbox WHERE aggregate_id = $1 AND event_type = 'party.unblocked'`, [partyId])).toHaveLength(1);
  });

  it('escalates an overdue task to the assignee’s manager once', async () => {
    const task = (await q(`SELECT id FROM tasks WHERE log_id = $1 AND status IN ('OPEN','CLAIMED','IN_PROGRESS') LIMIT 1`, [logId]))[0];
    expect(task).toBeDefined();
    await q(`UPDATE tasks SET due_at = now() - interval '5 days' WHERE id = $1`, [task.id]);
    await scheduler.runOnce();
    await scheduler.runOnce();
    const sara = (await q(`SELECT id FROM users WHERE email = $1`, [`sara@${DOMAIN}`]))[0].id;
    expect(await notes('TASK_ESCALATED', task.id)).toEqual([{ channel: 'IN_APP', recipient_type: 'USER', recipient_id: sara }]);
    expect((await q(`SELECT escalated_at FROM tasks WHERE id = $1`, [task.id]))[0].escalated_at).not.toBeNull();
  });

  it('tells the log owner when a finding reaches its resolve-by date', async () => {
    const f = (await q(`SELECT id FROM inspection_findings WHERE inspection_id = $1`, [inspectionId]))[0];
    await q(`UPDATE inspection_findings SET resolve_by = now() - interval '1 hour' WHERE id = $1`, [f.id]);
    await scheduler.runOnce();
    await scheduler.runOnce();
    const ahmed = (await q(`SELECT id FROM users WHERE email = $1`, [`ahmed@${DOMAIN}`]))[0].id;
    expect(await notes('FINDING_DUE', f.id)).toEqual([{ channel: 'IN_APP', recipient_type: 'USER', recipient_id: ahmed }]);
  });

  it('honours tenant rules: reminders off when the tenant sets none', async () => {
    await q(
      `INSERT INTO tenant_settings (tenant_id, key, value) VALUES ($1,'scheduler','{"paymentReminderDays": []}')
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [state.tenantA],
    );
    const pa2 = (await q(
      `INSERT INTO payment_advices (tenant_id, pa_number, party_id, kind, amount, issued_at, due_at)
       VALUES ($1, 'PA-SCHED-2', $2, 'PENALTY', 100, now() - interval '4 days', now() + interval '3 days') RETURNING id`,
      [state.tenantA, partyId],
    ))[0].id;
    await scheduler.runOnce();
    expect(await notes('PAYMENT_REMINDER', pa2)).toHaveLength(0);
    await q(`DELETE FROM tenant_settings WHERE key = 'scheduler'`);
    await q(`UPDATE payment_advices SET status = 'CANCELLED' WHERE id = $1`, [pa2]);
  });
});
