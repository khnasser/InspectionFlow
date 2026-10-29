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
import { signWebhook } from '../src/modules/payments/payments.controller';

const state = JSON.parse(readFileSync(join(tmpdir(), 'inspectionflow-test-db.json'), 'utf8'));
const WEBHOOK_SECRET = 'test-webhook-secret';
const DOMAIN = 'demoauth.inspectionflow.test';

let app: INestApplication;
let http: any;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};

const api = (who: string) => ({
  get: (url: string) => request(http).get(url).set('Authorization', `Bearer ${tokens[who]}`),
  post: (url: string, body?: object) =>
    request(http).post(url).set('Authorization', `Bearer ${tokens[who]}`).send(body ?? {}),
});

async function login(key: string, tenantCode = 'DEMO-AUTH', domain = DOMAIN) {
  const res = await request(http).post('/v1/dev/login').send({ tenantCode, email: `${key}@${domain}` }).expect(201);
  return res.body.accessToken as string;
}

const sha = 'a'.repeat(64);

function inspection(over: Record<string, unknown>) {
  return {
    id: uuidv7(),
    clientMutationId: uuidv7(),
    processCode: 'CONSTRUCTION_SAFETY',
    kind: 'SCHEDULED',
    completedAt: new Date().toISOString(),
    findings: [],
    ...over,
  };
}

async function inspectableId(who: string, identifier: string) {
  const res = await api(who).get(`/v1/inspectables?search=${identifier}`).expect(200);
  return res.body.find((i: any) => i.identifier === identifier).id as string;
}

async function approveAll(inspectionId: string, approvers: string[]) {
  let last: any;
  for (const who of approvers) {
    const pending = await api(who).get('/v1/reviews').expect(200);
    const step = pending.body.find((p: any) => p.inspection_id === inspectionId);
    expect(step).toBeDefined();
    last = (await api(who).post(`/v1/approvals/${step.approval_id}/decide`, { decision: 'APPROVED' }).expect(201)).body;
  }
  return last;
}

beforeAll(async () => {
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: state.appUrl,
    AUTH_MODE: 'dev',
    PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET,
    NODE_ENV: 'test',
  });
  app = await NestFactory.create(AppModule.register(config), { logger: false });
  await app.init();
  http = app.getHttpServer();
  for (const k of ['ahmed', 'omar', 'sara', 'khalid', 'admin']) tokens[k] = await login(k);
  tokens.otherAdmin = await login('admin', 'OTHER-AUTH', 'otherauth.inspectionflow.test');
});

afterAll(async () => {
  await app?.close();
});

describe('platform basics', () => {
  it('health is public; other routes need a token', async () => {
    await request(http).get('/health').expect(200);
    await request(http).get('/v1/me/tasks').expect(401);
    await request(http).get('/v1/me/tasks').set('Authorization', 'Bearer not-a-token').expect(401);
  });

  it('inspector sees the seeded scheduled tasks', async () => {
    const res = await api('ahmed').get('/v1/me/tasks').expect(200);
    expect(res.body.filter((t: any) => t.task_type === 'INSPECT')).toHaveLength(3);
  });

  it('serves the offline configuration bundle with engine rules', async () => {
    const res = await api('ahmed').get('/v1/config/bundle').expect(200);
    const safety = res.body.processes.find((p: any) => p.code === 'CONSTRUCTION_SAFETY');
    const cs01 = safety.violations.find((v: any) => v.code === 'CS-01');
    expect(cs01.rule.ladder).toHaveLength(3);
    expect(safety.checklists[0].sections[0].items).toHaveLength(4);
    expect(res.body.tenant.timeZone).toBe('Asia/Dubai');
  });

  it('managers cannot submit inspections (role check)', async () => {
    await api('khalid').post('/v1/inspections/submit', inspection({ inspectableId: uuidv7() })).expect(403);
  });
});

