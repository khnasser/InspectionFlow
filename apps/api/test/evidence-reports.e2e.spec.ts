import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from 'pg';
import request from 'supertest';
import { uuidv7 } from '@inspectionflow/engine';
import { AppModule } from '../src/app.module';
import { loadConfig } from '../src/common/config';

const state = JSON.parse(readFileSync(join(tmpdir(), 'inspectionflow-test-db.json'), 'utf8'));
const DOMAIN = 'demoauth.inspectionflow.test';
const BASE = 'http://evidence.test';

let app: INestApplication;
let http: any;
const tokens: Record<string, string> = {};

const api = (who: string) => ({
  get: (url: string) => request(http).get(url).set('Authorization', `Bearer ${tokens[who]}`),
  post: (url: string, body?: object) => request(http).post(url).set('Authorization', `Bearer ${tokens[who]}`).send(body ?? {}),
});
const path = (url: string) => url.replace(BASE, '');

// A real 2x2 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
  'base64',
);
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function upload(over: Record<string, unknown> = {}) {
  return {
    id: uuidv7(),
    ownerType: 'FINDING',
    ownerId: uuidv7(),
    mimeType: 'image/png',
    fileName: 'edge.png',
    sizeBytes: PNG.length,
    sha256: sha256(PNG),
    capturedAt: new Date().toISOString(),
    latitude: 25.01,
    longitude: 55.09,
    ...over,
  };
}

beforeAll(async () => {
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: state.appUrl,
    AUTH_MODE: 'dev',
    NODE_ENV: 'test',
    REPORT_WORKER: 'off',
    PUBLIC_BASE_URL: BASE,
    VERIFY_BASE_URL: 'https://verify.inspectionflow.test',
    STORAGE_LOCAL_DIR: join(tmpdir(), 'inspectionflow-test-storage'),
  });
  app = await NestFactory.create(AppModule.register(config), { logger: false });
  await app.init();
  http = app.getHttpServer();
  for (const [k, tenant, domain] of [
    ['ahmed', 'DEMO-AUTH', DOMAIN],
    ['omar', 'DEMO-AUTH', DOMAIN],
    ['admin', 'DEMO-AUTH', DOMAIN],
    ['otherAdmin', 'OTHER-AUTH', 'otherauth.inspectionflow.test'],
  ]) {
    const email = `${k === 'otherAdmin' ? 'admin' : k}@${domain}`;
    tokens[k] = (await request(http).post('/v1/dev/login').send({ tenantCode: tenant, email }).expect(201)).body.accessToken;
  }
});

afterAll(async () => {
  await app?.close();
});

