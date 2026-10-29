import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from 'pg';
import request from 'supertest';
import { uuidv7 } from '@inspectionflow/engine';
import { AppModule } from '../src/app.module';
import { loadConfig } from '../src/common/config';
import { CaptureEmail, CaptureSms, EMAIL_SENDER, SMS_SENDER } from '../src/modules/notifications/channels';
import { normalisePhone, quietHoursDelay } from '../src/modules/notifications/notifications.service';
import { isPrivateAddress, OutboxRelayService } from '../src/modules/notifications/outbox-relay.service';

const state = JSON.parse(readFileSync(join(tmpdir(), 'inspectionflow-test-db.json'), 'utf8'));
const DOMAIN = 'demoauth.inspectionflow.test';

let app: INestApplication;
let http: any;
let email: CaptureEmail;
let sms: CaptureSms;
let db: Client;
const tokens: Record<string, string> = {};
const api = (who: string) => ({
  get: (url: string) => request(http).get(url).set('Authorization', `Bearer ${tokens[who]}`),
  post: (url: string, b?: object) => request(http).post(url).set('Authorization', `Bearer ${tokens[who]}`).send(b ?? {}),
  put: (url: string, b?: object) => request(http).put(url).set('Authorization', `Bearer ${tokens[who]}`).send(b ?? {}),
  delete: (url: string) => request(http).delete(url).set('Authorization', `Bearer ${tokens[who]}`),
});
const runJobs = async () => (await api('admin').post('/v1/admin/jobs/run').expect(201)).body;

// Webhook receiver: two endpoints, one healthy and one failing.
let receiver: Server;
let base = '';
const received: Array<{ path: string; headers: any; body: string }> = [];
let failingStatus = 500;

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ path: req.url!, headers: req.headers, body });
      res.statusCode = req.url === '/fail' ? failingStatus : 204;
      res.end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

  const config = loadConfig({
    ...process.env,
    DATABASE_URL: state.appUrl,
    AUTH_MODE: 'dev',
    NODE_ENV: 'test',
    REPORT_WORKER: 'off',
    STORAGE_LOCAL_DIR: join(tmpdir(), 'inspectionflow-test-storage'),
    WEBHOOK_ALLOW_PRIVATE: 'true',
    PUBLIC_BASE_URL: 'https://inspect.example.test',
  });
  app = await NestFactory.create(AppModule.register(config), { logger: false });
  await app.init();
  http = app.getHttpServer();
  email = app.get(EMAIL_SENDER);
  sms = app.get(SMS_SENDER);
  for (const k of ['ahmed', 'sara', 'admin']) {
    tokens[k] = (await request(http).post('/v1/dev/login').send({ tenantCode: 'DEMO-AUTH', email: `${k}@${DOMAIN}` }).expect(201)).body.accessToken;
  }
  db = new Client({ connectionString: state.adminUrl });
  await db.connect();
});

afterAll(async () => {
  await db?.query(`DELETE FROM tenant_settings WHERE key = 'notifications.quietHours'`);
  await db?.end();
  await app?.close();
  await new Promise((r) => receiver.close(r));
});

describe('helpers', () => {
  it('normalises UAE phone numbers and refuses junk', () => {
    expect(normalisePhone('050 123 4567')).toBe('+971501234567');
    expect(normalisePhone('00971501234567')).toBe('+971501234567');
    expect(normalisePhone('+97140000000')).toBe('+97140000000');
    expect(normalisePhone('call me')).toBeNull();
  });

  it('computes quiet hours across midnight in the tenant time zone', () => {
    const at = (iso: string) => quietHoursDelay(new Date(iso), 'Asia/Dubai', { start: '22:00', end: '07:00' });
    expect(at('2026-11-01T19:30:00Z')).toBe(60 * 60_000 * 7.5); // 23:30 Dubai -> 7.5 h until 07:00
    expect(at('2026-11-01T02:00:00Z')).toBe(60 * 60_000); // 06:00 Dubai -> one hour
    expect(at('2026-11-01T08:00:00Z')).toBe(0); // 12:00 Dubai
  });

  it('treats internal addresses as private, including cloud metadata', async () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.20.0.1', '192.168.1.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    const strict = new OutboxRelayService(null as any, loadConfig({ ...process.env, WEBHOOK_ALLOW_PRIVATE: 'false' }));
    await expect(strict.assertPublicUrl('https://169.254.169.254/latest/meta-data')).rejects.toThrow(/private/);
    await expect(strict.assertPublicUrl('http://example.com/hook')).rejects.toThrow(/https/);
    await expect(strict.assertPublicUrl('ftp://example.com')).rejects.toThrow();
  });
});

