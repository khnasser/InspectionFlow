import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'fs';
import { createServer, Server } from 'http';
import { exportJWK, generateKeyPair, JWK, SignJWT } from 'jose';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { loadConfig } from '../src/common/config';

/**
 * AUTH_MODE=oidc against a local JWKS endpoint standing in for Keycloak.
 * Proves: signature/issuer/audience checks, first-login linking by email,
 * roles from InspectionFlow (not the token), and rejection of unknown people.
 */
const state = JSON.parse(readFileSync(join(tmpdir(), 'inspectionflow-test-db.json'), 'utf8'));
const ISSUER = 'https://keycloak.test/realms/inspectionflow';
const AUDIENCE = 'inspectionflow-api';

let app: INestApplication;
let jwksServer: Server;
let privateKey: CryptoKey;
let otherKey: CryptoKey;

async function token(claims: Record<string, unknown>, opts: { key?: CryptoKey; aud?: string; iss?: string; sub?: string } = {}) {
  return new SignJWT({ tenant: 'DEMO-AUTH', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUDIENCE)
    .setSubject(opts.sub ?? 'kc-sara-0001')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(opts.key ?? privateKey);
}

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey as CryptoKey;
  otherKey = (await generateKeyPair('RS256')).privateKey as CryptoKey;
  const jwk: JWK = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  jwksServer = createServer((_, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => jwksServer.listen(0, '127.0.0.1', r));
  const port = (jwksServer.address() as AddressInfo).port;

  const config = loadConfig({
    ...process.env,
    DATABASE_URL: state.appUrl,
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: ISSUER,
    OIDC_AUDIENCE: AUDIENCE,
    OIDC_JWKS_URL: `http://127.0.0.1:${port}/certs`,
    NODE_ENV: 'test',
  });
  app = await NestFactory.create(AppModule.register(config), { logger: false });
  await app.init();
});

afterAll(async () => {
  await app?.close();
  jwksServer?.close();
});

describe('OIDC sign-in (Keycloak / UAE PASS via Keycloak)', () => {
  it('publishes the sign-in configuration and disables dev login', async () => {
    const cfg = await request(app.getHttpServer()).get('/v1/auth/config').expect(200);
    expect(cfg.body).toMatchObject({ mode: 'oidc', issuer: ISSUER, webClientId: 'inspectionflow-web' });
    await request(app.getHttpServer()).post('/v1/dev/login').send({ tenantCode: 'DEMO-AUTH', email: 'sara@demoauth.inspectionflow.test' }).expect(404);
  });

  it('links a pre-provisioned user by verified email on first sign-in; roles come from InspectionFlow', async () => {
    const t = await token({ email: 'Sara@DemoAuth.inspectionflow.test', email_verified: true, roles: ['CEO'] });
    const me = await request(app.getHttpServer()).get('/v1/me').set('Authorization', `Bearer ${t}`).expect(200);
    expect(me.body.name).toBe('Sara Al Suwaidi');
    expect(me.body.roles.sort()).toEqual(['SECTION_MANAGER', 'SENIOR_INSPECTOR']);
    await request(app.getHttpServer()).get('/v1/reviews').set('Authorization', `Bearer ${t}`).expect(200);
  });

  it('later sign-ins resolve by subject alone', async () => {
    const t = await token({});
    const me = await request(app.getHttpServer()).get('/v1/me').set('Authorization', `Bearer ${t}`).expect(200);
    expect(me.body.name).toBe('Sara Al Suwaidi');
  });

  it('rejects wrong signature, audience, issuer and missing tenant', async () => {
    const srv = app.getHttpServer();
    for (const bad of [
      await token({}, { key: otherKey }),
      await token({}, { aud: 'someone-else' }),
      await token({}, { iss: 'https://evil.test/realms/x' }),
    ]) {
      await request(srv).get('/v1/me').set('Authorization', `Bearer ${bad}`).expect(401);
    }
    const noTenant = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(ISSUER)
      .setAudience(AUDIENCE).setSubject('x').setExpirationTime('5m').sign(privateKey);
    await request(srv).get('/v1/me').set('Authorization', `Bearer ${noTenant}`).expect(401);
  });

  it('a valid identity without an InspectionFlow account, or with an unverified email, is refused', async () => {
    const srv = app.getHttpServer();
    const stranger = await token({ email: 'nobody@example.ae', email_verified: true }, { sub: 'kc-stranger' });
    await request(srv).get('/v1/me').set('Authorization', `Bearer ${stranger}`).expect(403);
    const unverified = await token({ email: 'omar@demoauth.inspectionflow.test', email_verified: false }, { sub: 'kc-omar' });
    await request(srv).get('/v1/me').set('Authorization', `Bearer ${unverified}`).expect(403);
  });

  it('the same subject in another tenant does not cross over', async () => {
    const t = await token({ tenant: 'OTHER-AUTH' });
    await request(app.getHttpServer()).get('/v1/me').set('Authorization', `Bearer ${t}`).expect(403);
  });
});
