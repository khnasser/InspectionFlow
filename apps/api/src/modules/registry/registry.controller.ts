import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { AuthUser, CurrentUser } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { emitEvent } from '../../common/outbox';
import { parse } from '../../common/validation';

const i18n = z.record(z.string()).optional();

const inspectableSchema = z.object({
  typeCode: z.string(),
  identifier: z.string().min(1).max(100),
  name: z.string().min(1).max(300),
  nameI18n: i18n,
  parentId: z.string().uuid().optional(),
  address: z.string().max(500).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

const partySchema = z
  .object({
    type: z.enum(['INDIVIDUAL', 'COMPANY', 'GOVERNMENT']),
    firstName: z.string().max(100).optional(),
    lastName: z.string().max(100).optional(),
    companyName: z.string().max(300).optional(),
    nameI18n: i18n,
    email: z.string().email().optional(),
    phone: z.string().max(30).optional(),
    tradeLicense: z.string().max(60).optional(),
    licenseIssuer: z.string().max(100).optional(),
  })
  .refine((p) => (p.type === 'INDIVIDUAL' ? !!p.firstName : !!p.companyName), 'Name required for the party type');

const linkSchema = z.object({
  partyId: z.string().uuid(),
  role: z.string().min(2).max(40),
  isPrimary: z.boolean().default(false),
});

@Controller('v1')
export class RegistryController {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  @Get('inspectables')
  list(@CurrentUser() user: AuthUser, @Query('search') search?: string, @Query('limit') limit = '50') {
    return this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.query(
        `SELECT i.id, i.identifier, i.name, i.name_i18n, i.status, i.risk_rating, i.last_inspected_at, t.code AS type_code,
                (SELECT l.log_number FROM inspection_logs l WHERE l.inspectable_id = i.id
                   AND l.status IN ('OPEN','PENDING_CLIENT','PENDING_PAYMENT') LIMIT 1) AS open_log
           FROM inspectables i JOIN inspectable_types t ON t.id = i.type_id
          WHERE $1::text IS NULL OR i.name ILIKE '%' || $1 || '%' OR i.identifier ILIKE '%' || $1 || '%'
             OR i.name_i18n::text ILIKE '%' || $1 || '%'
          ORDER BY i.name LIMIT $2`,
        [search || null, Math.min(Number(limit) || 50, 200)],
      ),
    );
  }

  @Get('inspectables/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const item = await tx.maybeOne(
        `SELECT i.*, t.code AS type_code FROM inspectables i JOIN inspectable_types t ON t.id = i.type_id WHERE i.id = $1`,
        [id],
      );
      if (!item) throw new NotFoundException('Inspectable not found');
      const parties = await tx.query(
        `SELECT l.id AS link_id, l.role, l.is_primary, p.id, p.type, p.first_name, p.last_name, p.company_name, p.email, p.phone,
                p.blocked_status
           FROM inspectable_party_links l JOIN parties p ON p.id = l.party_id
          WHERE l.inspectable_id = $1 ORDER BY l.is_primary DESC, l.role`,
        [id],
      );
      const openFindings = await tx.query(
        `SELECT f.id, vt.code, vt.description_i18n, f.final_severity, f.fine_amount, f.resolve_by, f.status, l.log_number
           FROM inspection_findings f
           JOIN inspection_logs l ON l.id = f.log_id
           JOIN violation_templates vt ON vt.id = f.violation_template_id
           JOIN inspections i ON i.id = f.inspection_id
          WHERE l.inspectable_id = $1 AND f.status IN ('OPEN','CLIENT_REPLIED','NOT_RESOLVED')
            AND i.status IN ('APPROVED','CLOSED')
          ORDER BY f.resolve_by`,
        [id],
      );
      const history = await tx.query(
        `SELECT i.id, i.completed_at, i.status, i.category, i.cycle_number, l.log_number, u.display_name AS inspector,
                (SELECT COALESCE(SUM(fine_amount),0) FROM inspection_findings f WHERE f.inspection_id = i.id) AS total_fine
           FROM inspections i JOIN inspection_logs l ON l.id = i.log_id JOIN users u ON u.id = i.performed_by
          WHERE l.inspectable_id = $1 ORDER BY i.completed_at DESC LIMIT 25`,
        [id],
      );
      return { ...item, parties, openFindings, history };
    });
  }

  @Post('inspectables')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const d = parse(inspectableSchema, body);
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const type = await tx.maybeOne<{ id: string }>(`SELECT id FROM inspectable_types WHERE code = $1`, [d.typeCode]);
      if (!type) throw new NotFoundException(`Unknown inspectable type ${d.typeCode}`);
      const row = await tx.one(
        `INSERT INTO inspectables (tenant_id, type_id, parent_id, identifier, name, name_i18n, address, latitude, longitude)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, identifier, name`,
        [tx.tenantId, type.id, d.parentId ?? null, d.identifier, d.name, d.nameI18n ? JSON.stringify(d.nameI18n) : null,
         d.address ?? null, d.latitude ?? null, d.longitude ?? null],
      );
      await this.audit.record(tx, { action: 'inspectable.created', entityType: 'INSPECTABLE', entityId: row.id, newValue: d });
      await emitEvent(tx, 'INSPECTABLE', row.id, 'inspectable.created', { identifier: d.identifier, name: d.name });
      return row;
    });
  }

  @Get('parties')
  parties(@CurrentUser() user: AuthUser, @Query('search') search?: string) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.query(
        `SELECT id, type, first_name, last_name, company_name, email, phone, blocked_status FROM parties
          WHERE is_active AND ($1::text IS NULL OR company_name ILIKE '%' || $1 || '%'
                OR (first_name || ' ' || COALESCE(last_name,'')) ILIKE '%' || $1 || '%')
          ORDER BY COALESCE(company_name, first_name) LIMIT 50`,
        [search || null],
      ),
    );
  }

  @Post('parties')
  createParty(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const d = parse(partySchema, body);
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const p = await tx.one(
        `INSERT INTO parties (tenant_id, type, first_name, last_name, company_name, name_i18n, email, phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [tx.tenantId, d.type, d.firstName ?? null, d.lastName ?? null, d.companyName ?? null,
         d.nameI18n ? JSON.stringify(d.nameI18n) : null, d.email ?? null, d.phone ?? null],
      );
      if (d.tradeLicense) {
        await tx.query(
          `INSERT INTO party_identifiers (tenant_id, party_id, id_type, id_value_hash, id_value_plain, issuer)
           VALUES ($1,$2,'TRADE_LICENSE', encode(digest($3,'sha256'),'hex'), $3, $4)`,
          [tx.tenantId, p.id, d.tradeLicense, d.licenseIssuer ?? null],
        );
      }
      await this.audit.record(tx, { action: 'party.created', entityType: 'PARTY', entityId: p.id });
      await emitEvent(tx, 'PARTY', p.id, 'party.created', { type: d.type, email: d.email ?? null });
      return p;
    });
  }

  /** PRD 3.2: link a party to an inspectable (also possible during an inspection). */
  @Post('inspectables/:id/parties')
  link(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = parse(linkSchema, body);
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      if (d.isPrimary) {
        await tx.query(`UPDATE inspectable_party_links SET is_primary = false WHERE inspectable_id = $1`, [id]);
      }
      const row = await tx.one(
        `INSERT INTO inspectable_party_links (tenant_id, inspectable_id, party_id, role, is_primary, added_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, inspectable_id, party_id, role) DO UPDATE SET is_primary = EXCLUDED.is_primary
         RETURNING id`,
        [tx.tenantId, id, d.partyId, d.role.toUpperCase(), d.isPrimary, user.userId],
      );
      await this.audit.record(tx, { action: 'party.linked', entityType: 'INSPECTABLE', entityId: id, newValue: d });
      return row;
    });
  }
}