describe('inspection lifecycle on project P-1001', () => {
  it('first inspection: FIR findings are issued automatically with a 7-day follow-up', async () => {
    ids.p1 = await inspectableId('ahmed', 'P-1001');
    const tasks = (await api('ahmed').get('/v1/me/tasks').expect(200)).body;
    const task = tasks.find((t: any) => t.inspectable_id === ids.p1);
    const body = inspection({
      inspectableId: ids.p1,
      taskId: task.id,
      findings: [
        { id: uuidv7(), violationCode: 'CS-01', remarks: 'No guard rail on level 3' },
        { id: uuidv7(), violationCode: 'CS-03' },
      ],
      signature: { method: 'CANVAS', signerName: 'Site engineer', signedPayloadSha256: sha },
    });
    ids.firstBody = JSON.stringify(body);
    const res = await api('ahmed').post('/v1/inspections/submit', body).expect(201);
    expect(res.body).toMatchObject({ status: 'APPROVED', category: 'MINOR', totalFine: 0, review: 'NONE', replay: false });
    expect(res.body.findings.map((f: any) => f.actionCode).sort()).toEqual(['FIR', 'FIR']);
    ids.first = res.body.inspectionId;
    ids.log1 = res.body.logId;

    const after = (await api('ahmed').get('/v1/me/tasks').expect(200)).body;
    expect(after.find((t: any) => t.id === task.id)).toBeUndefined();
    const followUp = after.find((t: any) => t.log_id === ids.log1 && t.form_key === 'follow-up-inspection');
    expect(followUp).toBeDefined();
    ids.followUpTask = followUp.id;
  });

  it('a replayed submission returns the stored outcome (offline idempotency)', async () => {
    const res = await api('ahmed').post('/v1/inspections/submit', JSON.parse(ids.firstBody)).expect(201);
    expect(res.body.replay).toBe(true);
    expect(res.body.inspectionId).toBe(ids.first);
  });

  it('reusing an inspection id with another mutation id is a conflict', async () => {
    const reused = { ...JSON.parse(ids.firstBody), clientMutationId: uuidv7() };
    await api('ahmed').post('/v1/inspections/submit', reused).expect(409);
  });

  it('only seniors or managers can clear a signature; clearing unlocks editing', async () => {
    await api('ahmed').post(`/v1/inspections/${ids.first}/signature/clear`, { reason: 'Signed by wrong person' }).expect(403);
    await api('sara').post(`/v1/inspections/${ids.first}/signature/clear`, { reason: 'Signed by wrong person' }).expect(201);
    const d = await api('sara').get(`/v1/inspections/${ids.first}`).expect(200);
    expect(d.body.edit_locked).toBe(false);
    expect(d.body.signature.clear_reason).toBe('Signed by wrong person');
  });

  it('follow-up: resolved finding closes, unresolved one is carried forward, new PPE finding needs manager review', async () => {
    const detail = (await api('ahmed').get(`/v1/inspectables/${ids.p1}`).expect(200)).body;
    const cs03 = detail.openFindings.find((f: any) => f.code === 'CS-03');
    const res = await api('ahmed')
      .post(
        '/v1/inspections/submit',
        inspection({
          inspectableId: ids.p1,
          kind: 'FOLLOW_UP',
          taskId: ids.followUpTask,
          resolvedFindingIds: [cs03.id],
          findings: [
            { id: uuidv7(), violationCode: 'CS-01' },
            { id: uuidv7(), violationCode: 'CS-02', partyIds: [] },
          ],
        }),
      )
      .expect(201);
    expect(res.body.status).toBe('UNDER_REVIEW');
    expect(res.body.cycleNumber).toBe(2);
    expect(res.body.logId).toBe(ids.log1);
    const cs01 = res.body.findings.find((f: any) => f.violationCode === 'CS-01');
    const cs02 = res.body.findings.find((f: any) => f.violationCode === 'CS-02');
    expect(cs01).toMatchObject({ carriedForward: true, occurrence: 1 });
    expect(cs02).toMatchObject({ occurrence: 1, actionCode: 'PENALTY', fine: 1000, severity: 'MAJOR' });
    expect(res.body.approvalChain).toEqual(['SECTION_MANAGER']);
    ids.second = res.body.inspectionId;
  });

  it('inspectors cannot approve; the section manager approves and a payment advice is issued', async () => {
    await api('ahmed').get('/v1/reviews').expect(403);
    const final = await approveAll(ids.second, ['sara']);
    expect(final.status).toBe('APPROVED');
    expect(final.paymentAdvice.amount).toBe(1000);
    ids.pa = final.paymentAdvice.id;
  });

  it('payment webhook: bad signature rejected, capture marks PAID, duplicates ignored', async () => {
    const payload = {
      tenantId: state.tenantA,
      paymentAdviceId: ids.pa,
      gateway: 'MOCK',
      gatewayTxnId: 'txn-001',
      amount: 1000,
      currency: 'AED',
      status: 'CAPTURED',
    };
    await request(http).post('/v1/webhooks/payments').set('x-signature', 'f'.repeat(64)).send(payload).expect(401);
    const sig = signWebhook(WEBHOOK_SECRET, payload);
    const ok = await request(http).post('/v1/webhooks/payments').set('x-signature', sig).send(payload).expect(201);
    expect(ok.body.status).toBe('PAID');
    const dup = await request(http).post('/v1/webhooks/payments').set('x-signature', sig).send(payload).expect(201);
    expect(dup.body.status).toBe('DUPLICATE_IGNORED');
    const pa = await api('sara').get(`/v1/payment-advices/${ids.pa}`).expect(200);
    expect(pa.body.status).toBe('PAID');
  });

  it('renders the Arabic RTL report', async () => {
    const res = await api('sara').get(`/v1/inspections/${ids.second}/report.html`).expect(200);
    expect(res.text).toContain('dir="rtl"');
    expect(res.text).toContain('تقرير التفتيش');
    expect(res.text).toContain('CS-02');
  });
});

