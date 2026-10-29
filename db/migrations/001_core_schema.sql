-- ============================================================================
-- InspectionFlow - PostgreSQL schema v2 (target: PostgreSQL 16+ / 17)
-- Revision of postgres_schema.sql (PRD v3.6) applying the 20 fixes listed in
-- "InspectionFlow - Technical Implementation Blueprint", section 4.
--
-- Conventions
--   * Every tenant-owned table has tenant_id NOT NULL and is protected by RLS.
--   * The application connects as role inspectionflow_app (not owner, no BYPASSRLS)
--     and runs  SET LOCAL app.tenant_id = '<uuid from JWT>'  in each transaction.
--   * Primary keys are UUID v7 (time-ordered). Records created offline on the
--     mobile device carry their device-generated UUID v7 as id.
--   * Mutable tables carry row_version for optimistic locking / offline sync.
--   * Money: NUMERIC(14,2) + currency CHAR(3) + VAT fields.
--   * i18n: *_i18n JSONB  {"ar-AE": "...", "en-US": "..."}
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- PostGIS is optional; when present a geography column is added (see end of file).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'postgis') THEN
    CREATE EXTENSION IF NOT EXISTS postgis;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- UUID v7 generator (PostgreSQL 18 ships uuidv7(); this is for 16/17)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  ts_ms  bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
  bytes  bytea  := gen_random_bytes(16);
BEGIN
  bytes := set_byte(bytes, 0, ((ts_ms >> 40) & 255)::int);
  bytes := set_byte(bytes, 1, ((ts_ms >> 32) & 255)::int);
  bytes := set_byte(bytes, 2, ((ts_ms >> 24) & 255)::int);
  bytes := set_byte(bytes, 3, ((ts_ms >> 16) & 255)::int);
  bytes := set_byte(bytes, 4, ((ts_ms >> 8)  & 255)::int);
  bytes := set_byte(bytes, 5, ( ts_ms        & 255)::int);
  bytes := set_byte(bytes, 6, (get_byte(bytes, 6) & 15) | 112);   -- version 7
  bytes := set_byte(bytes, 8, (get_byte(bytes, 8) & 63) | 128);   -- RFC 4122 variant
  RETURN encode(bytes, 'hex')::uuid;
END $$;

-- Current tenant from the session (set by the application per transaction)
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- updated_at / row_version maintenance
CREATE OR REPLACE FUNCTION touch_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at  := now();
  NEW.row_version := COALESCE(OLD.row_version, 0) + 1;
  RETURN NEW;
END $$;

-- ============================================================================
-- 1. TENANCY AND IDENTITY
-- ============================================================================
CREATE TABLE tenants (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  code            text NOT NULL UNIQUE,
  name            text NOT NULL,
  name_i18n       jsonb,
  country         char(2) NOT NULL DEFAULT 'AE',           -- ISO 3166-1 alpha-2
  data_region     text NOT NULL DEFAULT 'AE-1',            -- residency stack
  isolation_level text NOT NULL DEFAULT 'POOLED'
                  CHECK (isolation_level IN ('POOLED','SILO_DB','SILO_DEPLOYMENT')),
  edition         text NOT NULL DEFAULT 'REGULATOR'
                  CHECK (edition IN ('BUSINESS','REGULATOR','SOVEREIGN')),
  default_locale  text NOT NULL DEFAULT 'ar-AE',
  timezone        text NOT NULL DEFAULT 'Asia/Dubai',
  weekend_days    smallint[] NOT NULL DEFAULT '{6,7}',     -- ISO dow: Sat, Sun
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     integer NOT NULL DEFAULT 1
);

CREATE TABLE tenant_settings (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         text NOT NULL,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

-- Fix 5/6/7: per-tenant unique email, UUID keys, role tables instead of a CHECK list
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idp_subject     text,                                    -- Keycloak "sub"
  email           citext NOT NULL,
  display_name    text NOT NULL,
  display_name_i18n jsonb,
  phone           text,
  employee_id     text,
  department      text,
  manager_id      uuid,
  locale          text NOT NULL DEFAULT 'ar-AE',
  is_active       boolean NOT NULL DEFAULT true,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, email),
  UNIQUE (tenant_id, id)
);
ALTER TABLE users ADD CONSTRAINT fk_users_manager
  FOREIGN KEY (tenant_id, manager_id) REFERENCES users(tenant_id, id);

CREATE TABLE permissions (
  code        text PRIMARY KEY,                -- e.g. inspection.submit, finding.override_severity
  module      text NOT NULL,                   -- INSPECT, ENFORCE, COLLECT, PLAN, ENGAGE, CONNECT, INSIGHT, ADMIN
  description text
);

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        text NOT NULL,                   -- INSPECTOR, SENIOR_INSPECTOR, SECTION_MANAGER, COMMITTEE, HELPDESK ...
  name_i18n   jsonb NOT NULL,
  is_system   boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

