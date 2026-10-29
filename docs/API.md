# API reference (MVP)

All routes except `/health`, `/v1/dev/login` and `/v1/webhooks/payments` need `Authorization: Bearer <token>`. The tenant always comes from the token. Errors are `application/problem+json`.

| Method | Path | Roles | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | public | Liveness and database check |
| POST | `/v1/dev/login` | public, `AUTH_MODE=dev` only | `{tenantCode, email}` → `{accessToken, user}` |
| GET | `/v1/me` | any | Caller identity |
| GET | `/v1/config/bundle` | any | Processes, violations with engine rules, checklists, thresholds (offline bundle) |
| POST | `/v1/engine/evaluate` | any | Side-effect-free evaluation `{processCode, inspectableId, findings[]}` |
| POST | `/v1/inspections/submit` | INSPECTOR, SENIOR_INSPECTOR | Submit an inspection; idempotent on `clientMutationId` |
| GET | `/v1/inspections/:id` | any | Detail with findings, approvals, signature |
| GET | `/v1/inspections/:id/report.html?lang=ar|en` | any | Bilingual report (PDF source) |
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