describe('repeat violations escalate to committee on project P-1002', () => {
  it('third PPE occurrence in the year doubles twice (PRD multiplier) and goes to manager + committee', async () => {
    ids.p2 = await inspectableId('ahmed', 'P-1002');
    const expected = [
      { fine: 1000, action: 'PENALTY', chain: ['SECTION_MANAGER'], approvers: ['sara'] },
      { fine: 2000, action: 'PENALTY', chain: ['SECTION_MANAGER'], approvers: ['sara'] },
      { fine: 4000, action: 'DOUBLE_PENALTY', chain: ['SECTION_MANAGER', 'COMMITTEE'], approvers: ['sara', 'khalid'] },
    ];
    let previousFindingId: string | null = null;
    for (const [i, e] of expected.entries()) {
      const res: request.Response = await api('ahmed')
        .post(
          '/v1/inspections/submit',
          inspection({
            inspectableId: ids.p2,
            kind: i === 0 ? 'SCHEDULED' : 'FOLLOW_UP',
            resolvedFindingIds: previousFindingId ? [previousFindingId] : [],
            findings: [{ id: uuidv7(), violationCode: 'CS-02' }],
          }),
        )
        .expect(201);
      const f: { id: string; occurrence: number; fine: number; actionCode: string } = res.body.findings[0];
      expect(f.occurrence).toBe(i + 1);
      expect(f.fine).toBe(e.fine);
      expect(f.actionCode).toBe(e.action);
      expect(res.body.approvalChain).toEqual(e.chain);
      if (i === 2) {
        // Committee cannot act before the manager step
        const early = await api('khalid').get('/v1/reviews').expect(200);
        expect(early.body.find((p: any) => p.inspection_id === res.body.inspectionId)).toBeUndefined();
      }
      const final = await approveAll(res.body.inspectionId, e.approvers);
      expect(final.status).toBe('APPROVED');
      expect(final.paymentAdvice.amount).toBe(e.fine);
      previousFindingId = f.id;
    }
  });
});