CREATE TABLE role_permissions (
  tenant_id       uuid NOT NULL,
  role_id         uuid NOT NULL,
  permission_code text NOT NULL REFERENCES permissions(code),
  PRIMARY KEY (tenant_id, role_id, permission_code),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE user_roles (
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  role_id     uuid NOT NULL,
  scope       jsonb,                           -- optional: section / area / process restriction
  PRIMARY KEY (tenant_id, user_id, role_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE teams (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        text NOT NULL,
  name_i18n   jsonb NOT NULL,
  manager_id  uuid NOT NULL,
  group_email citext,                           -- e.g. section mailbox for routine notifications
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, manager_id) REFERENCES users(tenant_id, id)
);

CREATE TABLE team_members (
  tenant_id   uuid NOT NULL,
  team_id     uuid NOT NULL,
  user_id     uuid NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, team_id, user_id),
  FOREIGN KEY (tenant_id, team_id) REFERENCES teams(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);

-- Fix 8: history allowed, no overlapping active delegations
CREATE TABLE user_delegations (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  delegator_id  uuid NOT NULL,
  delegate_id   uuid NOT NULL,
  valid_during  tstzrange NOT NULL,             -- [start, end)
  reason        text,
  scope         jsonb,                          -- null = all tasks; or {"processCodes":[...]}
  is_active     boolean NOT NULL DEFAULT true,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (delegator_id <> delegate_id),
  FOREIGN KEY (tenant_id, delegator_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, delegate_id)  REFERENCES users(tenant_id, id),
  EXCLUDE USING gist (tenant_id WITH =, delegator_id WITH =, valid_during WITH &&) WHERE (is_active)
);

-- Fix 20: device registry for offline sync
CREATE TABLE devices (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL,
  platform        text NOT NULL CHECK (platform IN ('IOS','ANDROID','WEB')),
  app_version     text,
  push_token      text,
  last_sync_at    timestamptz,
  last_sync_cursor bigint,
  is_revoked      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);

-- ============================================================================
-- 2. PARTIES AND INSPECTABLES
-- ============================================================================
CREATE TABLE parties (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('INDIVIDUAL','COMPANY','GOVERNMENT')),
  first_name      text,
  last_name       text,
  company_name    text,
  name_i18n       jsonb,
  email           citext,
  phone           text,
  address         text,
  blocked_status  text NOT NULL DEFAULT 'NONE' CHECK (blocked_status IN ('NONE','FINANCE_BLOCK','ADMIN_BLOCK')),
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  CHECK ((type = 'INDIVIDUAL' AND first_name IS NOT NULL) OR (type <> 'INDIVIDUAL' AND company_name IS NOT NULL))
);

-- Fix 13: identifiers used to match licensing / tax / identity systems
CREATE TABLE party_identifiers (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL,
  party_id        uuid NOT NULL,
  id_type         text NOT NULL,     -- TRADE_LICENSE, CLIENT_ID, TRN, EMIRATES_ID, PASSPORT, IMO, OFFICIAL_NO ...
  id_value_enc    bytea,             -- encrypted when id_type is personal (EMIRATES_ID, PASSPORT)
  id_value_hash   text NOT NULL,     -- HMAC-SHA256 for lookup without decrypting
  id_value_plain  text,              -- only for non-personal identifiers (licence no., TRN)
  issuer          text,              -- issuing authority
  valid_from      date,
  valid_to        date,
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id_type, issuer, id_value_hash)
);

CREATE TABLE party_contacts (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   uuid NOT NULL,
  party_id    uuid NOT NULL,
  name        text NOT NULL,
  role        text,
  email       citext,
  phone       text,
  is_primary  boolean NOT NULL DEFAULT false,
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE inspectable_types (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code            text NOT NULL,
  name_i18n       jsonb NOT NULL,
  attribute_schema jsonb,           -- JSON Schema for inspectable_attributes of this type
  identifier_label_i18n jsonb,      -- e.g. "IMO number", "Facility no."
  is_active       boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

-- Fix 14: hierarchy (development > cluster > building > facility; area > location > berth)
CREATE TABLE inspectables (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type_id         uuid NOT NULL,
  parent_id       uuid,
  path            ltree,            -- maintained by application: root.child.grandchild (ids without dashes)
  identifier      text NOT NULL,
  name            text NOT NULL,
  name_i18n       jsonb,
  address         text,
  latitude        numeric(10,7),
  longitude       numeric(10,7),
  risk_rating     text CHECK (risk_rating IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','SUSPENDED','DEMOLISHED')),
  last_inspected_at timestamptz,
  next_due_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, type_id, identifier),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, type_id)   REFERENCES inspectable_types(tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES inspectables(tenant_id, id)
);

CREATE TABLE inspectable_attributes (
  tenant_id       uuid NOT NULL,
  inspectable_id  uuid NOT NULL,
  attribute_key   text NOT NULL,
  attribute_value jsonb,
  is_searchable   boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, inspectable_id, attribute_key),
  FOREIGN KEY (tenant_id, inspectable_id) REFERENCES inspectables(tenant_id, id) ON DELETE CASCADE
);

-- Fix 4: tenant_id added
CREATE TABLE inspectable_party_links (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL,
  inspectable_id  uuid NOT NULL,
  party_id        uuid NOT NULL,
  role            text NOT NULL,     -- OWNER, OCCUPIER, CONTRACTOR, CONSULTANT, SUBCONTRACTOR, AGENT, BILLING
  is_primary      boolean NOT NULL DEFAULT false,
  valid_from      date,
  valid_to        date,
  added_during_inspection_id uuid,
  added_by        uuid,
  added_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, inspectable_id, party_id, role),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, inspectable_id) REFERENCES inspectables(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, party_id)       REFERENCES parties(tenant_id, id)
);

-- ============================================================================
-- 3. CONFIGURATION (versioned - Fix 17)
-- ============================================================================
CREATE TABLE fee_codes (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code          text NOT NULL,          -- e.g. legacy FnP service code
  name_i18n     jsonb NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('SERVICE_FEE','REINSPECTION_FEE','PENALTY','OTHER')),
  pricing       jsonb NOT NULL,         -- {"type":"FIXED","amount":500} | {"type":"PER_UNIT","param":"HOURS","rate":250}
  vat_rate      numeric(5,4) NOT NULL DEFAULT 0,
  external_code text,                   -- code in the customer's own fee system
  is_active     boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

