import { AppConfig } from '../../common/config';

/** HTML -> PDF. Both drivers use headless Chromium, so Arabic shaping and RTL are exact. */
export interface PdfRenderer {
  render(html: string): Promise<Buffer>;
  close?(): Promise<void>;
}

export const PDF_RENDERER = Symbol('PDF_RENDERER');

/** Gotenberg 8 (https://gotenberg.dev) running next to the API; no browser inside the API image. */
export class GotenbergRenderer implements PdfRenderer {
  constructor(private readonly baseUrl: string) {}

  async render(html: string): Promise<Buffer> {
    const form = new FormData();
    form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
    form.append('printBackground', 'true');
    form.append('preferCssPageSize', 'true');
    // Never let the renderer reach the network: everything is inlined.
    form.append('skipNetworkIdleEvent', 'true');
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/forms/chromium/convert/html`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Gotenberg ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

/** Local Chromium via Playwright (development, CI). Playwright is not a production dependency. */
export class PlaywrightRenderer implements PdfRenderer {
  private browser: Promise<any> | null = null;

  private launch() {
    if (!this.browser) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { chromium } = require('playwright');
      this.browser = chromium.launch();
    }
    return this.browser!;
  }

  async render(html: string): Promise<Buffer> {
    const browser = await this.launch();
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.route('**/*', (route: any) =>
        route.request().url().startsWith('data:') ? route.continue() : route.abort(),
      );
      await page.setContent(html, { waitUntil: 'load' });
      await page.evaluate?.(() => (document as any).fonts?.ready).catch?.(() => undefined);
      return Buffer.from(await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }));
    } finally {
      await context.close();
    }
  }

  async close() {
    if (this.browser) await (await this.browser).close();
    this.browser = null;
  }
}

export function createPdfRenderer(config: AppConfig): PdfRenderer {
  return config.reports.renderer === 'gotenberg'
    ? new GotenbergRenderer(config.reports.gotenbergUrl)
    : new PlaywrightRenderer();
}