describe('more information, rejection and severity override on villa V-2201', () => {
  it('manager asks for more info; inspector responds; manager rejects -> not counted', async () => {
    ids.v1 = await inspectableId('ahmed', 'V-2201');
    const res = await api('ahmed')
      .post(
        '/v1/inspections/submit',
        inspection({
          processCode: 'COMMUNITY_COMPLIANCE',
          inspectableId: ids.v1,
          findings: [{ id: uuidv7(), violationCode: 'OC', parameters: { OCCUPANTS: 9 } }],
        }),
      )
      .expect(201);
    expect(res.body.findings[0]).toMatchObject({ actionCode: 'WARNING', occurrence: 1 });
    const id = res.body.inspectionId;

    const step = (await api('sara').get('/v1/reviews').expect(200)).body.find((p: any) => p.inspection_id === id);
    await api('sara').post(`/v1/approvals/${step.approval_id}/decide`, { decision: 'MORE_INFO', comment: 'Attach tenancy contract' }).expect(201);
    const tasks = (await api('ahmed').get('/v1/me/tasks').expect(200)).body;
    expect(tasks.find((t: any) => t.inspection_id === id && t.task_type === 'MORE_INFO')).toBeDefined();

    await api('omar').post(`/v1/inspections/${id}/respond`, { remarks: 'Contract shows 4 occupants' }).expect(403);
    const resp = await api('ahmed').post(`/v1/inspections/${id}/respond`, { remarks: 'Contract shows 4 occupants' }).expect(201);
    expect(resp.body.status).toBe('UNDER_REVIEW');

    const again = (await api('sara').get('/v1/reviews').expect(200)).body.find((p: any) => p.inspection_id === id);
    const rejected = await api('sara').post(`/v1/approvals/${again.approval_id}/decide`, { decision: 'REJECTED' }).expect(201);
    expect(rejected.body.status).toBe('REJECTED');
  });

  it('after the rejection the next OC is still occurrence 1; a demotion override is approved', async () => {
    const findingId = uuidv7();
    const res = await api('ahmed')
      .post(
        '/v1/inspections/submit',
        inspection({
          processCode: 'COMMUNITY_COMPLIANCE',
          inspectableId: ids.v1,
          findings: [{ id: findingId, violationCode: 'OC', override: { severity: 'MINOR', reason: 'Family of the owner, temporary stay' } }],
        }),
      )
      .expect(201);
    expect(res.body.findings[0]).toMatchObject({ occurrence: 1, severity: 'MINOR', overrideStatus: 'PENDING' });
    const final = await approveAll(res.body.inspectionId, ['sara']);
    expect(final.findings[0]).toMatchObject({ overrideStatus: 'APPROVED', severity: 'MINOR' });

    // The demoted finding no longer counts: evaluating another OC gives occurrence 1 again.
    const ev = await api('ahmed')
      .post('/v1/engine/evaluate', { processCode: 'COMMUNITY_COMPLIANCE', inspectableId: ids.v1, findings: [{ violationCode: 'OC' }] })
      .expect(201);
    expect(ev.body.findings[0].occurrence).toBe(1);
  });
});

describe('delegation and team management', () => {
  it('Ahmed delegates to Omar; Omar sees Ahmed\'s tasks and new tasks go to Omar', async () => {
    const me = (await api('ahmed').get('/v1/me').expect(200)).body;
    const users = (await api('ahmed').get('/v1/users?role=INSPECTOR').expect(200)).body;
    const omar = users.find((u: any) => u.display_name === 'Omar Haddad');
    const start = new Date(Date.now() - 60_000).toISOString();
    const end = new Date(Date.now() + 86_400_000).toISOString();
    await api('ahmed').post('/v1/delegations', { delegateId: omar.id, startsAt: start, endsAt: end, reason: 'Annual leave' }).expect(201);
    await api('ahmed').post('/v1/delegations', { delegateId: omar.id, startsAt: start, endsAt: end }).expect(400);

    const omarTasks = (await api('omar').get('/v1/me/tasks?includeDelegated=true').expect(200)).body;
    expect(omarTasks.some((t: any) => t.via_delegation && t.assignee_id === me.userId)).toBe(true);
    const withoutDelegated = (await api('omar').get('/v1/me/tasks').expect(200)).body;
    expect(withoutDelegated.some((t: any) => t.assignee_id === me.userId)).toBe(false);

    // A site registered today: a first-time FIR is auto-issued and its follow-up task for Ahmed is routed to Omar
    const site = await api('ahmed')
      .post('/v1/inspectables', { typeCode: 'BUILDING_PROJECT', identifier: 'P-1003', name: 'Cold store foundation works' })
      .expect(201);
    const res = await api('ahmed')
      .post('/v1/inspections/submit', inspection({ inspectableId: site.body.id, kind: 'RANDOM', findings: [{ id: uuidv7(), violationCode: 'CS-01' }] }))
      .expect(201);
    expect(res.body.status).toBe('APPROVED');
    const after = (await api('omar').get('/v1/me/tasks').expect(200)).body;
    const routed = after.find((t: any) => t.log_id === res.body.logId && t.task_type === 'INSPECT');
    expect(routed.original_assignee_id).toBe(me.userId);
  });

  it('manager dashboard and bulk reassignment', async () => {
    const dash = (await api('sara').get('/v1/team/dashboard').expect(200)).body;
    expect(dash.map((d: any) => d.display_name).sort()).toEqual(['Ahmed Al Mansoori', 'Omar Haddad']);
    expect(dash.find((d: any) => d.display_name === 'Ahmed Al Mansoori').delegated_to).toBe('Omar Haddad');
    const omarTasks = (await api('omar').get('/v1/me/tasks').expect(200)).body;
    const ahmed = (await api('ahmed').get('/v1/me').expect(200)).body;
    await api('ahmed').post('/v1/tasks/bulk-reassign', { taskIds: [omarTasks[0].id], userId: ahmed.userId }).expect(403);
    const r = await api('sara').post('/v1/tasks/bulk-reassign', { taskIds: omarTasks.map((t: any) => t.id), userId: ahmed.userId }).expect(201);
    expect(r.body.reassigned).toBe(omarTasks.length);
  });
});