CREATE TABLE action_master (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        text NOT NULL,     -- NONE, COMMENT, NOTICE, WARNING, FINAL_WARNING, PENALTY, DOUBLE_PENALTY, SUSPENSION, ATTENDANCE, LICENCE_REMARK
  name_i18n   jsonb NOT NULL,
  rank        smallint NOT NULL, -- severity order; highest rank decides inspection category
  closes_log  boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

CREATE TABLE inspection_processes (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code            text NOT NULL,
  version         integer NOT NULL DEFAULT 1,
  name_i18n       jsonb NOT NULL,
  billing_type    text NOT NULL DEFAULT 'ROUTINE' CHECK (billing_type IN ('ROUTINE','SERVICE')),
  allowed_kinds   text[] NOT NULL DEFAULT '{SCHEDULED,RANDOM,FOLLOW_UP}', -- + SERVICE, MANAGEMENT_ORDER, COMPLAINT
  repetition_strategy text NOT NULL DEFAULT 'INSPECTABLE' CHECK (repetition_strategy IN
                  ('INSPECTABLE','PARTY','INSPECTABLE_AND_PARTY','INSPECTABLE_PER_YEAR',
                   'PARTY_PER_YEAR','INSPECTABLE_AND_PARTY_PER_YEAR','NONE')),
  billing_party_role text,               -- static role, or NULL = inspector chooses
  service_fee_code_id     uuid,
  reinspection_fee_code_id uuid,
  workflow_key    text NOT NULL,         -- BPMN process definition key
  one_open_log_per_inspectable boolean NOT NULL DEFAULT true,
  routine_interval_days integer,         -- e.g. 30 for construction-safety routine notifications
  settings        jsonb,                 -- reminders, KPIs, numbering format, etc.
  effective_from  timestamptz NOT NULL DEFAULT now(),
  effective_to    timestamptz,
  UNIQUE (tenant_id, code, version),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, service_fee_code_id)      REFERENCES fee_codes(tenant_id, id),
  FOREIGN KEY (tenant_id, reinspection_fee_code_id) REFERENCES fee_codes(tenant_id, id)
);

CREATE TABLE checklists (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  process_id      uuid NOT NULL,
  inspectable_type_id uuid,              -- checklist per facility type (Marine Facility BRS)
  code            text NOT NULL,
  version         integer NOT NULL DEFAULT 1,
  name_i18n       jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','RETIRED')),
  effective_from  timestamptz,
  effective_to    timestamptz,
  UNIQUE (tenant_id, code, version),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, process_id)          REFERENCES inspection_processes(tenant_id, id),
  FOREIGN KEY (tenant_id, inspectable_type_id) REFERENCES inspectable_types(tenant_id, id)
);

CREATE TABLE checklist_sections (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     uuid NOT NULL,
  checklist_id  uuid NOT NULL,
  code          text NOT NULL,
  name_i18n     jsonb NOT NULL,
  order_num     integer NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, checklist_id) REFERENCES checklists(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE checklist_items (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     uuid NOT NULL,
  section_id    uuid NOT NULL,
  code          text NOT NULL,
  label_i18n    jsonb NOT NULL,
  field_type    text NOT NULL CHECK (field_type IN ('YES_NO_NA','TEXT','NUMBER','DATE','SELECT','MULTI_SELECT','PHOTO','SIGNATURE','MEASUREMENT')),
  options       jsonb,
  validation    jsonb,                  -- min/max/regex/required photos
  is_required   boolean NOT NULL DEFAULT true,
  order_num     integer NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, section_id) REFERENCES checklist_sections(tenant_id, id) ON DELETE CASCADE
);

-- Fix 10: typed violation rules + occurrence ladder (replaces comment_templates/comment_configs JSONB)
CREATE TABLE violation_templates (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code            text NOT NULL,          -- business code, e.g. V0001 / OC
  version         integer NOT NULL DEFAULT 1,
  process_id      uuid,                   -- NULL = usable by all processes
  category        text,                   -- section grouping on reports
  description_i18n jsonb NOT NULL,
  regulation_ref  text,                   -- applicable regulation / link
  default_severity text NOT NULL CHECK (default_severity IN ('MINOR','MAJOR','CRITICAL')),
  parameters      jsonb,                  -- [{"code":"OCCUPANTS","type":"NUMBER","min":0}]
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
  effective_from  timestamptz NOT NULL DEFAULT now(),
  effective_to    timestamptz,
  UNIQUE (tenant_id, code, version),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, process_id) REFERENCES inspection_processes(tenant_id, id)
);

