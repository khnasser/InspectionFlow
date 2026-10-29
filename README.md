# InspectionFlow — MVP

Arabic-first, multi-tenant inspection and enforcement platform for GCC regulators: inspect offline on a phone, turn findings into occurrence-based actions and fines with the regulator's own rules, route them for approval, issue a payment advice and track collection, with every action in a tamper-evident audit log.

This MVP implements Phase 0 of the *InspectionFlow — Technical Implementation Blueprint*: tenancy with PostgreSQL row-level security, the violation engine, the inspection lifecycle, approvals, payments, tasks and delegation, offline sync, Keycloak / UAE PASS sign-in, photo evidence on S3, issued PDF reports with QR verification, and a back-office web app and a mobile app. It is built in TypeScript end to end so the engine runs identically on the server and on the device; see `docs/ADR-001-typescript-stack.md` for the decision and its consequences.

## Repository layout

| Path | What it is |
| --- | --- |
| `packages/engine` | Pure, deterministic violation engine: occurrence counting (7 repetition strategies, repeat window, yearly reset in the tenant time zone), ladder or multiplier fines, severity, follow-up dates in calendar or working days, review route, approval chain by amount, UUID v7 |
| `packages/sync-client` | Offline outbox, idempotent push/pull sync and provisional (offline) evaluation used by the mobile app |
| `apps/api` | NestJS REST API on PostgreSQL; tenant from the token only; RLS on every tenant table |
| `apps/web` | React + Ant Design back office, Arabic RTL and English |
| `apps/mobile` | Expo (React Native) inspector app: encrypted SQLite, works fully offline |
| `db/migrations` | `001_core_schema.sql` (schema v2 with the 20 blueprint fixes), `002_mvp_support.sql`, `003_oidc_identity.sql` (OIDC user linking), `004_evidence_reports.sql` (upload states, report jobs, public verification) |
| `docs/` | MVP scope and traceability, API reference, architecture decision records |
| `deploy/`, `docker-compose.yml` | Container images, Keycloak realm export (`deploy/keycloak`) and a local stack |

## Quick start (local)

Requirements: Node 22, PostgreSQL 16 or 17.

```bash
npm ci
cp .env.example .env            # adjust if needed
createdb inspectionflow
export DATABASE_ADMIN_URL=postgres://postgres@localhost:5432/inspectionflow
npm run build -w @inspectionflow/engine
npm run db:migrate && npm run db:seed
DATABASE_URL=postgres://inspectionflow_api:inspectionflow_api@localhost:5432/inspectionflow npm run dev -w @inspectionflow/api
npm run dev:web                 # http://localhost:5173
```

