/**
 * Evidence upload against a real S3-compatible server (moto in CI, MinIO or
 * AWS when pointed at one). Skipped unless S3_TEST_ENDPOINT is set, e.g.
 *   pip install "moto[server]" && moto_server -p 4566 &
 *   S3_TEST_ENDPOINT=http://localhost:4566 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test npm test -w @inspectionflow/api
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { uuidv7 } from '@inspectionflow/engine';
import { AppModule } from '../src/app.module';
import { loadConfig } from '../src/common/config';

const ENDPOINT = process.env.S3_TEST_ENDPOINT;
const BUCKET = `if-test-${Date.now()}`;
const suite = ENDPOINT ? describe : describe.skip;

suite('evidence on S3-compatible storage', () => {
  let app: INestApplication;
  let http: any;
  let token = '';
  const body = Buffer.from('JPEG-ish evidence bytes '.repeat(200));
  const sha = createHash('sha256').update(body).digest('hex');
  const meta = () => ({ id: uuidv7(), ownerType: 'FINDING', ownerId: uuidv7(), mimeType: 'image/jpeg', sizeBytes: body.length, sha256: sha });

  beforeAll(async () => {
    const state = JSON.parse(readFileSync(join(tmpdir(), 'inspectionflow-test-db.json'), 'utf8'));
    const { S3Client, CreateBucketCommand } = await import('@aws-sdk/client-s3');
    await new S3Client({ region: 'me-central-1', endpoint: ENDPOINT, forcePathStyle: true }).send(
      new CreateBucketCommand({ Bucket: BUCKET, CreateBucketConfiguration: { LocationConstraint: 'me-central-1' } as any }),
    );
    const config = loadConfig({
      ...process.env,
      DATABASE_URL: state.appUrl,
      AUTH_MODE: 'dev',
      NODE_ENV: 'test',
      REPORT_WORKER: 'off',
      STORAGE_DRIVER: 's3',
      S3_BUCKET: BUCKET,
      S3_REGION: 'me-central-1',
      S3_ENDPOINT: ENDPOINT,
      S3_FORCE_PATH_STYLE: 'true',
    });
    app = await NestFactory.create(AppModule.register(config), { logger: false });
    await app.init();
    http = app.getHttpServer();
    token = (await request(http).post('/v1/dev/login').send({ tenantCode: 'DEMO-AUTH', email: 'ahmed@demoauth.inspectionflow.test' }).expect(201)).body.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  const api = () => ({
    post: (url: string, b?: object) => request(http).post(url).set('Authorization', `Bearer ${token}`).send(b ?? {}),
    get: (url: string) => request(http).get(url).set('Authorization', `Bearer ${token}`),
  });

  it('accepts an upload whose bytes match the declared SHA-256 and serves it back', async () => {
    const m = meta();
    const init = (await api().post('/v1/documents', m).expect(201)).body;
    expect(init.upload.url).toContain(BUCKET);
    const put = await fetch(init.upload.url, { method: 'PUT', headers: init.upload.headers, body });
    expect(put.status).toBe(200);
    expect((await api().post(`/v1/documents/${m.id}/complete`).expect(200)).body.status).toBe('AVAILABLE');
    const doc = (await api().get(`/v1/documents/${m.id}`).expect(200)).body;
    const got = Buffer.from(await (await fetch(doc.url)).arrayBuffer());
    expect(createHash('sha256').update(got).digest('hex')).toBe(sha);
  });

  it('never accepts tampered bytes, even when the store does not check the checksum', async () => {
    const m = meta();
    const init = (await api().post('/v1/documents', m).expect(201)).body;
    const bad = Buffer.from(body);
    bad[10] ^= 0xff;
    const put = await fetch(init.upload.url, { method: 'PUT', headers: init.upload.headers, body: bad });
    if (put.status === 200) {
      // The store took it (moto, some MinIO set-ups): the server must catch it.
      expect((await api().post(`/v1/documents/${m.id}/complete`).expect(200)).body.status).toBe('REJECTED');
    } else {
      // Real S3 refuses the PUT itself (BadDigest).
      expect(put.status).toBeGreaterThanOrEqual(400);
      await api().post(`/v1/documents/${m.id}/complete`).expect(409);
    }
  });
});
