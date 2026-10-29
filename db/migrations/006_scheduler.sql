-- ============================================================================
-- 006 - Scheduler: reminders, overdue marking, escalations (each fires once)
-- ============================================================================
CREATE TABLE scheduled_actions (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule       text NOT NULL,             -- pa.reminder, pa.overdue, task.escalated, finding.due
  entity_id  uuid NOT NULL,
  step       integer NOT NULL DEFAULT 0,  -- e.g. reminder day
  fired_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, rule, entity_id, step)
);
ALTER TABLE scheduled_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON scheduled_actions
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON scheduled_actions TO inspectionflow_app;

ALTER TABLE tasks ADD COLUMN escalated_at timestamptz;
CREATE INDEX IF NOT EXISTS ix_tasks_due_open ON tasks (tenant_id, due_at) WHERE status IN ('OPEN','CLAIMED','IN_PROGRESS');
CREATE INDEX IF NOT EXISTS ix_payment_advices_open ON payment_advices (tenant_id, status, due_at) WHERE status IN ('ISSUED','PARTIAL');

-- The scheduler walks tenants; it may only learn their ids.
CREATE OR REPLACE FUNCTION active_tenant_ids()
RETURNS TABLE (id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM tenants WHERE is_active ORDER BY id
$$;
REVOKE ALL ON FUNCTION active_tenant_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION active_tenant_ids() TO inspectionflow_app;