CREATE TABLE violation_rules (
  tenant_id             uuid NOT NULL,
  violation_template_id uuid NOT NULL,
  repetition_strategy   text,             -- NULL = inherit from process
  repeat_window_days    integer,          -- e.g. 365; NULL = unlimited
  reset_policy          text NOT NULL DEFAULT 'NONE' CHECK (reset_policy IN ('NONE','CALENDAR_YEAR','ROLLING_WINDOW')),
  fine_mode             text NOT NULL DEFAULT 'LADDER' CHECK (fine_mode IN ('LADDER','MULTIPLIER')),
  base_fine             numeric(14,2),
  fine_multiplier       numeric(6,3),     -- final = base * multiplier^(n-1)
  fine_cap              numeric(14,2),
  follow_up_days        jsonb NOT NULL DEFAULT '{"MINOR":7,"MAJOR":3,"CRITICAL":0}',
  calendar_days         boolean NOT NULL DEFAULT true,   -- false = working days (tenant weekend)
  severity_override     text NOT NULL DEFAULT 'WITH_APPROVAL' CHECK (severity_override IN ('NOT_ALLOWED','WITH_APPROVAL','ALLOWED')),
  PRIMARY KEY (tenant_id, violation_template_id),
  FOREIGN KEY (tenant_id, violation_template_id) REFERENCES violation_templates(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE violation_action_ladder (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id             uuid NOT NULL,
  violation_template_id uuid NOT NULL,
  from_occurrence       integer NOT NULL CHECK (from_occurrence >= 1),
  to_occurrence         integer,          -- NULL = and above
  action_id             uuid NOT NULL,
  severity              text NOT NULL CHECK (severity IN ('MINOR','MAJOR','CRITICAL')),
  fee_code_id           uuid,
  fine_amount           numeric(14,2),
  requires_manager_review   boolean NOT NULL DEFAULT false,
  requires_committee_review boolean NOT NULL DEFAULT false,
  suspension_days       integer,
  FOREIGN KEY (tenant_id, violation_template_id) REFERENCES violation_templates(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, action_id)   REFERENCES action_master(tenant_id, id),
  FOREIGN KEY (tenant_id, fee_code_id) REFERENCES fee_codes(tenant_id, id),
  CHECK (to_occurrence IS NULL OR to_occurrence >= from_occurrence)
);

CREATE TABLE checklist_rules (            -- answer -> auto-raised finding
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id             uuid NOT NULL,
  checklist_item_id     uuid NOT NULL,
  violation_template_id uuid NOT NULL,
  condition_json        jsonb NOT NULL,   -- JSONLogic, e.g. {"==":[{"var":"answer"},"NO"]}
  auto_create           boolean NOT NULL DEFAULT true,
  FOREIGN KEY (tenant_id, checklist_item_id)     REFERENCES checklist_items(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, violation_template_id) REFERENCES violation_templates(tenant_id, id)
);

CREATE TABLE approval_thresholds (        -- committee / director / CEO by amount (construction-safety and incident rules)
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  process_id    uuid,
  min_amount    numeric(14,2) NOT NULL,
  max_amount    numeric(14,2),
  approval_chain text[] NOT NULL,         -- role codes in order, e.g. {SECTION_MANAGER,DIRECTOR,CEO}
  FOREIGN KEY (tenant_id, process_id) REFERENCES inspection_processes(tenant_id, id)
);

CREATE TABLE letter_templates (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        text NOT NULL,             -- INSPECTION_REPORT, WARNING, NOTICE, PENALTY, FIR, SVR, PERMIT ...
  version     integer NOT NULL DEFAULT 1,
  locale      text NOT NULL,
  engine      text NOT NULL DEFAULT 'HTML' CHECK (engine IN ('HTML','DOCX')),
  body        text NOT NULL,
  numbering_format text,                 -- e.g. 'TKS-NCR/{facility}/{yyyy}/{seq}-{reissue}'
  UNIQUE (tenant_id, code, version, locale)
);

-- ============================================================================
-- 4. OPERATIONS
-- ============================================================================
CREATE TABLE schedules (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  inspectable_id  uuid NOT NULL,
  process_id      uuid NOT NULL,
  due_at          timestamptz NOT NULL,
  recurrence_rule text,                  -- RFC 5545 RRULE
  assigned_team_id uuid,
  assigned_to     uuid,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','NOTIFIED','IN_PROGRESS','COMPLETED','SKIPPED','CANCELLED','OVERDUE')),
  completed_inspection_id uuid,
  kpi_due_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, inspectable_id, process_id, due_at),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, inspectable_id) REFERENCES inspectables(tenant_id, id),
  FOREIGN KEY (tenant_id, process_id)     REFERENCES inspection_processes(tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_to)    REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_team_id) REFERENCES teams(tenant_id, id)
);

-- Fix 12: "log" with status; one open log per inspectable + process
CREATE TABLE inspection_logs (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  log_number      text NOT NULL,
  inspectable_id  uuid NOT NULL,
  process_id      uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('SCHEDULED','RANDOM','SERVICE','FOLLOW_UP','MANAGEMENT_ORDER','COMPLAINT')),
  schedule_id     uuid,
  external_request_ref text,             -- service request / application id in a vertical system
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PENDING_CLIENT','PENDING_PAYMENT','CLOSED','CANCELLED')),
  opened_at       timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  owner_id        uuid,                  -- log owner (manager)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, log_number),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, inspectable_id) REFERENCES inspectables(tenant_id, id),
  FOREIGN KEY (tenant_id, process_id)     REFERENCES inspection_processes(tenant_id, id),
  FOREIGN KEY (tenant_id, schedule_id)    REFERENCES schedules(tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id)       REFERENCES users(tenant_id, id)
);
CREATE UNIQUE INDEX uq_one_open_log ON inspection_logs (tenant_id, inspectable_id, process_id)
  WHERE status IN ('OPEN','PENDING_CLIENT','PENDING_PAYMENT') AND kind NOT IN ('RANDOM','MANAGEMENT_ORDER');

-- Fix 2/6/9: created in order; device-generated UUID v7; multi-decision
CREATE TABLE inspections (
  id              uuid PRIMARY KEY,      -- UUID v7, generated on device when offline
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  log_id          uuid NOT NULL,
  cycle_number    integer NOT NULL,
  inspection_type text NOT NULL DEFAULT 'PHYSICAL' CHECK (inspection_type IN ('PHYSICAL','DOCUMENT_VERIFICATION','REMOTE')),
  checklist_id    uuid,                  -- exact version used (Fix 17)
  performed_by    uuid NOT NULL,
  co_inspectors   uuid[],
  started_at      timestamptz,
  completed_at    timestamptz,
  latitude        numeric(10,7),
  longitude       numeric(10,7),
  category        text CHECK (category IN ('NO_FINDINGS','MINOR','WARNING','PENALTY_CRITICAL')),
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN
                  ('DRAFT','SUBMITTED','UNDER_REVIEW','MORE_INFO','COMMITTEE_REVIEW','APPROVED','REJECTED','CANCELLED','CLOSED')),
  general_remarks text,
  site_status     text,
  is_signed       boolean NOT NULL DEFAULT false,
  edit_locked     boolean NOT NULL DEFAULT false,
  client_mutation_id uuid,               -- Fix 20: idempotency key from device
  device_id       uuid REFERENCES devices(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  row_version     integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, log_id, cycle_number),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, client_mutation_id),
  FOREIGN KEY (tenant_id, log_id)       REFERENCES inspection_logs(tenant_id, id),
  FOREIGN KEY (tenant_id, checklist_id) REFERENCES checklists(tenant_id, id),
  FOREIGN KEY (tenant_id, performed_by) REFERENCES users(tenant_id, id)
);

ALTER TABLE schedules ADD CONSTRAINT fk_schedules_completed_inspection
  FOREIGN KEY (tenant_id, completed_inspection_id) REFERENCES inspections(tenant_id, id);

