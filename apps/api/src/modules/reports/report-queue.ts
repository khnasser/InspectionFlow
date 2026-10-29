import { randomBytes } from 'crypto';
import { TenantTx } from '../../common/db.service';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 16 Crockford base32 characters = 80 random bits; unguessable, easy to read aloud. */
export function newVerificationCode(): string {
  const bytes = randomBytes(10);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** Called inside the approval transaction: the PDF is produced afterwards by the worker. */
export async function queueInspectionReport(tx: TenantTx, inspectionId: string): Promise<void> {
  const exists = await tx.maybeOne(
    `SELECT id FROM generated_reports WHERE subject_type = 'INSPECTION' AND subject_id = $1 AND status <> 'REVOKED'`,
    [inspectionId],
  );
  if (exists) return;
  const i = await tx.one<{ log_number: string; cycle_number: number; default_locale: string }>(
    `SELECT l.log_number, i.cycle_number, t.default_locale
       FROM inspections i JOIN inspection_logs l ON l.id = i.log_id JOIN tenants t ON t.id = i.tenant_id
      WHERE i.id = $1`,
    [inspectionId],
  );
  await tx.query(
    `INSERT INTO generated_reports (tenant_id, template_code, subject_type, subject_id, report_number, locale, verification_code)
     VALUES ($1,'INSPECTION_REPORT','INSPECTION',$2,$3,$4,$5)`,
    [tx.tenantId, inspectionId, `${i.log_number}-C${i.cycle_number}`, i.default_locale, newVerificationCode()],
  );
}