describe('photo evidence (offline-first upload)', () => {
  const findingId = uuidv7();
  const inspectionId = uuidv7();
  const photo = upload({ ownerId: findingId });
  const sitePhoto = upload({ ownerType: 'INSPECTION', ownerId: inspectionId, fileName: 'site.png' });
  let reportCode = '';
  let pdfSha = '';

  it('uploads a photo before the inspection reaches the server, with size + SHA-256 enforced', async () => {
    const init = (await api('ahmed').post('/v1/documents', photo).expect(201)).body;
    expect(init.status).toBe('PENDING');
    expect(init.upload.method).toBe('PUT');

    // Completing before the bytes arrive is refused.
    await api('ahmed').post(`/v1/documents/${photo.id}/complete`).expect(409);

    // Tampered body: rejected by the storage URL itself.
    const bad = Buffer.from(PNG);
    bad[bad.length - 1] ^= 0xff;
    await request(http).put(path(init.upload.url)).set(init.upload.headers).send(bad).expect(400);

    await request(http).put(path(init.upload.url)).set(init.upload.headers).send(PNG).expect(200);

    // Another inspector cannot complete Ahmed's upload.
    await api('omar').post(`/v1/documents/${photo.id}/complete`).expect(403);
    expect((await api('ahmed').post(`/v1/documents/${photo.id}/complete`).expect(200)).body.status).toBe('AVAILABLE');

    // Device retries are idempotent; reusing the id for other bytes is a conflict.
    expect((await api('ahmed').post('/v1/documents', photo).expect(201)).body).toMatchObject({ status: 'AVAILABLE', upload: null });
    await api('ahmed').post('/v1/documents', { ...photo, sha256: 'b'.repeat(64) }).expect(409);
  });

  it('rejects unsupported types, oversize files and forged storage URLs', async () => {
    await api('ahmed').post('/v1/documents', upload({ mimeType: 'application/x-msdownload' })).expect(400);
    await api('ahmed').post('/v1/documents', upload({ sizeBytes: 500 * 1024 * 1024 })).expect(400);
    await request(http).put('/v1/storage/local/eyJrIjoidC94In0.forged').set('Content-Type', 'image/png').send(PNG).expect(403);
    // Managers do not upload evidence.
    await api('admin').post('/v1/documents', upload()).expect(403);
  });

  it('links evidence to the submitted finding and serves it with short-lived URLs', async () => {
    const init = (await api('ahmed').post('/v1/documents', sitePhoto).expect(201)).body;
    await request(http).put(path(init.upload.url)).set(init.upload.headers).send(PNG).expect(200);
    await api('ahmed').post(`/v1/documents/${sitePhoto.id}/complete`).expect(200);

    const site = await api('ahmed')
      .post('/v1/inspectables', { typeCode: 'BUILDING_PROJECT', identifier: 'P-2001', name: 'Evidence test site' })
      .expect(201);
    const res = await api('ahmed')
      .post('/v1/inspections/submit', {
        id: inspectionId,
        clientMutationId: uuidv7(),
        processCode: 'CONSTRUCTION_SAFETY',
        inspectableId: site.body.id,
        kind: 'RANDOM',
        completedAt: new Date().toISOString(),
        findings: [{ id: findingId, violationCode: 'CS-01' }],
      })
      .expect(201);
    expect(res.body.status).toBe('APPROVED');
    // Suites share one database: cancel this site's follow-up task so other suites' task counts stay stable.
    const db = new Client({ connectionString: state.adminUrl });
    await db.connect();
    await db.query(`UPDATE tasks SET status = 'CANCELLED' WHERE log_id = $1`, [res.body.logId]);
    await db.end();

    const detail = (await api('admin').get(`/v1/inspections/${inspectionId}`).expect(200)).body;
    expect(detail.evidence).toHaveLength(2);
    const ev = detail.evidence.find((e: any) => e.id === photo.id);
    expect(ev).toMatchObject({ ownerType: 'FINDING', ownerId: findingId, status: 'AVAILABLE', sha256: photo.sha256 });
    const bytes = await request(http).get(path(ev.url)).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(bytes.status).toBe(200);
    expect(sha256(bytes.body)).toBe(photo.sha256);

    // The upload is in the audit chain with its fingerprint.
    const c = new Client({ connectionString: state.adminUrl });
    await c.connect();
    const audit = await c.query(`SELECT new_value FROM audit_logs WHERE action = 'document.uploaded' AND entity_id = $1`, [photo.id]);
    await c.end();
    expect(audit.rows[0].new_value).toMatchObject({ sha256: photo.sha256, ownerId: findingId });
  });

  it('keeps evidence inside its tenant', async () => {
    await api('otherAdmin').get(`/v1/documents/${photo.id}`).expect(404);
    expect((await api('ahmed').get(`/v1/documents/${photo.id}`).expect(200)).body.id).toBe(photo.id);
  });

  it('issues a PDF report with a QR verification code after approval', async () => {
    const queued = (await api('admin').get(`/v1/inspections/${inspectionId}/reports`).expect(200)).body;
    expect(queued).toHaveLength(1);
    expect(queued[0].status).toBe('PENDING');
    expect(queued[0].verificationCode).toBeNull(); // not disclosed before issue

    // Preview while pending: rendered on the fly and marked as not issued.
    const preview = await api('admin').get(`/v1/inspections/${inspectionId}/report.pdf?lang=en`).buffer(true).expect(200);
    expect(preview.headers['x-report-issued']).toBe('false');
    expect(Buffer.from(preview.body).subarray(0, 4).toString()).toBe('%PDF');

    expect((await api('admin').post('/v1/admin/reports/run').expect(201)).body.processed).toBeGreaterThanOrEqual(1);
    const [issued] = (await api('admin').get(`/v1/inspections/${inspectionId}/reports`).expect(200)).body;
    expect(issued.status).toBe('ISSUED');
    expect(issued.verificationCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
    expect(issued.verifyUrl).toBe(`https://verify.inspectionflow.test/verify/${issued.verificationCode}`);
    reportCode = issued.verificationCode;
    pdfSha = issued.pdfSha256;

    const pdf = await api('ahmed').get(`/v1/inspections/${inspectionId}/report.pdf`).buffer(true).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['x-report-issued']).toBe('true');
    expect(sha256(Buffer.from(pdf.body))).toBe(pdfSha);
    // Photos are embedded: the issued PDF is larger than a text-only page would be.
    expect(Buffer.from(pdf.body).includes(Buffer.from('/Subtype /Image'))).toBe(true);

    // Another tenant cannot fetch it.
    await api('otherAdmin').get(`/v1/inspections/${inspectionId}/report.pdf`).expect(404);
  });

  it('verifies the report publicly by its code, without personal data', async () => {
    const v = (await request(http).get(`/v1/verify/${reportCode}`).expect(200)).body;
    expect(v).toMatchObject({ valid: true, status: 'ISSUED', documentType: 'INSPECTION_REPORT', pdfSha256: pdfSha, inspectionStatus: 'APPROVED' });
    expect(v.reportNumber).toMatch(/^CONSTRUCTION_SAFETY-\d{4}-\d{6}-C1$/);
    expect(JSON.stringify(v)).not.toMatch(/Ahmed|Evidence test site|P-2001/);

    const page = await request(http).get(`/verify/${reportCode.toLowerCase()}`).expect(200);
    expect(page.text).toContain(v.reportNumber);
    expect(page.text).toContain(pdfSha);

    await request(http).get('/v1/verify/0000000000000000').expect(404);
    await request(http).get('/v1/verify/not-a-code').expect(404);
    expect((await request(http).get('/verify/0000000000000000').expect(200)).text).toContain('Unknown verification code');
  });

  it('does not issue a second report for the same approval', async () => {
    await api('admin').post('/v1/admin/reports/run').expect(201);
    expect((await api('admin').get(`/v1/inspections/${inspectionId}/reports`).expect(200)).body).toHaveLength(1);
  });
});