CREATE TABLE inspection_decisions (
  tenant_id     uuid NOT NULL,
  inspection_id uuid NOT NULL,
  action_id     uuid NOT NULL,
  decided_by    uuid NOT NULL,
  decided_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, inspection_id, action_id),
  FOREIGN KEY (tenant_id, inspection_id) REFERENCES inspections(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, action_id)     REFERENCES action_master(tenant_id, id)
);

CREATE TABLE inspection_checklist_responses (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  inspection_id     uuid NOT NULL,
  checklist_item_id uuid NOT NULL,
  response_value    jsonb,
  responded_by      uuid,
  responded_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, inspection_id, checklist_item_id),
  FOREIGN KEY (tenant_id, inspection_id)     REFERENCES inspections(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, checklist_item_id) REFERENCES checklist_items(tenant_id, id)
);

-- Findings (was inspection_comments). Typed money (Fix 15).
CREATE TABLE inspection_findings (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL,
  log_id                uuid NOT NULL,
  inspection_id         uuid NOT NULL,
  violation_template_id uuid NOT NULL,
  carried_from_id       uuid,              -- same violation carried forward from an earlier cycle
  parameters            jsonb,             -- values for template parameters
  remarks               text,
  calculated_occurrence integer,
  approved_occurrence   integer,
  calculated_action_id  uuid,
  final_action_id       uuid,
  calculated_severity   text CHECK (calculated_severity IN ('MINOR','MAJOR','CRITICAL')),
  final_severity        text CHECK (final_severity IN ('MINOR','MAJOR','CRITICAL')),
  override_reason       text,
  override_status       text CHECK (override_status IN ('NONE','PENDING','APPROVED','REJECTED')) DEFAULT 'NONE',
  fine_amount           numeric(14,2),
  currency              char(3) NOT NULL DEFAULT 'AED',
  responsible_party_link_ids uuid[],       -- one or more penalised parties
  status                text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLIENT_REPLIED','RESOLVED','NOT_RESOLVED','CLOSED','APPEALED','CANCELLED')),
  resolve_by            timestamptz,
  resolved_at           timestamptz,
  resolved_by           uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  row_version           integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, log_id)                REFERENCES inspection_logs(tenant_id, id),
  FOREIGN KEY (tenant_id, inspection_id)         REFERENCES inspections(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, violation_template_id) REFERENCES violation_templates(tenant_id, id),
  FOREIGN KEY (tenant_id, carried_from_id)       REFERENCES inspection_findings(tenant_id, id),
  FOREIGN KEY (tenant_id, calculated_action_id)  REFERENCES action_master(tenant_id, id),
  FOREIGN KEY (tenant_id, final_action_id)       REFERENCES action_master(tenant_id, id)
);
-- A violation code appears at most once per inspection (BRS rule)
CREATE UNIQUE INDEX uq_finding_once_per_inspection ON inspection_findings (tenant_id, inspection_id, violation_template_id);

-- Fix 11: occurrence ledger, keyed by repetition scope
CREATE TABLE violation_occurrences (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id             uuid NOT NULL,
  violation_code        text NOT NULL,     -- counted by business code across template versions
  scope_type            text NOT NULL CHECK (scope_type IN ('INSPECTABLE','PARTY','INSPECTABLE_AND_PARTY')),
  inspectable_id        uuid,
  party_id              uuid,
  period_key            text NOT NULL DEFAULT 'ALL',  -- 'ALL' or '2027' for per-year strategies
  finding_id            uuid NOT NULL,
  occurred_at           timestamptz NOT NULL,
  occurrence_no         integer NOT NULL,
  is_counted            boolean NOT NULL DEFAULT true, -- false when a manager-approved demotion removes it
  created_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, finding_id) REFERENCES inspection_findings(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_occ_lookup ON violation_occurrences
  (tenant_id, violation_code, scope_type, inspectable_id, party_id, period_key, occurred_at DESC) WHERE is_counted;

CREATE TABLE tasks (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL,
  task_type       text NOT NULL,          -- INSPECT, REVIEW, COMMITTEE, MORE_INFO, PAYMENT_FOLLOW_UP, CLOSE_OUT ...
  workflow_instance_id text,              -- Flowable process instance
  workflow_task_id text,                  -- Flowable task id
  log_id          uuid,
  inspection_id   uuid,
  assignee_id     uuid,                   -- resolved after delegation
  original_assignee_id uuid,              -- before delegation
  candidate_role  text,
  candidate_team_id uuid,
  priority        smallint NOT NULL DEFAULT 3,
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLAIMED','IN_PROGRESS','COMPLETED','CANCELLED')),
  due_at          timestamptz,
  form_key        text,
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, log_id)        REFERENCES inspection_logs(tenant_id, id),
  FOREIGN KEY (tenant_id, inspection_id) REFERENCES inspections(tenant_id, id),
  FOREIGN KEY (tenant_id, assignee_id)   REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, candidate_team_id) REFERENCES teams(tenant_id, id)
);

CREATE TABLE approvals (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     uuid NOT NULL,
  subject_type  text NOT NULL,            -- INSPECTION, FINDING_OVERRIDE, PENALTY_CANCEL, SIGNATURE_CLEAR ...
  subject_id    uuid NOT NULL,
  step_no       smallint NOT NULL,
  approver_role text NOT NULL,
  approver_id   uuid,
  decision      text CHECK (decision IN ('APPROVED','REJECTED','MORE_INFO')),
  comment       text,
  decided_at    timestamptz,
  FOREIGN KEY (tenant_id, approver_id) REFERENCES users(tenant_id, id)
);

