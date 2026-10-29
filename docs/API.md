# API reference (MVP)

All routes except `/health`, `/v1/auth/config`, `/v1/dev/login`, `/v1/webhooks/payments`, `/v1/storage/local/*` and the verification routes need `Authorization: Bearer <token>`. The tenant always comes from the token. Errors are `application/problem+json`.

| Method | Path | Roles | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | public | Liveness and database check |
| GET | `/v1/auth/config` | public | How to sign in: `{mode:'dev'}` or `{mode:'oidc', issuer, webClientId, mobileClientId, scope}` |
| POST | `/v1/dev/login` | public, `AUTH_MODE=dev` only | `{tenantCode, email}` → `{accessToken, user}` |
| GET | `/v1/me` | any | Caller identity |
| GET | `/v1/config/bundle` | any | Processes, violations with engine rules, checklists, thresholds (offline bundle) |
| POST | `/v1/engine/evaluate` | any | Side-effect-free evaluation `{processCode, inspectableId, findings[]}` |
| POST | `/v1/inspections/submit` | INSPECTOR, SENIOR_INSPECTOR | Submit an inspection; idempotent on `clientMutationId` |
| GET | `/v1/inspections/:id` | any | Detail with findings, approvals, signature and `evidence[]` (with 5-minute download URLs) |
| GET | `/v1/inspections/:id/report.html?lang=ar|en` | any | Report as HTML |
| GET | `/v1/inspections/:id/report.pdf?lang=ar|en&preview=1` | any | The issued PDF once approved (`X-Report-Issued: true`); otherwise, or with `preview=1`, a PDF marked as a preview |
| GET | `/v1/inspections/:id/reports` | any | Issued reports: number, status, verification code and URL, SHA-256 |
| POST | `/v1/documents` | INSPECTOR, SENIOR_INSPECTOR | Start an evidence upload `{id, ownerType: FINDING|INSPECTION, ownerId, mimeType, sizeBytes, sha256, fileName?, capturedAt?, latitude?, longitude?}` → `{status, upload: {url, method: 'PUT', headers}}`. The device picks `id` and `ownerId`, so photos can be sent before or after the inspection. Idempotent on `id` |
| PUT | upload URL | signed URL | Send the bytes with the returned headers; size and SHA-256 must match |
| POST | `/v1/documents/:id/complete` | the uploader | Check the stored object and mark it `AVAILABLE` (or `REJECTED`) |
| GET | `/v1/documents/:id` | any | Metadata and a short-lived download URL |
| POST | `/v1/admin/reports/run` | ADMIN | Run the report worker now (it also runs on a timer) |
| GET | `/v1/verify/:code` | public | `{valid, status, issuer, documentType, reportNumber, issuedAt, pdfSha256, inspectionStatus}` — no personal data |
| GET | `/verify/:code` | public | Bilingual page the QR code opens |
| POST | `/v1/inspections/:id/respond` | inspector who performed it | Answer a "more info" request |
| POST | `/v1/inspections/:id/signature/clear` | SENIOR_INSPECTOR, SECTION_MANAGER, ADMIN | Clear signature with reason; unlocks editing |
| GET | `/v1/reviews` | reviewer roles | Approval steps the caller can act on now |
| POST | `/v1/approvals/:id/decide` | role of that step | `{decision: APPROVED|REJECTED|MORE_INFO, comment?, overrides?[]}` |
| GET | `/v1/me/tasks?includeDelegated=true` | any | Own, role-pool and delegated tasks |
| POST | `/v1/tasks/:id/claim` | role of the task | Claim a pool task |
| POST | `/v1/tasks/:id/reassign` | assignee or manager | `{userId}` |
| POST | `/v1/tasks/bulk-reassign` | SECTION_MANAGER, ADMIN | `{taskIds[], userId}` |
| GET / POST | `/v1/delegations` | any (managers for others) | List / create `{delegateId, startsAt, endsAt, reason?, delegatorId?}` |
| POST | `/v1/delegations/:id/deactivate` | delegator or manager | End a delegation |
| GET | `/v1/team/dashboard` | SECTION_MANAGER, ADMIN | Open, overdue, due today, delegation per member |
| GET | `/v1/users?role=` | any | Users for pickers |
| GET / POST | `/v1/inspectables` | any | Search / register |
| GET | `/v1/inspectables/:id` | any | Parties, open findings, history |
| POST | `/v1/inspectables/:id/parties` | any | Link a party `{partyId, role, isPrimary}` |
| GET / POST | `/v1/parties` | any | Search / create |
| GET | `/v1/payment-advices?status=` | any | List |
| GET | `/v1/payment-advices/:id` | any | Detail with payments |
| POST | `/v1/payment-advices/:id/pay-link` | any | Pay link for SMS / email |
| POST | `/v1/webhooks/payments` | public, HMAC `x-signature` | Gateway callback; idempotent on gateway txn id |
| POST | `/v1/sync/push` | INSPECTOR, SENIOR_INSPECTOR | Batch of offline mutations; per-item result |
| GET | `/v1/sync/pull` | any | Work package and occurrence history |
| GET | `/v1/audit/verify` | ADMIN, SECTION_MANAGER | Recompute the tenant's audit hash chain |
| GET | `/v1/me/notifications` | any | In-app notifications for the caller |
| POST | `/v1/me/notifications/:id/read` | the recipient | Mark as read |
| GET | `/v1/admin/notifications?status=` | ADMIN | Delivery monitor (addresses masked) |
| GET / PUT | `/v1/admin/notification-templates` | ADMIN | Effective templates; override one `{code, channel, locale, subject?, body}` |
| GET / POST | `/v1/admin/webhooks` | ADMIN | List / create `{name, url, eventTypes[]}`; the signing secret is returned once |
| DELETE | `/v1/admin/webhooks/:id` | ADMIN | Deactivate |
| GET | `/v1/admin/webhooks/:id/deliveries` | ADMIN | Delivery attempts |
| POST | `/v1/admin/jobs/run` | ADMIN | Run reports, notifications and the outbox relay now |

### Webhook format

`POST` to the subscriber with JSON `{id, type, occurredAt, tenantId, subject: {type, id}, data}` and headers `X-InspectionFlow-Event`, `X-InspectionFlow-Delivery` (the event id: ignore repeats) and `X-InspectionFlow-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body" with the subscription secret>`. Any 2xx is success; anything else is retried with exponential backoff (up to 8 attempts, at most 6 hours apart). Only https URLs that resolve to public addresses are accepted.

### Tenant settings used by the background jobs

| Key (`tenant_settings`) | Default | Effect |
| --- | --- | --- |
| `notifications.quietHours` | `{"start":"22:00","end":"07:00"}` | No SMS inside this window (tenant time zone); `null` turns it off |
| `scheduler` | `{"paymentReminderDays":[3,6],"blockOnOverdue":true,"taskEscalationDays":3,"findingDueReminder":true}` | Reminder days after issue, FINANCE_BLOCK on overdue (lifted when paid), escalation delay, finding due notices |
