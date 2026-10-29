import { TenantTx } from './db.service';

/**
 * Transactional outbox: written in the same transaction as the business change,
 * published later by a worker (CRM, ERP, notifications). Nothing is lost if the
 * external system is down.
 */
export async function emitEvent(
  tx: TenantTx,
  aggregateType: string,
  aggregateId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `INSERT INTO outbox (tenant_id, aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1,$2,$3,$4,$5)`,
    [tx.tenantId, aggregateType, aggregateId, eventType, JSON.stringify(payload)],
  );
}

/** Queue a notification row (delivery by the notification worker). */
export async function queueNotification(
  tx: TenantTx,
  n: {
    recipientType: 'USER' | 'PARTY' | 'TEAM' | 'EMAIL';
    recipientId?: string | null;
    recipientAddress?: string | null;
    channel: 'EMAIL' | 'SMS' | 'PUSH' | 'IN_APP';
    templateCode: string;
    payload: Record<string, unknown>;
    entityType?: string;
    entityId?: string;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO notifications (tenant_id, recipient_type, recipient_id, recipient_address, channel,
                                template_code, payload, entity_type, entity_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      tx.tenantId,
      n.recipientType,
      n.recipientId ?? null,
      n.recipientAddress ?? null,
      n.channel,
      n.templateCode,
      JSON.stringify(n.payload),
      n.entityType ?? null,
      n.entityId ?? null,
    ],
  );
}
