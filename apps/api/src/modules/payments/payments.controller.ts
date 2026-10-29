import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { AuditService, canonicalJson } from '../../common/audit.service';
import { AuthUser, CurrentUser, Public } from '../../common/auth';
import { APP_CONFIG, AppConfig } from '../../common/config';
import { DbService } from '../../common/db.service';
import { emitEvent } from '../../common/outbox';
import { parse } from '../../common/validation';
import { InspectionService } from '../inspections/inspection.service';

export const webhookSchema = z.object({
  tenantId: z.string().uuid(),
  paymentAdviceId: z.string().uuid(),
  gateway: z.string().min(2).max(40),
  gatewayTxnId: z.string().min(1).max(120),
  amount: z.number().positive(),
  currency: z.string().length(3),
  status: z.enum(['CAPTURED', 'FAILED']),
});

export function signWebhook(secret: string, body: unknown): string {
  return createHmac('sha256', secret).update(canonicalJson(body)).digest('hex');
}

/**
 * Collect module (MVP): payment advices, pay links and a gateway webhook.
 * Real gateway adapters (PayTabs, Checkout.com, Network International, Stripe)
 * implement the same webhook contract: verify signature, capture idempotently.
 */
@Controller('v1')
export class PaymentsController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly inspections: InspectionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('payment-advices')
  list(@CurrentUser() user: AuthUser, @Query('status') status?: string) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.query(
        `SELECT pa.id, pa.pa_number, pa.kind, pa.amount, pa.vat_amount, pa.currency, pa.status, pa.issued_at, pa.due_at,
                pa.paid_at, (pa.status IN ('ISSUED','PARTIAL') AND pa.due_at < now()) AS overdue,
                COALESCE(p.company_name, p.first_name || ' ' || COALESCE(p.last_name,'')) AS party_name, l.log_number
           FROM payment_advices pa JOIN parties p ON p.id = pa.party_id LEFT JOIN inspection_logs l ON l.id = pa.log_id
          WHERE $1::text IS NULL OR pa.status = $1
          ORDER BY pa.issued_at DESC LIMIT 200`,
        [status ?? null],
      ),
    );
  }

  @Get('payment-advices/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const pa = await tx.maybeOne(`SELECT * FROM payment_advices WHERE id = $1`, [id]);
      if (!pa) throw new NotFoundException('Payment advice not found');
      const payments = await tx.query(
        `SELECT id, amount, gateway, gateway_txn_id, status, processed_at FROM payments WHERE payment_advice_id = $1`,
        [id],
      );
      return { ...pa, payments };
    });
  }

  /** Pay link sent by SMS/email (PRD 7). The mock gateway page is for development only. */
  @Post('payment-advices/:id/pay-link')
  payLink(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.tenantId, user.userId, async (tx) => {
      const pa = await tx.maybeOne(`SELECT id, pa_number, amount, status FROM payment_advices WHERE id = $1`, [id]);
      if (!pa) throw new NotFoundException('Payment advice not found');
      if (pa.status === 'PAID') throw new BadRequestException('Already paid');
      const token = createHmac('sha256', this.config.paymentWebhookSecret).update(`${user.tenantId}:${id}`).digest('hex').slice(0, 32);
      return { url: `${this.config.publicBaseUrl}/pay/${id}?t=${token}`, number: pa.pa_number, amount: Number(pa.amount) };
    });
  }

  /** Gateway callback: signature-checked, idempotent on gateway transaction id. */
  @Public()
  @Post('webhooks/payments')
  async webhook(@Headers('x-signature') signature: string | undefined, @Body() body: unknown) {
    const d = parse(webhookSchema, body);
    const expected = signWebhook(this.config.paymentWebhookSecret, d);
    if (
      !signature ||
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
      throw new UnauthorizedException('Bad webhook signature');
    }
    return this.db.withTenant(d.tenantId, null, async (tx) => {
      const pa = await tx.maybeOne(`SELECT id, amount, vat_amount, status, log_id FROM payment_advices WHERE id = $1 FOR UPDATE`, [
        d.paymentAdviceId,
      ]);
      if (!pa) throw new NotFoundException('Payment advice not found');
      const inserted = await tx.query(
        `INSERT INTO payments (tenant_id, payment_advice_id, amount, currency, gateway, gateway_txn_id, idempotency_key,
                               status, processed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
         ON CONFLICT DO NOTHING RETURNING id`,
        [tx.tenantId, pa.id, d.amount, d.currency, d.gateway, d.gatewayTxnId, `${d.gateway}:${d.gatewayTxnId}`,
         d.status === 'CAPTURED' ? 'CAPTURED' : 'FAILED'],
      );
      if (!inserted.length) return { status: 'DUPLICATE_IGNORED' };
      if (d.status !== 'CAPTURED') return { status: 'RECORDED_FAILURE' };

      const paid = await tx.one<{ total: string }>(
        `SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE payment_advice_id = $1 AND status = 'CAPTURED'`,
        [pa.id],
      );
      const due = Number(pa.amount) + Number(pa.vat_amount);
      const newStatus = Number(paid.total) + 0.004 >= due ? 'PAID' : 'PARTIAL';
      await tx.query(
        `UPDATE payment_advices SET status = $2, paid_at = CASE WHEN $2 = 'PAID' THEN now() ELSE paid_at END WHERE id = $1`,
        [pa.id, newStatus],
      );
      await this.audit.record(tx, {
        action: 'payment.captured',
        entityType: 'PAYMENT_ADVICE',
        entityId: pa.id,
        actorType: 'INTEGRATION',
        newValue: { amount: d.amount, gateway: d.gateway, txn: d.gatewayTxnId, status: newStatus },
      });
      await emitEvent(tx, 'PAYMENT_ADVICE', pa.id, 'payment.captured', { amount: d.amount, status: newStatus });
      if (pa.log_id) await this.inspections.refreshLogStatus(tx, pa.log_id, null);
      return { status: newStatus };
    });
  }
}
