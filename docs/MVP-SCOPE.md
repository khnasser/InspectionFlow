# MVP scope and traceability

Status: **Done** = implemented and covered by automated tests; **Partial** = implemented without the full production integration; **Next** = planned for a later phase of the blueprint.

| PRD / blueprint item | Status | Where |
| --- | --- | --- |
| Multi-tenant SaaS, tenant isolation (PRD 3.1) | Done | `db/migrations/001_core_schema.sql` §10 (RLS on every tenant table), `apps/api/src/common/db.service.ts`; tests "tenant isolation and audit" |
| UAE data residency | Partial | Deployment concern; `tenants.data_region`; deploy to a UAE region (blueprint §3) |
| Arabic-first UI, RTL | Done (web), Done (mobile, typecheck + bundle) | `apps/web/src/i18n.tsx`, `apps/mobile/src/i18n.ts`, Arabic HTML report |
| Inspectables and parties, many-to-many links, add party during inspection (PRD 3.2) | Done | `registry.controller.ts`, `InspectionService.ensurePartyLinks` |
| Routine and service processes, configurable (PRD 3.3) | Partial | `inspection_processes`; routine/random/follow-up flows done; paid service-request flow (application, prepaid block) is Next |
| Mobile inspection flow, offline sync (PRD 3.4) | Done | `packages/sync-client`, `apps/mobile`, `/v1/sync/push`, `/v1/sync/pull` |
| Parallel tasks (FORK/JOIN) | Next | Blueprint §6.3 (`inspection-service` BPMN with parallel section reviews) |
| Violation engine: repetition strategies, window, escalation, multiplier, yearly reset (PRD 3.5, §5) | Done | `packages/engine`; 18 unit tests; escalation e2e test |
| Severity override with approval, counter adjustment (construction-safety rules) | Done | `ReviewService.applyOverrideDecisions`; e2e test |
| Committee and amount-based approval chain (construction-safety and incident rules) | Done | `approval_thresholds`, `approvalChainFor`; e2e test |
| Task list `/my-tasks?includeDelegated=true` (PRD 3.6) | Done | `GET /v1/me/tasks?includeDelegated=true` |
| User delegation, auto-resolve at assignment (PRD 3.7) | Done | `AssignmentService.resolveAssignee`, exclusion constraint against overlaps |
| Team manager dashboard, bulk reassignment (PRD 3.8) | Done | `GET /v1/team/dashboard`, `POST /v1/tasks/bulk-reassign` |
| Digital signature, clear by senior with reason, edit lock (PRD 3.9) | Done | `client_signatures`, `POST /v1/inspections/:id/signature/clear`; signature pad in mobile app |
| Sign-in: Keycloak, UAE PASS (PRD 7) | Partial | API OIDC verification and user linking done and tested (`oidc.e2e.spec.ts`); web (`oidc-client-ts`) and mobile (`expo-auth-session`) PKCE flows; realm export with UAE PASS staging broker. Verified against real Keycloak 26 in CI; a real UAE PASS login still needs TDRA sandbox users |
| UAE PASS signing | Next | Blueprint §8 |
| Billing: payment advice per inspection, statuses (PRD 3.10) | Done | `InspectionService.finalizeApproved`, `payment_advices` |
| Payment gateways PayTabs / Checkout.com / Network International / Stripe | Partial | Signed, idempotent webhook contract done (`POST /v1/webhooks/payments`); real adapters Next |
| Document storage MinIO/S3, photo evidence (PRD 3.11) | Done (local driver), Partial (S3) | `common/storage.ts` (S3 presigned PUT with SHA-256 checksum; local driver with signed URLs), `modules/documents`; offline photo queue in `sync-client`; camera capture in mobile; thumbnails in web; tests in `evidence-reports.e2e.spec.ts`. S3 driver tested against an S3-compatible server in CI; the server re-hashes uploads when the store does not enforce checksums |
| Arabic PDF reports with QR verification (PRD 3.12) | Done (Chromium via Playwright and Gotenberg 8, both tested) | Report queued on approval, rendered by a worker with embedded Noto Naskh Arabic and photos, stored with SHA-256; `GET /v1/inspections/:id/report.pdf`, public `GET /verify/:code`. Excel exports Next |
| CRM sync HubSpot / Salesforce / Zoho (PRD 8) | Partial | Outbox relay delivers every event to signed tenant webhooks with retries and per-endpoint tracking (any CRM / iPaaS can consume them); native CRM connectors Next |
| Notifications SMS / email / in-app | Done (email, in-app), Partial (SMS) | Delivery worker with retries and backoff, tenant quiet hours for SMS, bilingual templates with tenant overrides, letters with the issued PDF attached, delivery monitor; SMTP for email; Infobip SMS adapter not yet run against a live account; WhatsApp and push Next |
| Audit of all actions (PRD 11) | Done | Hash-chained, append-only `audit_logs`; verify endpoint; tamper test |
| Security: JWT, RLS, AES-256 | Partial | JWT (dev HS256 / OIDC JWKS), RLS, SQLCipher on device; at-rest encryption is a hosting setting |
| Performance: task list < 500 ms | Partial | Indexed inbox query; load test (k6) Next |
| Oracle 19c support | Next | Sovereign edition only (blueprint §2) |
| Configuration Studio | Next | Configuration seeded by `apps/api/scripts/seed.ts` |
| Client portal | Next | Blueprint §6.12 |
| Deployment: containers, Kubernetes, migrations | Done (as code), Partial (no cluster yet) | `deploy/helm/inspectionflow`, `docs/DEPLOY.md`; images built and pushed by CI; chart validated with kubeconform |
| Scheduler: payment reminders, overdue and blocking, task escalation, finding due dates (PRD 3.10, construction-safety rules) | Done | `SchedulerService`: reminders on configurable days (default 3 and 6), overdue marking with audit and `payment_advice.overdue`, optional party FINANCE_BLOCK lifted on payment, escalation of tasks overdue by N days to the assignee's manager, finding due notices; each action fires once; rules per tenant in `tenant_settings.scheduler` |