Or with Docker: `docker compose up --build` (web on http://localhost:8080, PDFs rendered by Gotenberg).

PDF reports render with local Chromium in development (`REPORT_RENDERER=playwright`, needs `playwright` installed) and with [Gotenberg](https://gotenberg.dev) in production (`REPORT_RENDERER=gotenberg`). Evidence is stored on local disk in development (`STORAGE_DRIVER=local`) and in S3 in production (`STORAGE_DRIVER=s3`).

### Sign-in with Keycloak and UAE PASS

```bash
docker compose -f docker-compose.yml -f docker-compose.oidc.yml up --build
```

This starts Keycloak 26 on http://localhost:8081 with the `inspectionflow-demo` realm (`deploy/keycloak/demo-realm.json`): public PKCE clients `inspectionflow-web` and `inspectionflow-mobile`, an `inspectionflow-api` audience, a `tenant` claim, and UAE PASS **staging** brokered as an OIDC identity provider (`kc_idp_hint=uaepass` skips the Keycloak page). Demo users have the password `Demo#2026`.

- The API (`AUTH_MODE=oidc`) verifies tokens against the realm's JWKS and links a pre-provisioned InspectionFlow user to the token subject on first sign-in, by verified email. **Roles always come from InspectionFlow, never from the token.**
- Before production: register the tenant with UAE PASS (TDRA) for production client credentials and confirm the scope and claim names; the sandbox values in the realm file are placeholders for the staging environment.

Demo tenant `DEMO-AUTH` (development sign-in, no password):

| User | Roles |
| --- | --- |
| `ahmed@demoauth.inspectionflow.test` | Inspector |
| `omar@demoauth.inspectionflow.test` | Inspector |
| `sara@demoauth.inspectionflow.test` | Section manager, senior inspector |
| `khalid@demoauth.inspectionflow.test` | Committee, director |
| `ceo@demoauth.inspectionflow.test` | CEO |
| `admin@demoauth.inspectionflow.test` | Admin, section manager |

Seeded processes follow a typical regulator rule set: `CONSTRUCTION_SAFETY` (FIR → warning → committee-reviewed penalty, 7/3/0-day follow-up, yearly reset per project; `CS-02` uses the PRD formula `base × multiplier^(n−1)`) and `COMMUNITY_COMPLIANCE` (overcrowding: warning → final warning → penalty, working-day follow-up).

### Mobile app

```bash
npm run build -w @inspectionflow/engine && npm run build -w @inspectionflow/sync-client
cd apps/mobile && npm ci --install-links && npx expo start
```

On the Android emulator the default server URL `http://10.0.2.2:3000` reaches the API on your machine. The app needs a development build (`npx expo run:android`) because it uses SQLCipher. When the API runs with `AUTH_MODE=oidc` the sign-in screen switches to UAE PASS / staff sign-in (redirect scheme `inspectionflow://auth`). Inspectors take photos per finding or for the whole site; photos are compressed to 1600 px JPEG, queued in the encrypted store and uploaded on the next sync.

## Tests

```bash
npm test
```

- Engine: 18 unit tests (ladders, multiplier and cap, party and per-year strategies, Dubai time-zone year boundary, working days, approval routes, rounding, UUID v7).
- Sync client: 9 tests (offline queue, retries, 4xx parking, replay after a lost response, signed-payload hash, offline provisional evaluation, photo queue offline and retry, rejected photos parked).
- API: 35 integration tests against a real PostgreSQL:
  - lifecycle, idempotent replay, carried-forward findings, manager and committee approvals, payment webhook signature and idempotency, Arabic report, escalation to committee on the third occurrence, more-info and rejection, approved severity override, delegation routing, dashboard and bulk reassignment, offline sync push/pull, cross-tenant isolation, the API role seeing nothing without tenant context, append-only audit and tamper detection;
  - OIDC: JWKS verification (wrong key, audience, issuer), linking by verified email, roles taken from the database not the token, unknown and unverified users refused, subject reuse across tenants refused;
  - evidence: upload before the inspection exists, SHA-256 and size enforced, idempotent retries, wrong owner, type and size limits, forged URLs, tenant isolation, audit entry;
  - reports: preview vs issued PDF, embedded photos, fingerprint matches the stored file, public verification without personal data, unknown codes, no duplicate issue.

The API tests start a throwaway PostgreSQL cluster (`PG_BIN`, default `/usr/lib/postgresql/16/bin`) or use `TEST_DATABASE_ADMIN_URL` (CI service container).

## Security model (MVP)

- **Tenancy:** the API connects as `inspectionflow_api` (no `BYPASSRLS`). Each request runs in a transaction with `app.tenant_id` set from the verified token; RLS policies on every tenant table enforce isolation, including on writes.
- **Auth:** `AUTH_MODE=dev` issues short-lived HS256 tokens for the demo users and is refused when `NODE_ENV=production`. `AUTH_MODE=oidc` verifies Keycloak tokens via JWKS (`OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URL`, `TENANT_CLAIM`); web and mobile use authorization code + PKCE, with no client secret on any device.
- **Evidence:** clients upload straight to object storage with 15-minute signed URLs bound to the declared size and SHA-256 (S3 checks the checksum); keys are prefixed `t/{tenantId}/`; files are immutable once accepted and their hash is written to the audit log.
- **Reports:** issued PDFs are stored with their SHA-256. The QR code carries an 80-bit random code; the public page shows only issuer, number, date, inspection status and fingerprint.
- **Audit:** every state change is written in the same transaction to a hash-chained, append-only log (`GET /v1/audit/verify`).
- **Payments:** gateway webhooks are HMAC-signed and idempotent on the gateway transaction id.
- **Mobile:** SQLCipher-encrypted store with a per-install key in the Keychain / Keystore.

## Not in this MVP (next phases)

See `docs/MVP-SCOPE.md` for the full traceability matrix. Main items: UAE PASS document signing (PAdES); real payment-gateway adapters and pay page; notification and outbox delivery workers (rows are written, not yet sent); CRM connectors; Configuration Studio UI (configuration is seeded by script); scheduler for routine notifications and reminders; video evidence and malware scanning of uploads; Oracle support; client portal.

Verified against real services in CI (`live-services` job): Keycloak 26 with the demo realm (PKCE sign-in, token claims, the API accepting the token, UAE PASS staging redirect, mobile redirect scheme) and Gotenberg 8 (Arabic PDF with embedded font, photo and QR). Evidence upload is tested against an S3-compatible server. Still to verify: a real UAE PASS login (needs TDRA sandbox users) and AWS S3 itself. Deployment: Helm chart in `deploy/helm`, runbook in `docs/DEPLOY.md`; CI builds the images and pushes them to `ghcr.io/khnasser/inspectionflow-api` and `-web`.
