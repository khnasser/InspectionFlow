# Deploying InspectionFlow (staging and production)

The platform ships as two container images and a Helm chart. Nothing in the chart is tied to one cloud: it runs on any Kubernetes 1.28+ cluster (EKS, AKS, GKE, OpenShift, or on premises for the Sovereign edition).

| Piece | Where it comes from |
| --- | --- |
| API + report worker image | `ghcr.io/khnasser/inspectionflow-api:<git sha>` (built by CI from `deploy/api.Dockerfile`) |
| Web image | `ghcr.io/khnasser/inspectionflow-web:<git sha>` (`deploy/web.Dockerfile`) |
| Chart | `deploy/helm/inspectionflow` |
| PDF renderer | `gotenberg/gotenberg:8`, deployed by the chart, no network egress |

## 1. What you provide

1. **Kubernetes cluster** in a UAE region (for example AWS `me-central-1`, Azure UAE North, or a sovereign/on-prem cluster), with an ingress controller and cert-manager (or another TLS source).
2. **PostgreSQL 16** (managed), private network only, TLS on, automated backups and point-in-time recovery.
   - Create the database `inspectionflow` and an owner role for migrations.
   - The migrations create the runtime roles `inspectionflow_app` and `inspectionflow_api` (no `BYPASSRLS`). **Change the `inspectionflow_api` password** after the first install: `ALTER ROLE inspectionflow_api PASSWORD '…'`.
3. **Object storage**: an S3 bucket (or S3-compatible) in the same region.
   - Block all public access; default encryption SSE-KMS with a customer-managed key; versioning on; Object Lock (governance mode) for evidence retention.
   - CORS rule allowing `PUT` and `GET` from the web origin (`https://<host>`) with headers `content-type`, `x-amz-checksum-sha256`.
   - Access for the pods through workload identity (IRSA on EKS, Workload Identity on AKS/GKE) via `serviceAccount.annotations`; static keys only if there is no alternative.
4. **Keycloak 26** (operator or managed). Import `deploy/keycloak/demo-realm.json` as a starting point, then per tenant:
   - set the realm's `tenant` claim to the tenant code;
   - add the production redirect URIs (`https://<host>/*`) to `inspectionflow-web`;
   - replace the UAE PASS **sandbox** client (`sandbox_stage`) with the production client id and secret issued by TDRA, and confirm the scope and claim names in the onboarding pack.
5. **DNS and TLS** for `<host>`.
6. **Secrets** (from a vault via External Secrets, or Sealed Secrets) in one Kubernetes Secret:

| Key | Value |
| --- | --- |
| `DATABASE_URL` | `postgres://inspectionflow_api:<password>@<host>:5432/inspectionflow?sslmode=require` |
| `DATABASE_ADMIN_URL` | owner connection, used only by the migration job |
| `PAYMENT_WEBHOOK_SECRET` | random, 32+ characters, shared with the payment gateway adapter |
| `STORAGE_SIGNING_SECRET` | random, 32+ characters |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | only without workload identity |
| `SMTP_URL` | `smtps://user:password@email-smtp.me-central-1.amazonaws.com:465` or your relay |
| `INFOBIP_API_KEY` | only with `SMS_DRIVER=infobip` |

## 2. Install

```bash
cp deploy/helm/staging-values.example.yaml staging-values.yaml   # fill in host, issuer, bucket
kubectl create namespace inspectionflow
kubectl -n inspectionflow apply -f <your secret>                 # name = secrets.existingSecret
helm upgrade --install inspectionflow deploy/helm/inspectionflow \
  -n inspectionflow -f staging-values.yaml \
  --set image.api.tag=<git sha> --set image.web.tag=<git sha>
```

Every install and upgrade first runs the migration job (`node apps/api/dist/db/migrate.js`). It takes a database advisory lock, applies new files from `db/migrations` once each, and the release stops if it fails. Rollback of application pods is `helm rollback`; migrations are written expand-then-contract, so the previous version keeps working on the newer schema.

For a demo tenant, run the seed once from a workstation with the owner connection: `DATABASE_ADMIN_URL=… npm run db:seed`. Do not seed production.

## 3. Smoke test after each deploy

1. `GET https://<host>/health` → `{"status":"ok","authMode":"oidc"}`.
2. Sign in on the web with a staff account and with UAE PASS (staging users from the TDRA sandbox).
3. On a phone with the development build: download tasks, switch to airplane mode, complete an inspection with two photos and a signature, reconnect, confirm it syncs.
4. Approve it on the web; within a minute the issued PDF appears under *Issued reports*; open its verification link on a phone.
5. The owner's email receives the payment advice and the letter with the PDF attached; `GET /v1/admin/notifications` shows them `SENT` (SMS waits outside quiet hours, default 22:00–07:00).
6. `GET /v1/audit/verify` as an admin → `ok: true`.

## 4. What is verified automatically

| Check | Where |
| --- | --- |
| Business rules, tenancy, approvals, payments, sync, audit chain | `build-test` job: 35 API tests on PostgreSQL, 27 engine and sync tests |
| S3 presigned upload, checksum enforcement, download | `build-test` job against an S3-compatible server |
| Keycloak realm import, PKCE sign-in, tenant claim and audience, API accepting Keycloak tokens, UAE PASS broker redirect, mobile redirect scheme | `live-services` job with real Keycloak 26 |
| Arabic PDF through Gotenberg with embedded font, photo and QR | `live-services` job with real Gotenberg 8 |
| Images build; chart renders and validates against Kubernetes 1.30 schemas | `images-and-chart` job |

Not yet covered by automation: a real UAE PASS login (needs TDRA sandbox test users), AWS S3 itself (the S3-compatible server stands in), and a full deploy to a cluster.
