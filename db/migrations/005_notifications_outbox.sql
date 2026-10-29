-- ============================================================================
-- 005 - Notification delivery, outbox relay (webhooks) and per-tenant templates
-- ============================================================================

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_status_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_status_check
    CHECK (status IN ('QUEUED','SENDING','SENT','DELIVERED','FAILED','SKIPPED','READ')),
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN last_error text,
  ADD COLUMN locale text,
  ADD COLUMN delivered_to text,              -- address actually used (masked in the UI)
  ADD COLUMN provider_message_id text,
  ADD COLUMN locked_at timestamptz;
CREATE INDEX IF NOT EXISTS ix_notifications_inbox ON notifications (tenant_id, recipient_type, recipient_id, channel, created_at DESC);

-- Tenant overrides of the built-in bilingual templates (Configuration Studio edits these).
CREATE TABLE notification_templates (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        text NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('EMAIL','SMS','PUSH','IN_APP','WHATSAPP')),
  locale      text NOT NULL,
  subject     text,
  body        text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, code, channel, locale)
);

-- Outbox consumers: signed webhooks to the tenant's systems (CRM, ERP, fee system).
CREATE TABLE webhook_subscriptions (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  url         text NOT NULL CHECK (url ~ '^https?://'),
  secret      text NOT NULL,
  event_types text[] NOT NULL DEFAULT '{*}',
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL,
  subscription_id uuid NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  outbox_id       uuid NOT NULL REFERENCES outbox(id) ON DELETE CASCADE,
  status          text NOT NULL CHECK (status IN ('DELIVERED','FAILED')),
  http_status     integer,
  error           text,
  attempted_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_webhook_deliveries_outbox ON webhook_deliveries (tenant_id, outbox_id);

ALTER TABLE outbox ADD COLUMN locked_at timestamptz;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification_templates','webhook_subscriptions','webhook_deliveries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO inspectionflow_app', t);
  END LOOP;
END $$;

-- Job claims across tenants (ids only; each job is then processed inside its tenant's RLS context).
CREATE OR REPLACE FUNCTION claim_notifications(p_limit integer DEFAULT 20)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE notifications n SET status = 'SENDING', locked_at = now(), attempts = n.attempts + 1
   WHERE n.id IN (
     SELECT x.id FROM notifications x
      WHERE ((x.status = 'QUEUED' AND x.scheduled_for <= now())
          OR (x.status = 'SENDING' AND x.locked_at < now() - interval '10 minutes'))
      ORDER BY x.scheduled_for
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED)
  RETURNING n.id, n.tenant_id
$$;

CREATE OR REPLACE FUNCTION claim_outbox(p_limit integer DEFAULT 20)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE outbox o SET locked_at = now(), attempts = o.attempts + 1
   WHERE o.id IN (
     SELECT x.id FROM outbox x
      WHERE x.status IN ('PENDING','FAILED') AND x.next_attempt_at <= now()
        AND (x.locked_at IS NULL OR x.locked_at < now() - interval '10 minutes')
      ORDER BY x.created_at
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED)
  RETURNING o.id, o.tenant_id
$$;

REVOKE ALL ON FUNCTION claim_notifications(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_outbox(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_notifications(integer) TO inspectionflow_app;
GRANT EXECUTE ON FUNCTION claim_outbox(integer) TO inspectionflow_app;