-- Fix 18: evidential signature record
CREATE TABLE client_signatures (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  inspection_id       uuid NOT NULL,
  method              text NOT NULL CHECK (method IN ('CANVAS','UAE_PASS','UPLOAD','REFUSED')),
  signer_name         text NOT NULL,
  signer_role         text,
  signer_party_id     uuid,
  signer_id_hash      text,               -- HMAC of Emirates ID if captured
  uaepass_reference   text,
  signature_document_id uuid,             -- image or signed PDF in documents
  signature_sha256    text,
  signed_payload_sha256 text NOT NULL,    -- hash of the inspection content that was signed
  device_id           uuid,
  latitude            numeric(10,7),
  longitude           numeric(10,7),
  signed_at           timestamptz NOT NULL DEFAULT now(),
  cleared_by          uuid,
  cleared_at          timestamptz,
  clear_reason        text,
  FOREIGN KEY (tenant_id, inspection_id)   REFERENCES inspections(tenant_id, id),
  FOREIGN KEY (tenant_id, signer_party_id) REFERENCES parties(tenant_id, id),
  CHECK (cleared_at IS NULL OR (cleared_by IS NOT NULL AND clear_reason IS NOT NULL))
);

CREATE TABLE finding_replies (           -- client response via portal (was inspection_comment_replies)
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     uuid NOT NULL,
  finding_id    uuid NOT NULL,
  replied_by_party_id uuid,
  replied_by_portal_user text,
  reply_text    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, finding_id) REFERENCES inspection_findings(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE objections (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     uuid NOT NULL,
  finding_id    uuid NOT NULL,
  party_id      uuid NOT NULL,
  grounds       text NOT NULL,
  status        text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','UNDER_REVIEW','ACCEPTED','PARTIALLY_ACCEPTED','REJECTED')),
  decision_note text,
  decided_by    uuid,
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  FOREIGN KEY (tenant_id, finding_id) REFERENCES inspection_findings(tenant_id, id),
  FOREIGN KEY (tenant_id, party_id)   REFERENCES parties(tenant_id, id)
);

CREATE TABLE corrective_actions (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     uuid NOT NULL,
  finding_id    uuid NOT NULL,
  description   text NOT NULL,
  due_at        timestamptz,
  status        text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','ACCEPTED','RETURNED')),
  reviewed_by   uuid,
  reviewed_at   timestamptz,
  FOREIGN KEY (tenant_id, finding_id) REFERENCES inspection_findings(tenant_id, id)
);

CREATE TABLE client_feedback (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     uuid NOT NULL,
  inspection_id uuid NOT NULL,
  nps_score     smallint CHECK (nps_score BETWEEN 0 AND 10),
  csat_score    smallint CHECK (csat_score BETWEEN 1 AND 5),
  comment       text,
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, inspection_id) REFERENCES inspections(tenant_id, id)
);

-- ============================================================================
-- 5. MONEY (Fix 1, 15, 16)
-- ============================================================================
CREATE TABLE payment_advices (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL,
  pa_number       text NOT NULL,
  log_id          uuid,
  inspection_id   uuid,
  party_id        uuid NOT NULL,          -- Fix 1: parties, not the missing "clients" table
  kind            text NOT NULL CHECK (kind IN ('SERVICE_FEE','REINSPECTION_FEE','PENALTY','MIXED')),
  amount          numeric(14,2) NOT NULL,
  vat_amount      numeric(14,2) NOT NULL DEFAULT 0,
  currency        char(3) NOT NULL DEFAULT 'AED',
  status          text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('DRAFT','ISSUED','BLOCKED_PREPAID','PAID','PARTIAL','OVERDUE','CANCELLED','WAIVED')),
  billing_mode    text NOT NULL DEFAULT 'NATIVE' CHECK (billing_mode IN ('NATIVE','EXTERNAL')),
  external_ref    text,                   -- id in the customer's own fee system (e.g. FnP)
  due_at          timestamptz,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  paid_at         timestamptz,
  UNIQUE (tenant_id, pa_number),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, log_id)        REFERENCES inspection_logs(tenant_id, id),
  FOREIGN KEY (tenant_id, inspection_id) REFERENCES inspections(tenant_id, id),
  FOREIGN KEY (tenant_id, party_id)      REFERENCES parties(tenant_id, id)
);

CREATE TABLE invoices (                    -- native tax invoices (Business edition, SaaS customers)
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL,
  invoice_number  text NOT NULL,
  payment_advice_id uuid,
  party_id        uuid NOT NULL,
  invoice_date    date NOT NULL DEFAULT current_date,
  due_date        date,
  subtotal        numeric(14,2) NOT NULL DEFAULT 0,
  vat_amount      numeric(14,2) NOT NULL DEFAULT 0,
  total_amount    numeric(14,2) NOT NULL DEFAULT 0,
  currency        char(3) NOT NULL DEFAULT 'AED',
  einvoice_status text CHECK (einvoice_status IN ('NOT_REQUIRED','PENDING','SUBMITTED','ACCEPTED','REJECTED')),
  einvoice_ref    text,                   -- ASP / Peppol message id
  status          text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('DRAFT','ISSUED','PAID','PARTIAL','OVERDUE','CANCELLED','CREDITED')),
  pdf_document_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, invoice_number),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, payment_advice_id) REFERENCES payment_advices(tenant_id, id),
  FOREIGN KEY (tenant_id, party_id)          REFERENCES parties(tenant_id, id)
);

CREATE TABLE invoice_lines (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     uuid NOT NULL,
  invoice_id    uuid NOT NULL,
  line_type     text NOT NULL CHECK (line_type IN ('SERVICE_FEE','REINSPECTION_FEE','VIOLATION_FINE','OTHER')),
  fee_code_id   uuid,
  finding_id    uuid,
  description   text NOT NULL,
  quantity      numeric(10,3) NOT NULL DEFAULT 1,
  unit_price    numeric(14,2) NOT NULL,
  vat_rate      numeric(5,4) NOT NULL DEFAULT 0,
  vat_amount    numeric(14,2) NOT NULL DEFAULT 0,
  line_total    numeric(14,2) NOT NULL,
  FOREIGN KEY (tenant_id, invoice_id)  REFERENCES invoices(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, fee_code_id) REFERENCES fee_codes(tenant_id, id),
  FOREIGN KEY (tenant_id, finding_id)  REFERENCES inspection_findings(tenant_id, id)
);

CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL,
  payment_advice_id uuid NOT NULL,
  amount          numeric(14,2) NOT NULL,
  currency        char(3) NOT NULL DEFAULT 'AED',
  gateway         text NOT NULL,          -- PAYTABS, CHECKOUT, NETWORK_INTL, STRIPE, GOV_GATEWAY, BANK_TRANSFER, PREPAID
  gateway_txn_id  text,
  idempotency_key text NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','AUTHORISED','CAPTURED','FAILED','REFUNDED','PARTIALLY_REFUNDED')),
  failure_reason  text,
  processed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (gateway, gateway_txn_id),
  FOREIGN KEY (tenant_id, payment_advice_id) REFERENCES payment_advices(tenant_id, id)
);

-- ============================================================================
-- 6. DOCUMENTS AND REPORTS
-- ============================================================================
CREATE TABLE documents (
  id            uuid PRIMARY KEY,         -- device-generated for offline evidence
  tenant_id     uuid NOT NULL,
  owner_type    text NOT NULL,            -- INSPECTION, FINDING, REPLY, SIGNATURE, INVOICE, REPORT, INSPECTABLE
  owner_id      uuid NOT NULL,
  doc_type      text NOT NULL CHECK (doc_type IN ('PHOTO','VIDEO','AUDIO','PDF','SIGNATURE','OTHER')),
  category      text,                     -- violation_photo, evidence, report ...
  file_name     text,
  mime_type     text,
  current_version integer NOT NULL DEFAULT 1,
  retention_class text NOT NULL DEFAULT 'STANDARD_5Y',
  legal_hold    boolean NOT NULL DEFAULT false,
  uploaded_by   uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX ix_documents_owner ON documents (tenant_id, owner_type, owner_id);

CREATE TABLE document_versions (
  tenant_id     uuid NOT NULL,
  document_id   uuid NOT NULL,
  version_no    integer NOT NULL,
  s3_bucket     text NOT NULL,
  s3_key        text NOT NULL,            -- t/{tenantId}/{ownerType}/{ownerId}/{documentId}/{version}
  s3_version_id text,
  size_bytes    bigint,
  sha256        text NOT NULL,
  captured_at   timestamptz,              -- EXIF / device time
  latitude      numeric(10,7),
  longitude     numeric(10,7),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_id, version_no),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE generated_reports (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     uuid NOT NULL,
  template_code text NOT NULL,
  subject_type  text NOT NULL,
  subject_id    uuid NOT NULL,
  report_number text,
  reissue_no    integer NOT NULL DEFAULT 0,
  locale        text NOT NULL,
  document_id   uuid NOT NULL,
  verification_code text,                 -- QR verification token
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, id)
);

-- ============================================================================
-- 7. PLATFORM: notifications, audit, outbox, sync, CRM
-- ============================================================================
CREATE TABLE notifications (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     uuid NOT NULL,
  recipient_type text NOT NULL CHECK (recipient_type IN ('USER','PARTY','TEAM','EMAIL')),
  recipient_id  uuid,
  recipient_address text,
  channel       text NOT NULL CHECK (channel IN ('EMAIL','SMS','PUSH','IN_APP','WHATSAPP')),
  template_code text NOT NULL,
  payload       jsonb,
  entity_type   text,
  entity_id     uuid,
  status        text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENT','DELIVERED','FAILED','READ')),
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_notifications_due ON notifications (status, scheduled_for);

-- Fix 19: append-only, partitioned, hash-chained audit
CREATE TABLE audit_logs (
  id            uuid NOT NULL DEFAULT uuid_generate_v7(),
  tenant_id     uuid NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_type    text NOT NULL CHECK (actor_type IN ('USER','PARTY','SYSTEM','INTEGRATION')),
  actor_id      uuid,
  on_behalf_of  uuid,                     -- delegation
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     uuid,
  old_value     jsonb,
  new_value     jsonb,
  ip_address    inet,
  user_agent    text,
  device_id     uuid,
  request_id    text,
  prev_hash     text,
  row_hash      text NOT NULL,            -- sha256(prev_hash || canonical row) computed by the app
  PRIMARY KEY (tenant_id, occurred_at, id)
) PARTITION BY RANGE (occurred_at);
CREATE TABLE audit_logs_2026_11 PARTITION OF audit_logs FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE audit_logs_2026_12 PARTITION OF audit_logs FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;
CREATE INDEX ix_audit_entity ON audit_logs (tenant_id, entity_type, entity_id);

CREATE TABLE outbox (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     uuid NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id  uuid NOT NULL,
  event_type    text NOT NULL,            -- inspection.closed, finding.created, payment.captured ...
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PUBLISHED','FAILED','DEAD')),
  attempts      integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);
CREATE INDEX ix_outbox_pending ON outbox (status, next_attempt_at) WHERE status IN ('PENDING','FAILED');

CREATE TABLE sync_batches (
  id              uuid PRIMARY KEY,         -- generated on device
  tenant_id       uuid NOT NULL,
  device_id       uuid NOT NULL REFERENCES devices(id),
  user_id         uuid NOT NULL,
  direction       text NOT NULL CHECK (direction IN ('PUSH','PULL')),
  mutation_count  integer NOT NULL DEFAULT 0,
  status          text NOT NULL CHECK (status IN ('RECEIVED','APPLIED','PARTIAL','FAILED')),
  server_cursor   bigint,
  received_at     timestamptz NOT NULL DEFAULT now(),
  applied_at      timestamptz
);

CREATE TABLE sync_conflicts (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL,
  batch_id        uuid NOT NULL REFERENCES sync_batches(id),
  entity_type     text NOT NULL,
  entity_id       uuid NOT NULL,
  client_version  integer,
  server_version  integer,
  conflict_type   text NOT NULL,           -- STALE_UPDATE, OPEN_LOG_EXISTS, TASK_REASSIGNED, MASTER_DATA_RETIRED
  client_payload  jsonb,
  resolution      text CHECK (resolution IN ('SERVER_WINS','CLIENT_WINS','MERGED','MANUAL')),
  resolved_by     uuid,
  resolved_at     timestamptz
);

CREATE TABLE crm_connections (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('HUBSPOT','SALESFORCE','ZOHO','DYNAMICS','CUSTOM')),
  auth_ref      text NOT NULL,             -- pointer to secret in vault, never the token itself
  base_url      text,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','ERROR')),
  settings      jsonb,
  UNIQUE (tenant_id, provider)
);

