import type { DiscoveryMethod } from '@origami/contracts';
import { fetchSitemapUrls, fetchRobotsTxtSitemapUrls } from './sitemap.js';
import { validateManualUrls, parseManualUrlLines } from './manual-urls.js';
import { normalizeUrl } from './url-normalize.js';

export interface DiscoveryOptions {
  rootUrl: string;
  method: DiscoveryMethod;
  maxPages: number;
  manualUrls?: string[];
  fetchFn?: typeof fetch;
}

export interface DiscoveryResult {
  urls: string[];
  error?: string;
  warnings?: string[];
}

/**
 * Seeds the crawl. This is NOT the whole of multi-page discovery for
 * AUTOMATIC — client-rendered SPAs (React/Next.js/Vue/Angular) serve no
 * server-rendered <a href> links, so a plain HTTP fetch here can never find
 * their pages. The rest of AUTOMATIC discovery happens in
 * website-scan-orchestrator.ts, which extends this seed by extracting real
 * rendered links (via extractLinksFromDom, below) from each page as the
 * Browser Engine actually scans it, breadth-first, up to maxPages.
 */
export async function discoverPages(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const { rootUrl, method, maxPages, manualUrls = [], fetchFn = fetch } = options;
  const normalizedRoot = normalizeUrl(rootUrl);
  if (!normalizedRoot) {
    return { urls: [], error: 'Invalid root URL' };
  }

  switch (method) {
    case 'MANUAL':
      return discoverManual(normalizedRoot, manualUrls, maxPages);
    case 'SITEMAP':
      return discoverViaSitemap(normalizedRoot, maxPages, fetchFn);
    case 'AUTOMATIC':
    default:
      return discoverAutomaticSeed(normalizedRoot, maxPages, fetchFn);
  }
}

function discoverManual(rootUrl: string, manualUrls: string[], maxPages: number): DiscoveryResult {
  const lines = manualUrls.flatMap((u) => parseManualUrlLines(u));
  const { urls, invalid } = validateManualUrls(lines.length > 0 ? lines : [rootUrl], rootUrl);

  const warnings: string[] = [];
  if (invalid.length > 0) {
    warnings.push(`${invalid.length} manual URL(s) were invalid or off-origin`);
  }

  const capped = urls.slice(0, maxPages);
  if (capped.length === 0) {
    return { urls: [], error: 'No valid manual URLs provided', warnings };
  }

  return { urls: capped, warnings: warnings.length > 0 ? warnings : undefined };
}

/** Priority: sitemap.xml, then robots.txt's Sitemap: directive(s) as a fallback. */
async function discoverViaSitemap(
  rootUrl: string,
  maxPages: number,
  fetchFn: typeof fetch,
): Promise<DiscoveryResult> {
  const direct = await fetchSitemapUrls(rootUrl, maxPages, fetchFn);
  if (direct.urls.length > 0) {
    return { urls: direct.urls };
  }

  const viaRobots = await fetchRobotsTxtSitemapUrls(rootUrl, maxPages, fetchFn);
  if (viaRobots.urls.length > 0) {
    return { urls: viaRobots.urls, warnings: direct.error ? [direct.error] : undefined };
  }

  return { urls: [], error: direct.error ?? viaRobots.error ?? 'No sitemap found' };
}

async function discoverAutomaticSeed(
  rootUrl: string,
  maxPages: number,
  fetchFn: typeof fetch,
): Promise<DiscoveryResult> {
  const viaSitemap = await discoverViaSitemap(rootUrl, maxPages, fetchFn);
  if (viaSitemap.urls.length > 0) {
    // Always scan the page the user actually asked to start from, even if
    // the sitemap happens to omit it.
    const urls = viaSitemap.urls.includes(rootUrl)
      ? viaSitemap.urls
      : [rootUrl, ...viaSitemap.urls].slice(0, maxPages);
    return { urls, warnings: viaSitemap.warnings };
  }

  // No sitemap available anywhere — seed with just the root page. The
  // orchestrator expands from here using rendered links collected while
  // actually scanning it (and each page after it), which is what makes this
  // work for SPAs with no server-rendered links and no sitemap at all.
  return { urls: [rootUrl] };
}

const SKIPPED_HREF_PREFIXES = ['#', 'mailto:', 'tel:', 'javascript:'];

/**
 * Turns rendered <a href> elements (collected by the Browser Engine AFTER
 * JavaScript has executed — see services/browser-worker/src/page-scripts.js)
 * into normalized, absolute candidate URLs. This is what lets discovery see
 * links a client-rendered SPA only creates after hydration, which a plain
 * HTTP fetch of the page never would.
 */
export function extractLinksFromDom(
  links: Array<{ attributes?: Record<string, string> }>,
  baseUrl: string,
): string[] {
  const urls: string[] = [];
  for (const link of links) {
    const href = link.attributes?.href;
    if (!href) continue;
    if (SKIPPED_HREF_PREFIXES.some((prefix) => href.startsWith(prefix))) continue;

    const normalized = normalizeUrl(href, baseUrl);
    if (normalized) urls.push(normalized);
  }
  return urls;
}