describe('notification delivery', () => {
  let inspectionId = '';

  it('approval queues the payment advice and letter; email goes now, SMS waits for quiet hours, the letter carries the PDF', async () => {
    // A site whose owner has an email and a local mobile number.
    const party = (await api('ahmed').post('/v1/parties', { type: 'COMPANY', companyName: 'Notify Test LLC', email: 'owner@notify.test', phone: '050 123 4567' }).expect(201)).body;
    const site = (await api('ahmed').post('/v1/inspectables', { typeCode: 'BUILDING_PROJECT', identifier: 'P-3001', name: 'Notify test site' }).expect(201)).body;
    await api('ahmed').post(`/v1/inspectables/${site.id}/parties`, { partyId: party.id, role: 'OWNER', isPrimary: true }).expect(201);

    inspectionId = uuidv7();
    const sub = await api('ahmed')
      .post('/v1/inspections/submit', {
        id: inspectionId, clientMutationId: uuidv7(), processCode: 'CONSTRUCTION_SAFETY', inspectableId: site.id, kind: 'RANDOM',
        completedAt: new Date().toISOString(), findings: [{ id: uuidv7(), violationCode: 'CS-02' }],
      })
      .expect(201);
    expect(sub.body.status).toBe('UNDER_REVIEW');

    // Quiet hours that always cover "now" in Dubai.
    const nowDubai = new Date(Date.now() + 4 * 3600_000);
    const hhmm = (d: Date) => d.toISOString().slice(11, 16);
    await db.query(
      `INSERT INTO tenant_settings (tenant_id, key, value) VALUES ($1, 'notifications.quietHours', $2)
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [state.tenantA, JSON.stringify({ start: hhmm(new Date(nowDubai.getTime() - 3600_000)), end: hhmm(new Date(nowDubai.getTime() + 3600_000)) })],
    );

    const pending = (await api('sara').get('/v1/reviews').expect(200)).body.find((p: any) => p.inspection_id === inspectionId);
    await api('sara').post(`/v1/approvals/${pending.approval_id}/decide`, { decision: 'APPROVED' }).expect(201);
    // Keep the follow-up task out of other suites' counts.
    await db.query(`UPDATE tasks SET status = 'CANCELLED' WHERE log_id = $1`, [sub.body.logId]);

    const before = email.sent.length;
    await runJobs();
    const mine = email.sent.slice(before).filter((m) => m.to === 'owner@notify.test');
    const advice = mine.find((m) => m.subject.startsWith('إشعار دفع'));
    expect(advice).toBeDefined();
    expect(advice!.text).toMatch(/بمبلغ [\d,]+\.\d{2} درهم/);
    expect(advice!.text).toMatch(/https:\/\/inspect\.example\.test\/pay\/[0-9a-f-]+\?t=[0-9a-f]{32}/);
    expect(advice!.html).toContain('dir="rtl"');

    const letter = mine.find((m) => m.attachments?.length);
    expect(letter).toBeDefined();
    expect(letter!.attachments![0].contentType).toBe('application/pdf');
    expect(letter!.attachments![0].content.subarray(0, 4).toString()).toBe('%PDF');
    expect(letter!.text).toMatch(/\/verify\/[0-9A-Z]{16}/);
    expect(letter!.text).toContain('CS-02');

    const smsRow = (await db.query(`SELECT status, last_error, scheduled_for FROM notifications WHERE channel = 'SMS' AND entity_id = (SELECT id FROM payment_advices WHERE inspection_id = $1)`, [inspectionId])).rows[0];
    expect(smsRow.status).toBe('QUEUED');
    expect(smsRow.last_error).toMatch(/quiet hours/);
    expect(new Date(smsRow.scheduled_for).getTime()).toBeGreaterThan(Date.now());
  });

  it('sends the SMS once quiet hours are over, with the pay link', async () => {
    await db.query(`DELETE FROM tenant_settings WHERE key = 'notifications.quietHours'`);
    await db.query(`UPDATE notifications SET scheduled_for = now() WHERE channel = 'SMS' AND status = 'QUEUED'`);
    const before = sms.sent.length;
    await runJobs();
    const m = sms.sent.slice(before).find((x) => x.to === '+971501234567');
    expect(m).toBeDefined();
    expect(m!.text).toMatch(/^إشعار دفع PA-/);
    expect(m!.text).toContain('/pay/');
  });

  it('uses a tenant template override', async () => {
    await api('admin')
      .put('/v1/admin/notification-templates', { code: 'PAYMENT_ADVICE_ISSUED', channel: 'SMS', locale: 'ar-AE', body: 'مخصص {{number}} — {{amount}}' })
      .expect(200);
    const list = (await api('admin').get('/v1/admin/notification-templates').expect(200)).body;
    expect(list.find((t: any) => t.code === 'PAYMENT_ADVICE_ISSUED' && t.channel === 'SMS' && t.locale === 'ar-AE')).toMatchObject({ customised: true });
    const pa = (await db.query(`SELECT id FROM payment_advices WHERE inspection_id = $1`, [inspectionId])).rows[0];
    await db.query(
      `INSERT INTO notifications (tenant_id, recipient_type, recipient_address, channel, template_code, payload, entity_type, entity_id)
       VALUES ($1,'EMAIL','0509998877','SMS','PAYMENT_ADVICE_ISSUED','{}','PAYMENT_ADVICE',$2)`,
      [state.tenantA, pa.id],
    );
    const before = sms.sent.length;
    await runJobs();
    expect(sms.sent.slice(before).find((x) => x.to === '+971509998877')!.text).toMatch(/^مخصص PA-.+ — [\d,]+\.\d{2}$/);
    await db.query(`DELETE FROM notification_templates WHERE code = 'PAYMENT_ADVICE_ISSUED'`);
  });

  it('retries a temporary email failure with backoff, then sends', async () => {
    const id = (await db.query(
      `INSERT INTO notifications (tenant_id, recipient_type, recipient_address, channel, template_code, payload)
       VALUES ($1,'EMAIL','retry@notify.test','EMAIL','PAYMENT_ADVICE_ISSUED','{"number":"X-1","amount":"1.00","dueDate":"-"}') RETURNING id`,
      [state.tenantA],
    )).rows[0].id;
    email.failNext = 1;
    await runJobs();
    let row = (await db.query(`SELECT status, attempts, last_error, scheduled_for FROM notifications WHERE id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ status: 'QUEUED', attempts: 1 });
    expect(row.last_error).toMatch(/451/);
    expect(new Date(row.scheduled_for).getTime()).toBeGreaterThan(Date.now());
    await db.query(`UPDATE notifications SET scheduled_for = now() WHERE id = $1`, [id]);
    await runJobs();
    row = (await db.query(`SELECT status, attempts, delivered_to FROM notifications WHERE id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ status: 'SENT', attempts: 2, delivered_to: 'retry@notify.test' });
  });

  it('skips a recipient with no contact details and says why; the admin monitor masks addresses', async () => {
    const party = (await api('ahmed').post('/v1/parties', { type: 'COMPANY', companyName: 'No Contact LLC' }).expect(201)).body;
    const id = (await db.query(
      `INSERT INTO notifications (tenant_id, recipient_type, recipient_id, channel, template_code, payload)
       VALUES ($1,'PARTY',$2,'EMAIL','PAYMENT_ADVICE_ISSUED','{}') RETURNING id`,
      [state.tenantA, party.id],
    )).rows[0].id;
    await runJobs();
    const row = (await db.query(`SELECT status, last_error FROM notifications WHERE id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ status: 'SKIPPED', last_error: 'No email contact for recipient' });
    const monitor = (await api('admin').get('/v1/admin/notifications?status=SENT').expect(200)).body;
    expect(monitor.find((m: any) => m.delivered_to?.startsWith('o***@notify.test'))).toBeDefined();
    await api('ahmed').get('/v1/admin/notifications').expect(403);
  });

  it('keeps in-app notifications per user and marks them read', async () => {
    const site = (await api('ahmed').post('/v1/inspectables', { typeCode: 'BUILDING_PROJECT', identifier: 'P-3002', name: 'Inbox test site' }).expect(201)).body;
    const res = await api('ahmed')
      .post('/v1/inspections/submit', {
        id: uuidv7(), clientMutationId: uuidv7(), processCode: 'CONSTRUCTION_SAFETY', inspectableId: site.id, kind: 'RANDOM',
        completedAt: new Date().toISOString(), findings: [{ id: uuidv7(), violationCode: 'CS-01' }],
      })
      .expect(201);
    await db.query(`UPDATE tasks SET status = 'CANCELLED' WHERE log_id = $1`, [res.body.logId]);
    await runJobs();
    const inbox = (await api('ahmed').get('/v1/me/notifications').expect(200)).body;
    const n = inbox.find((x: any) => x.template_code === 'TASK_ASSIGNED' && x.payload.siteName === 'Inbox test site');
    expect(n).toMatchObject({ status: 'SENT' });
    await api('sara').post(`/v1/me/notifications/${n.id}/read`).expect(404); // not hers
    await api('ahmed').post(`/v1/me/notifications/${n.id}/read`).expect(200);
    expect((await api('ahmed').get('/v1/me/notifications').expect(200)).body.find((x: any) => x.id === n.id).status).toBe('READ');
  });
});

