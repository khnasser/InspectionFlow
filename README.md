# InspectionFlow — MVP

Arabic-first, multi-tenant inspection and enforcement platform for GCC regulators: inspect offline on a phone, turn findings into occurrence-based actions and fines with the regulator's own rules, route them for approval, issue a payment advice and track collection, with every action in a tamper-evident audit log.

This MVP implements Phase 0 of the *InspectionFlow — Technical Implementation Blueprint*: tenancy with PostgreSQL row-level security, the violation engine, the inspection lifecycle, approvals, payments, tasks and delegation, offline sync, and a back-office web app and a mobile app. It is built in TypeScript end to end so the engine runs identically on the server and on the device; see `docs/ADR-001-typescript-stack.md` for the decision and its consequences.

## Repository layout

| Path | What it is |
| --- | --- |
| `packages/engine` | Pure, deterministic violation engine: occurrence counting (7 repetition strategies, repeat window, yearly reset in the tenant time zone), ladder or multiplier fines, severity, follow-up dates in calendar or working days, review route, approval chain by amount, UUID v7 |
| `packages/sync-client` | Offline outbox, idempotent push/pull sync and provisional (offline) evaluation used by the mobile app |
| `apps/api` | NestJS REST API on PostgreSQL; tenant from the token only; RLS on every tenant table |
| `apps/web` | React + Ant Design back office, Arabic RTL and English |
| `apps/mobile` | Expo (React Native) inspector app: encrypted SQLite, works fully offline |
| `db/migrations` | `001_core_schema.sql` (schema v2 with the 20 blueprint fixes) and `002_mvp_support.sql` |
| `docs/` | MVP scope and traceability, API reference, architecture decision records |
| `deploy/`, `docker-compose.yml` | Container images and a local stack |

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

Or with Docker: `docker compose up --build` (web on http://localhost:8080).

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

On the Android emulator the default server URL `http://10.0.2.2:3000` reaches the API on your machine. The app needs a development build (`npx expo run:android`) because it uses SQLCipher.

## Tests

```bash
npm test
```

- Engine: 18 unit tests (ladders, multiplier and cap, party and per-year strategies, Dubai time-zone year boundary, working days, approval routes, rounding, UUID v7).
- Sync client: 6 tests (offline queue, retries, 4xx parking, replay after a lost response, signed-payload hash, offline provisional evaluation).
- API: 22 integration tests against a real PostgreSQL: lifecycle, idempotent replay, carried-forward findings, manager and committee approvals, payment webhook signature and idempotency, Arabic report, escalation to committee on the third occurrence, more-info and rejection, approved severity override, delegation routing, dashboard and bulk reassignment, offline sync push/pull, cross-tenant isolation, the API role seeing nothing without tenant context, append-only audit and tamper detection.

The API tests start a throwaway PostgreSQL cluster (`PG_BIN`, default `/usr/lib/postgresql/16/bin`) or use `TEST_DATABASE_ADMIN_URL` (CI service container).

## Security model (MVP)

- **Tenancy:** the API connects as `inspectionflow_api` (no `BYPASSRLS`). Each request runs in a transaction with `app.tenant_id` set from the verified token; RLS policies on every tenant table enforce isolation, including on writes.
- **Auth:** `AUTH_MODE=dev` issues short-lived HS256 tokens for the demo users and is refused when `NODE_ENV=production`. `AUTH_MODE=oidc` verifies Keycloak tokens via JWKS (`OIDC_ISSUER`, `OIDC_AUDIENCE`, `TENANT_CLAIM`, `ROLES_CLAIM`).
- **Audit:** every state change is written in the same transaction to a hash-chained, append-only log (`GET /v1/audit/verify`).
- **Payments:** gateway webhooks are HMAC-signed and idempotent on the gateway transaction id.
- **Mobile:** SQLCipher-encrypted store with a per-install key in the Keychain / Keystore.

## Not in this MVP (next phases)

See `docs/MVP-SCOPE.md` for the full traceability matrix. Main items: Keycloak realm setup and UAE PASS sign-in and signing; real payment-gateway adapters and pay page; PDF rendering service (the HTML report is ready for it); evidence photo upload to S3/MinIO; notification and outbox delivery workers (rows are written, not yet sent); CRM connectors; Configuration Studio UI (configuration is seeded by script); scheduler for routine notifications and reminders; Oracle support; client portal.