CREATE TABLE crm_field_maps (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES crm_connections(id) ON DELETE CASCADE,
  local_entity  text NOT NULL,             -- PARTY, INSPECTABLE, INSPECTION, PAYMENT_ADVICE, PAYMENT
  remote_object text NOT NULL,             -- Contact, Company, Deal, Activity, Custom object ...
  field_map     jsonb NOT NULL,
  direction     text NOT NULL DEFAULT 'OUTBOUND' CHECK (direction IN ('OUTBOUND','INBOUND','BIDIRECTIONAL'))
);

CREATE TABLE external_refs (
  tenant_id     uuid NOT NULL,
  system        text NOT NULL,             -- HUBSPOT, SALESFORCE, ZOHO, LICENSING, FNP, GIS ...
  local_entity  text NOT NULL,
  local_id      uuid NOT NULL,
  remote_id     text NOT NULL,
  last_synced_at timestamptz,
  last_hash     text,                      -- detect no-op updates
  PRIMARY KEY (tenant_id, system, local_entity, local_id),
  UNIQUE (tenant_id, system, local_entity, remote_id)
);

-- ============================================================================
-- 8. TRIGGERS (updated_at / row_version)
-- ============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants','users','parties','inspectables','inspection_logs',
                           'inspections','inspection_findings','tasks']
  LOOP
    EXECUTE format('CREATE TRIGGER trg_%s_touch BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_row()', t, t);
  END LOOP;
END $$;

-- ============================================================================
-- 9. INDEXES FOR HOT PATHS
-- ============================================================================
CREATE INDEX ix_tasks_inbox       ON tasks (tenant_id, assignee_id, status, due_at);
CREATE INDEX ix_tasks_team        ON tasks (tenant_id, candidate_team_id, status) WHERE assignee_id IS NULL;
CREATE INDEX ix_inspections_log   ON inspections (tenant_id, log_id, cycle_number);
CREATE INDEX ix_inspections_user  ON inspections (tenant_id, performed_by, status);
CREATE INDEX ix_findings_open     ON inspection_findings (tenant_id, log_id) WHERE status IN ('OPEN','CLIENT_REPLIED','NOT_RESOLVED');
CREATE INDEX ix_findings_due      ON inspection_findings (tenant_id, resolve_by) WHERE status = 'OPEN';
CREATE INDEX ix_schedules_due     ON schedules (tenant_id, status, due_at);
CREATE INDEX ix_pa_party_status   ON payment_advices (tenant_id, party_id, status);
CREATE INDEX ix_inspectables_path ON inspectables USING gist (path);
CREATE INDEX ix_inspectables_name ON inspectables (tenant_id, lower(name));
CREATE INDEX ix_party_company     ON parties (tenant_id, lower(company_name));

-- Optional PostGIS location column
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    EXECUTE 'ALTER TABLE inspectables ADD COLUMN geo geography(Point,4326)';
    EXECUTE 'CREATE INDEX ix_inspectables_geo ON inspectables USING gist (geo)';
  END IF;
END $$;

-- ============================================================================
-- 10. ROW-LEVEL SECURITY (Fix 3/4)
-- Every table with a tenant_id column gets ENABLE + FORCE RLS and one policy.
-- ============================================================================
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
    WHERE n.nspname = current_schema()
      AND c.relkind IN ('r','p')
      AND NOT c.relispartition
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.relname);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.relname);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', r.relname);
  END LOOP;
END $$;

-- tenants table itself: a tenant can see only its own row
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants USING (id = current_tenant_id());

-- ============================================================================
-- 11. APPLICATION ROLE AND GRANTS
-- ============================================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inspectionflow_app') THEN
    CREATE ROLE inspectionflow_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO inspectionflow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO inspectionflow_app;
-- audit log is append-only for the application
REVOKE UPDATE, DELETE ON audit_logs FROM inspectionflow_app;
GRANT SELECT ON permissions TO inspectionflow_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO inspectionflow_app;

-- ============================================================================
-- 12. SEED: system permissions (excerpt)
-- ============================================================================
INSERT INTO permissions (code, module, description) VALUES
 ('inspection.create',          'INSPECT', 'Create inspections and logs on site'),
 ('inspection.submit',          'INSPECT', 'Submit an inspection'),
 ('inspection.review',          'ENFORCE', 'Review and approve inspections'),
 ('finding.override_severity',  'ENFORCE', 'Escalate or de-escalate a calculated severity'),
 ('finding.approve_override',   'ENFORCE', 'Approve a severity override'),
 ('penalty.committee_approve',  'ENFORCE', 'Approve penalties in committee'),
 ('penalty.cancel',             'COLLECT', 'Cancel or waive a payment advice'),
 ('signature.clear',            'INSPECT', 'Clear a client signature with reason'),
 ('task.reassign',              'PLAN',    'Reassign tasks, including bulk'),
 ('delegation.manage',          'PLAN',    'Create delegations for team members'),
 ('config.manage',              'ADMIN',   'Manage checklists, violations, fees and workflows'),
 ('crm.manage',                 'CONNECT', 'Manage CRM connections and mappings'),
 ('report.view',                'INSIGHT', 'View dashboards and reports');