describe('outbox relay (signed webhooks)', () => {
  it('delivers matching events with a verifiable signature and retries only the failing endpoint', async () => {
    const ok = (await api('admin').post('/v1/admin/webhooks', { name: 'CRM', url: `${base}/ok`, eventTypes: ['party.created'] }).expect(201)).body;
    expect(ok.secret).toMatch(/^whsec_/);
    const bad = (await api('admin').post('/v1/admin/webhooks', { name: 'ERP', url: `${base}/fail`, eventTypes: ['party.created'] }).expect(201)).body;
    expect((await api('admin').get('/v1/admin/webhooks').expect(200)).body.some((w: any) => 'secret' in w)).toBe(false);

    const party = (await api('ahmed').post('/v1/parties', { type: 'COMPANY', companyName: 'Webhook Co', email: 'hook@notify.test' }).expect(201)).body;
    received.length = 0;
    await runJobs();

    const okCalls = received.filter((r) => r.path === '/ok' && JSON.parse(r.body).subject.id === party.id);
    expect(okCalls).toHaveLength(1);
    const call = okCalls[0];
    const event = JSON.parse(call.body);
    expect(event).toMatchObject({ type: 'party.created', subject: { type: 'PARTY', id: party.id }, data: { email: 'hook@notify.test' } });
    expect(call.headers['x-inspectionflow-event']).toBe('party.created');
    const [t, v1] = String(call.headers['x-inspectionflow-signature']).split(',').map((p) => p.split('=')[1]);
    expect(v1).toBe(createHmac('sha256', ok.secret).update(`${t}.${call.body}`).digest('hex'));

    const outbox = (await db.query(`SELECT id, status, attempts, last_error FROM outbox WHERE aggregate_id = $1`, [party.id])).rows[0];
    expect(outbox).toMatchObject({ status: 'FAILED', last_error: 'HTTP 500' });
    const deliveries = (await api('admin').get(`/v1/admin/webhooks/${bad.id}/deliveries`).expect(200)).body;
    expect(deliveries[0]).toMatchObject({ event_type: 'party.created', status: 'FAILED', http_status: 500 });

    // The ERP recovers: the retry goes only to it, the CRM is not called twice.
    failingStatus = 200;
    await db.query(`UPDATE outbox SET next_attempt_at = now() WHERE id = $1`, [outbox.id]);
    received.length = 0;
    await runJobs();
    expect(received.filter((r) => JSON.parse(r.body).id === outbox.id).map((r) => r.path)).toEqual(['/fail']);
    expect((await db.query(`SELECT status FROM outbox WHERE id = $1`, [outbox.id])).rows[0].status).toBe('PUBLISHED');

    await api('admin').delete(`/v1/admin/webhooks/${ok.id}`).expect(200);
    await api('admin').delete(`/v1/admin/webhooks/${bad.id}`).expect(200);
    await api('ahmed').post('/v1/admin/webhooks', { name: 'x', url: `${base}/ok` }).expect(403);
  });
});
