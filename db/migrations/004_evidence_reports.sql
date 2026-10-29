-- ============================================================================
-- 004 - Evidence upload and issued reports with QR verification
-- ============================================================================

-- Documents: two-step upload (initiate -> client PUT to storage -> complete).
-- The version row is written at initiate with the sha256 / size the client
-- declared; complete checks the stored object against them.
ALTER TABLE documents
  ADD COLUMN status text NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('PENDING','AVAILABLE','REJECTED','DELETED'));
CREATE INDEX IF NOT EXISTS ix_documents_owner_status ON documents (tenant_id, owner_id, status);

-- Issued reports are produced by a background worker after approval.
ALTER TABLE generated_reports
  ALTER COLUMN document_id DROP NOT NULL,
  ADD COLUMN status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RENDERING','ISSUED','FAILED','REVOKED')),
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN last_error text,
  ADD COLUMN pdf_sha256 text,
  ADD COLUMN issued_at timestamptz,
  ADD COLUMN locked_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS uq_generated_reports_code ON generated_reports (verification_code);
CREATE INDEX IF NOT EXISTS ix_generated_reports_pending ON generated_reports (status, created_at) WHERE status IN ('PENDING','RENDERING');

-- Worker job claim across tenants without BYPASSRLS: returns ids only; the
-- worker then processes each job inside that tenant's RLS context.
CREATE OR REPLACE FUNCTION claim_report_jobs(p_limit integer DEFAULT 5)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE generated_reports g
     SET status = 'RENDERING', locked_at = now(), attempts = g.attempts + 1
   WHERE g.id IN (
     SELECT x.id FROM generated_reports x
      WHERE (x.status = 'PENDING' OR (x.status = 'RENDERING' AND x.locked_at < now() - interval '10 minutes'))
        AND x.attempts < 5
      ORDER BY x.created_at
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED)
  RETURNING g.id, g.tenant_id
$$;

-- Public verification of an issued document by its QR code. Returns only
-- non-personal facts: issuer, document type and number, issue time, the
-- fingerprint of the PDF and the current status of the inspection.
CREATE OR REPLACE FUNCTION verify_document(p_code text)
RETURNS TABLE (issuer_en text, issuer_ar text, template_code text, report_number text, reissue_no integer,
               status text, issued_at timestamptz, pdf_sha256 text, subject_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(t.name_i18n->>'en-US', t.name), COALESCE(t.name_i18n->>'ar-AE', t.name), g.template_code, g.report_number, g.reissue_no,
         g.status, g.issued_at, g.pdf_sha256,
         (SELECT i.status FROM inspections i WHERE g.subject_type = 'INSPECTION' AND i.id = g.subject_id)
    FROM generated_reports g JOIN tenants t ON t.id = g.tenant_id
   WHERE g.verification_code = p_code AND g.status IN ('ISSUED','REVOKED')
$$;

REVOKE ALL ON FUNCTION claim_report_jobs(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION verify_document(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_report_jobs(integer) TO inspectionflow_app;
GRANT EXECUTE ON FUNCTION verify_document(text) TO inspectionflow_app;
