/**
 * Checks against the real services the platform depends on. Each block runs
 * only when its service URL is set (the CI "live-services" job starts them):
 *   LIVE_KEYCLOAK_URL=http://localhost:8081  (Keycloak 26 with deploy/keycloak/demo-realm.json)
 *   LIVE_GOTENBERG_URL=http://localhost:3001 (Gotenberg 8)
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createHash, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import QRCode from 'qrcode';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { loadConfig } from '../src/common/config';
import { renderInspectionReport } from '../src/modules/inspections/report';
import { GotenbergRenderer } from '../src/modules/reports/pdf';

const KC = process.env.LIVE_KEYCLOAK_URL;
const GOTENBERG = process.env.LIVE_GOTENBERG_URL;
const REALM = 'inspectionflow-demo';
const REDIRECT = 'http://localhost:5173/auth/callback';
const b64url = (b: Buffer) => b.toString('base64url');

(KC ? describe : describe.skip)('Keycloak realm and OIDC sign-in (live)', () => {
  let browser: any;
  let app: INestApplication;
  const issuer = `${KC}/realms/${REALM}`;

  beforeAll(async () => {
    const { chromium } = require('playwright');
    browser = await chromium.launch();
    const state = JSON.parse(readFileSync(join(tmpdir(), 'inspectionflow-test-db.json'), 'utf8'));
    const config = loadConfig({
      ...process.env,
      DATABASE_URL: state.appUrl,
      NODE_ENV: 'test',
      REPORT_WORKER: 'off',
      AUTH_MODE: 'oidc',
      OIDC_ISSUER: issuer,
      OIDC_AUDIENCE: 'inspectionflow-api',
      TENANT_CLAIM: 'tenant',
    });
    app = await NestFactory.create(AppModule.register(config), { logger: false });
    await app.init();
  });

  afterAll(async () => {
    await browser?.close();
    await app?.close();
  });

  /** Authorization code + PKCE through the real Keycloak login page; returns the redirect it ends on. */
  async function authorize(params: Record<string, string>, login?: { user: string; password: string }) {
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const q = new URLSearchParams({
      client_id: 'inspectionflow-web',
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'openid profile email',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: b64url(randomBytes(8)),
      ...params,
    });
    const page = await browser.newPage();
    // Keycloak redirects to the app (or to UAE PASS); nothing listens there in
    // the test, so record the request the browser makes instead of following it.
    const target = /^(http:\/\/localhost:5173|https:\/\/stg-id\.uaepass\.ae)/;
    const captured: Promise<string | null> = page
      .waitForRequest((r: any) => target.test(r.url()), { timeout: login ? 20000 : 8000 })
      .then((r: any) => r.url())
      .catch(() => null);
    await page.goto(`${issuer}/protocol/openid-connect/auth?${q}`).catch(() => undefined);
    if (login) {
      await page.fill('#username', login.user);
      await page.fill('#password', login.password);
      await page.click('#kc-login').catch(() => undefined);
    }
    const landed = await captured;
    const html = await page.content().catch(() => '');
    await page.close();
    return { landed, verifier, html };
  }

  async function exchange(code: string, verifier: string) {
    const res = await fetch(`${issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'inspectionflow-web', code, redirect_uri: REDIRECT, code_verifier: verifier }),
    });
    expect(res.status).toBe(200);
    return res.json() as Promise<{ access_token: string; refresh_token: string }>;
  }

  it('imports the realm with the tenant claim and API audience, and the API accepts the token', async () => {
    const r = await authorize({}, { user: 'ahmed', password: 'Demo#2026' });
    const code = new URL(r.landed!).searchParams.get('code')!;
    expect(code).toBeTruthy();
    const tokens = await exchange(code, r.verifier);
    const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString());
    expect(claims.iss).toBe(issuer);
    expect([].concat(claims.aud)).toContain('inspectionflow-api');
    expect(claims.tenant).toBe('DEMO-AUTH');
    expect(tokens.refresh_token).toBeTruthy();

    const http = app.getHttpServer();
    const me = (await request(http).get('/v1/me').set('Authorization', `Bearer ${tokens.access_token}`).expect(200)).body;
    expect(me.roles).toContain('INSPECTOR');
    expect(me.tenantId).toBeTruthy();
    const tasks = await request(http).get('/v1/me/tasks').set('Authorization', `Bearer ${tokens.access_token}`).expect(200);
    expect(Array.isArray(tasks.body)).toBe(true);
    expect((await request(http).get('/v1/auth/config').expect(200)).body).toMatchObject({ mode: 'oidc', issuer, webClientId: 'inspectionflow-web' });
  });

  it('refuses a token without PKCE and a redirect URI the client does not allow', async () => {
    const noPkce = await authorize({ code_challenge: '', code_challenge_method: '' });
    expect(noPkce.landed ?? noPkce.html).toMatch(/error|code_challenge|PKCE|Missing parameter/i);
    const badRedirect = await authorize({ redirect_uri: 'https://evil.example/cb' });
    expect(badRedirect.landed).toBeNull();
    expect(badRedirect.html).toMatch(/redirect_uri|Invalid parameter/i);
  });

  it('sends kc_idp_hint=uaepass straight to the UAE PASS staging authorize endpoint', async () => {
    const r = await authorize({ kc_idp_hint: 'uaepass', ui_locales: 'ar' });
    expect(r.landed).toMatch(/^https:\/\/stg-id\.uaepass\.ae\/idshub\/authorize\?/);
    const u = new URL(r.landed!);
    expect(u.searchParams.get('client_id')).toBe('sandbox_stage');
    expect(u.searchParams.get('scope')).toContain('urn:uae:digitalid:profile:general');
    expect(u.searchParams.get('redirect_uri')).toBe(`${issuer}/broker/uaepass/endpoint`);
    expect(u.searchParams.get('ui_locales')).toBe('ar');
  });

  it('accepts the mobile app redirect scheme', async () => {
    const verifier = b64url(randomBytes(32));
    const q = new URLSearchParams({
      client_id: 'inspectionflow-mobile',
      redirect_uri: 'inspectionflow://auth',
      response_type: 'code',
      scope: 'openid',
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
    });
    const res = await fetch(`${issuer}/protocol/openid-connect/auth?${q}`, { redirect: 'manual' });
    const html = await res.text();
    // The login page is shown (no error redirect, no "invalid redirect_uri" page).
    expect({ status: res.status, location: res.headers.get('location') }).toEqual({ status: 200, location: null });
    expect(html).toContain('id="username"');
  });
});

(GOTENBERG ? describe : describe.skip)('Gotenberg PDF rendering (live)', () => {
  it('renders the Arabic report with embedded font, photo and QR code', async () => {
    const photo = readFileSync(join(__dirname, 'fixtures', 'photo.jpg')).toString('base64');
    const qrSvg = await QRCode.toString('https://verify.example/verify/ABCDEFGHJKMNPQRS', { type: 'svg', margin: 0 });
    const d = {
      inspectionId: 'i1', logNumber: 'CONSTRUCTION_SAFETY-2026-000001', cycleNumber: 1, inspectable_name: 'Warehouse', identifier: 'P-1',
      inspectable_name_i18n: { 'ar-AE': 'مستودع' }, completed_at: '2026-10-29T08:00:00Z', inspector: 'Ahmed', status: 'APPROVED', totalFine: 1000,
      followUpDate: '2026-11-05', findings: [{ id: 'f1', violationCode: 'CS-01', occurrence: 1, severity: 'MAJOR', fine: 1000, resolveBy: '2026-11-05' }],
      findingDetails: [{ id: 'f1', description_i18n: { 'ar-AE': 'عدم توفير حماية الحواف' } }],
    };
    const html = renderInspectionReport(d, 'ar', {
      pdf: true,
      photos: [{ ownerId: 'f1', capturedAt: null, dataUrl: `data:image/jpeg;base64,${photo}` }],
      issued: { reportNumber: 'R-1', verifyUrl: 'https://verify.example/verify/ABCDEFGHJKMNPQRS', qrSvg, issuedAt: '2026-10-29T09:00:00Z' },
    });
    const pdf = await new GotenbergRenderer(GOTENBERG!).render(html);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    const text = pdf.toString('latin1');
    expect(text).toMatch(/NotoNaskhArabic/);
    expect(text).toMatch(/\/Subtype\s*\/Image/);
  }, 60000);
});
