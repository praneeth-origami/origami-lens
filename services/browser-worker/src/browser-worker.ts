import { collectPageEvidence, collectLayoutEvidence, runAxeInBrowser } from './page-scripts.js';
import type { PageEvidenceResult } from './page-scripts.js';
import type { BrowserEvidence, ConsoleEntry, NetworkEntry } from '@origami/contracts';
import { chromium, type Browser, type Page, type CDPSession } from 'playwright';
import lighthouse from 'lighthouse';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AXE_CORE_PATH = require.resolve('axe-core/axe.min.js');

export interface ScanOptions {
  includeScreenshots?: boolean;
  mobileViewport?: boolean;
  runLighthouse?: boolean;
  runAxe?: boolean;
}

const DESKTOP_VIEWPORT = { width: 1280, height: 720 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

export class BrowserWorker {
  private browser: Browser | null = null;

  async init(): Promise<void> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
      });
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async scanUrl(url: string, options: ScanOptions = {}): Promise<BrowserEvidence> {
    await this.init();
    const browser = this.browser!;
    const context = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
    const page = await context.newPage();

    const consoleEntries: ConsoleEntry[] = [];
    const networkEntries: NetworkEntry[] = [];

    page.on('console', (msg) => {
      const type = msg.type() === 'error' ? 'error' : msg.type() === 'warning' ? 'warn' : 'log';
      consoleEntries.push({ type: type as ConsoleEntry['type'], message: msg.text(), timestamp: Date.now() });
    });

    page.on('pageerror', (error) => {
      consoleEntries.push({
        type: 'exception',
        message: error.message,
        stack: error.stack,
        timestamp: Date.now(),
      });
    });

    page.on('requestfinished', async (request) => {
      const response = await request.response();
      networkEntries.push({
        url: request.url(),
        method: request.method(),
        status: response?.status() ?? 0,
        duration: 0,
        resourceType: request.resourceType(),
        size: Number(response?.headers()['content-length'] ?? 0) || undefined,
        failed: !response || response.status() >= 400,
      });
    });

    page.on('requestfailed', (request) => {
      networkEntries.push({
        url: request.url(),
        method: request.method(),
        status: 0,
        duration: 0,
        resourceType: request.resourceType(),
        failed: true,
      });
    });

    let cdpSession: CDPSession | null = null;
    try {
      // 'networkidle' alone is unreliable against SPAs/dev servers that hold a
      // persistent connection open (HMR websockets, polling, live chat, etc.)
      // — that condition can simply never occur, no matter how long the
      // timeout is. 'load' is a reliable, bounded signal that the page itself
      // has finished loading; the short best-effort networkidle wait after it
      // just gives normal sites a brief window to let async content settle,
      // without ever failing the scan if it doesn't.
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      cdpSession = await page.context().newCDPSession(page);

      const evidence = await this.collectEvidence(page, consoleEntries, networkEntries);

      if (options.runAxe !== false) {
        try {
          evidence.axe = await this.runAxe(page);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'axe-core scan failed';
          evidence.console.push({
            type: 'warn',
            message: `[origami] axe-core scan failed: ${msg}`,
            timestamp: Date.now(),
          });
        }
      }

      if (options.includeScreenshots !== false) {
        evidence.screenshots.push({
          viewport: 'desktop',
          width: DESKTOP_VIEWPORT.width,
          height: DESKTOP_VIEWPORT.height,
          base64: (await page.screenshot({ fullPage: false, type: 'jpeg', quality: 60 })).toString('base64'),
        });
      }

      if (options.mobileViewport !== false) {
        await page.setViewportSize(MOBILE_VIEWPORT);
        await page.waitForTimeout(500);
        const mobileLayout = await this.collectLayoutEvidence(page);
        evidence.layout = mobileLayout;
        evidence.viewport = MOBILE_VIEWPORT;

        if (options.includeScreenshots !== false) {
          evidence.screenshots.push({
            viewport: 'mobile',
            width: MOBILE_VIEWPORT.width,
            height: MOBILE_VIEWPORT.height,
            base64: (await page.screenshot({ fullPage: false, type: 'jpeg', quality: 60 })).toString('base64'),
          });
        }
      }

      if (options.runLighthouse !== false) {
        try {
          evidence.lighthouse = await this.runLighthouse(url);
          const lhPerf = this.extractLighthouseMetrics(evidence.lighthouse);
          evidence.performance = { ...evidence.performance, ...lhPerf };
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Lighthouse scan failed';
          evidence.console.push({
            type: 'warn',
            message: `[origami] Lighthouse scan failed: ${msg}`,
            timestamp: Date.now(),
          });
        }
      }

      if (cdpSession) {
        const perfMetrics = await this.collectCdpPerformance(cdpSession);
        evidence.performance = { ...evidence.performance, ...perfMetrics };
      }

      return evidence;
    } finally {
      await context.close();
    }
  }

  private async collectEvidence(
    page: Page,
    consoleEntries: ConsoleEntry[],
    networkEntries: NetworkEntry[],
  ): Promise<BrowserEvidence> {
    const pageData = await page.evaluate(collectPageEvidence) as PageEvidenceResult;

    return {
      page: {
        url: page.url(),
        title: pageData.title,
        description: pageData.description,
        canonical: pageData.canonical,
        robots: pageData.robots,
        viewport: pageData.viewportMeta,
        lang: pageData.lang,
      },
      documentDimensions: pageData.documentDimensions,
      viewport: pageData.viewport,
      dom: pageData.dom,
      layout: pageData.layout,
      console: consoleEntries,
      network: networkEntries,
      performance: { navigationTiming: pageData.navigationTiming },
      screenshots: [],
      collectedAt: new Date().toISOString(),
    };
  }

  private async collectLayoutEvidence(page: Page): Promise<BrowserEvidence['layout']> {
    return page.evaluate(collectLayoutEvidence);
  }

  private async collectCdpPerformance(cdp: CDPSession): Promise<Record<string, number>> {
    try {
      await cdp.send('Performance.enable');
      const metrics = await cdp.send('Performance.getMetrics');
      const result: Record<string, number> = {};
      for (const m of metrics.metrics) {
        result[m.name] = m.value;
      }
      return result;
    } catch {
      return {};
    }
  }

  private extractLighthouseMetrics(lh: Record<string, unknown>): Record<string, number> {
    const audits = lh.audits as Record<string, { numericValue?: number }> | undefined;
    if (!audits) return {};
    return {
      lcp: audits['largest-contentful-paint']?.numericValue,
      cls: audits['cumulative-layout-shift']?.numericValue,
      fcp: audits['first-contentful-paint']?.numericValue,
      tbt: audits['total-blocking-time']?.numericValue,
      ttfb: audits['server-response-time']?.numericValue,
    } as Record<string, number>;
  }

  private async runAxe(page: Page): Promise<Record<string, unknown>> {
    await page.addScriptTag({ path: AXE_CORE_PATH });
    return page.evaluate(runAxeInBrowser) as Promise<Record<string, unknown>>;
  }

  private async runLighthouse(url: string): Promise<Record<string, unknown>> {
    const browserServer = await chromium.launchServer({ headless: true });
    const port = Number(new URL(browserServer.wsEndpoint()).port);

    try {
      const result = await lighthouse(url, {
        port,
        output: 'json',
        logLevel: 'error',
        onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      });

      return (result?.lhr ?? {}) as Record<string, unknown>;
    } finally {
      await browserServer.close();
    }
  }
}

export { BrowserWorker as PlaywrightBrowserService };
