import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { TenantTx } from './db.service';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  actorType?: 'USER' | 'PARTY' | 'SYSTEM' | 'INTEGRATION';
  ip?: string | null;
  requestId?: string | null;
  deviceId?: string | null;
}

/** Stable JSON: object keys sorted, so the same content always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Append-only, hash-chained audit log. Each row's hash covers the previous
 * row's hash, so removing or altering any row breaks the chain. A per-tenant
 * advisory lock serialises writers so the chain has no forks.
 */
@Injectable()
export class AuditService {
  async record(tx: TenantTx, entry: AuditEntry): Promise<void> {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`audit:${tx.tenantId}`]);
    const prev = await tx.maybeOne<{ row_hash: string }>(
      `SELECT row_hash FROM audit_logs ORDER BY seq DESC LIMIT 1`,
    );
    const occurredAt = new Date().toISOString();
    const body = {
      tenantId: tx.tenantId,
      occurredAt,
      actorType: entry.actorType ?? (tx.userId ? 'USER' : 'SYSTEM'),
      actorId: tx.userId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      oldValue: entry.oldValue ?? null,
      newValue: entry.newValue ?? null,
    };
    const prevHash = prev?.row_hash ?? null;
    const rowHash = sha256(`${prevHash ?? ''}|${canonicalJson(body)}`);
    await tx.query(
      `INSERT INTO audit_logs (tenant_id, occurred_at, actor_type, actor_id, action, entity_type, entity_id,
                               old_value, new_value, ip_address, request_id, device_id, prev_hash, row_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        tx.tenantId,
        occurredAt,
        body.actorType,
        tx.userId,
        entry.action,
        entry.entityType,
        entry.entityId ?? null,
        entry.oldValue === undefined ? null : JSON.stringify(entry.oldValue),
        entry.newValue === undefined ? null : JSON.stringify(entry.newValue),
        entry.ip ?? null,
        entry.requestId ?? null,
        entry.deviceId ?? null,
        prevHash,
        rowHash,
      ],
    );
  }

  /** Recompute the whole tenant chain; returns the first broken row if any. */
  async verify(tx: TenantTx): Promise<{ ok: boolean; rows: number; brokenAt?: string }> {
    const rows = await tx.query(
      `SELECT id, tenant_id, occurred_at, actor_type, actor_id, action, entity_type, entity_id,
              old_value, new_value, prev_hash, row_hash
         FROM audit_logs ORDER BY seq`,
    );
    let prev: string | null = null;
    for (const r of rows) {
      const body = {
        tenantId: r.tenant_id,
        occurredAt: new Date(r.occurred_at).toISOString(),
        actorType: r.actor_type,
        actorId: r.actor_id,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        oldValue: r.old_value,
        newValue: r.new_value,
      };
      const expected = sha256(`${prev ?? ''}|${canonicalJson(body)}`);
      if (r.prev_hash !== prev || r.row_hash !== expected) {
        return { ok: false, rows: rows.length, brokenAt: r.id };
      }
      prev = r.row_hash;
    }
    return { ok: true, rows: rows.length };
  }
}