describe('offline sync', () => {
  it('push applies valid mutations, rejects invalid ones, and is idempotent on retry', async () => {
    const deviceId = uuidv7();
    const good = inspection({ inspectableId: ids.p2, kind: 'RANDOM', findings: [] });
    const bad = inspection({ inspectableId: ids.p2, processCode: 'NO_SUCH_PROCESS' });
    const batch = {
      batchId: uuidv7(),
      deviceId,
      platform: 'ANDROID',
      mutations: [
        { clientMutationId: good.clientMutationId, type: 'inspection.submit', payload: good },
        { clientMutationId: bad.clientMutationId, type: 'inspection.submit', payload: bad },
      ],
    };
    const first = await api('ahmed').post('/v1/sync/push', batch).expect(201);
    expect(first.body.results.map((r: any) => r.status)).toEqual(['APPLIED', 'REJECTED']);
    expect(first.body.results[1].error.status).toBe(404);
    const retry = await api('ahmed').post('/v1/sync/push', batch).expect(201);
    expect(retry.body.results.map((r: any) => r.status)).toEqual(['REPLAYED', 'REJECTED']);
  });

  it('pull returns tasks, inspectables with parties and occurrence history for offline evaluation', async () => {
    const res = await api('ahmed').get('/v1/sync/pull').expect(200);
    expect(res.body.tasks.length).toBeGreaterThan(0);
    expect(res.body.inspectables[0].parties.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.occurrences)).toBe(true);
  });
});

describe('tenant isolation and audit', () => {
  it('another tenant cannot read this tenant\'s data', async () => {
    await api('otherAdmin').get(`/v1/inspections/${ids.second}`).expect(404);
    await api('otherAdmin').get(`/v1/inspectables/${ids.p1}`).expect(404);
    const list = (await api('otherAdmin').get('/v1/inspectables').expect(200)).body;
    expect(list.map((i: any) => i.id)).not.toContain(ids.p1);
    const pas = (await api('otherAdmin').get('/v1/payment-advices').expect(200)).body;
    expect(pas).toHaveLength(0);
  });

  it('the API database role sees nothing without a tenant context and cannot rewrite audit', async () => {
    const c = new Client({ connectionString: state.appUrl });
    await c.connect();
    try {
      expect((await c.query('SELECT count(*)::int AS n FROM inspections')).rows[0].n).toBe(0);
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [state.tenantA]);
      expect((await c.query('SELECT count(*)::int AS n FROM inspections')).rows[0].n).toBeGreaterThan(0);
      await expect(c.query("UPDATE audit_logs SET action = 'tampered'")).rejects.toThrow(/permission denied/);
      await expect(
        c.query(`INSERT INTO parties (tenant_id, type, company_name) VALUES ($1,'COMPANY','x')`, [state.tenantB]),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await c.end();
    }
  });

  it('audit hash chain verifies, and detects tampering by a privileged user', async () => {
    const ok = await api('admin').get('/v1/audit/verify').expect(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.rows).toBeGreaterThan(10);
    const c = new Client({ connectionString: state.adminUrl });
    await c.connect();
    await c.query(
      `UPDATE audit_logs SET action = 'tampered'
        WHERE id = (SELECT id FROM audit_logs WHERE tenant_id = $1 ORDER BY seq LIMIT 1 OFFSET 3)`,
      [state.tenantA],
    );
    await c.end();
    const bad = await api('admin').get('/v1/audit/verify').expect(200);
    expect(bad.body.ok).toBe(false);
  });
});
