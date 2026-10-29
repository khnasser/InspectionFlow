import { createHmac } from 'crypto';
import { AppConfig } from './config';

/** Signed link to the public pay page for one payment advice (sent by SMS and email). */
export function payLinkUrl(config: AppConfig, tenantId: string, paymentAdviceId: string): string {
  const token = createHmac('sha256', config.paymentWebhookSecret).update(`${tenantId}:${paymentAdviceId}`).digest('hex').slice(0, 32);
  return `${config.publicBaseUrl}/pay/${paymentAdviceId}?t=${token}`;
}
