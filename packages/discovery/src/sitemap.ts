import { filterSameOrigin } from './same-origin.js';
import { normalizeUrl } from './url-normalize.js';

export interface SitemapResult {
  urls: string[];
  error?: string;
}

/** A sitemap index may reference this many child sitemaps at most — bounds the work for a pathological index. */
const MAX_CHILD_SITEMAPS = 5;

interface ParsedSitemap {
  locs: string[];
  isIndex: boolean;
  error?: string;
}

async function fetchAndParseSitemapXml(sitemapUrl: string, fetchFn: typeof fetch): Promise<ParsedSitemap> {
  try {
    const response = await fetchFn(sitemapUrl, {
      signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/xml, text/xml, */*' },
    });

    if (!response.ok) {
      return { locs: [], isIndex: false, error: `Sitemap not found at ${sitemapUrl} (HTTP ${response.status})` };
    }

    const xml = await response.text();
    const isIndex = /<sitemapindex[\s>]/i.test(xml);
    const locs = [...xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map((m) => m[1]?.trim()).filter(Boolean) as string[];

    if (locs.length === 0) {
      return { locs: [], isIndex, error: 'Sitemap contains no URLs' };
    }
    return { locs, isIndex };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch sitemap';
    return { locs: [], isIndex: false, error: message };
  }
}

async function resolveSitemapUrls(
  sitemapUrl: string,
  rootUrl: string,
  maxPages: number,
  fetchFn: typeof fetch,
): Promise<SitemapResult> {
  const first = await fetchAndParseSitemapXml(sitemapUrl, fetchFn);
  if (first.locs.length === 0) {
    return { urls: [], error: first.error };
  }

  let pageLocs: string[];
  if (first.isIndex) {
    // A sitemap index's <loc> entries point to CHILD sitemap files, not
    // pages — fetch a bounded number of them and use their <loc> entries instead.
    const childSitemaps = first.locs.slice(0, MAX_CHILD_SITEMAPS);
    const childResults = await Promise.all(childSitemaps.map((u) => fetchAndParseSitemapXml(u, fetchFn)));
    pageLocs = childResults.flatMap((r) => r.locs);
    if (pageLocs.length === 0) {
      return { urls: [], error: 'Sitemap index referenced no page URLs' };
    }
  } else {
    pageLocs = first.locs;
  }

  const normalized = pageLocs.map((loc) => normalizeUrl(loc)).filter((u): u is string => u !== null);
  const sameOrigin = filterSameOrigin(normalized, rootUrl);
  const unique = [...new Set(sameOrigin)].slice(0, maxPages);
  return { urls: unique };
}

export async function fetchSitemapUrls(
  rootUrl: string,
  maxPages: number,
  fetchFn: typeof fetch = fetch,
): Promise<SitemapResult> {
  const origin = new URL(rootUrl).origin;
  return resolveSitemapUrls(`${origin}/sitemap.xml`, rootUrl, maxPages, fetchFn);
}

/**
 * Fallback for sites whose sitemap isn't at the conventional /sitemap.xml
 * path — robots.txt's "Sitemap:" directive is the standard way a site
 * advertises its real sitemap location(s).
 */
export async function fetchRobotsTxtSitemapUrls(
  rootUrl: string,
  maxPages: number,
  fetchFn: typeof fetch = fetch,
): Promise<SitemapResult> {
  const origin = new URL(rootUrl).origin;
  const robotsUrl = `${origin}/robots.txt`;

  try {
    const response = await fetchFn(robotsUrl, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      return { urls: [], error: `robots.txt not found at ${robotsUrl} (HTTP ${response.status})` };
    }

    const text = await response.text();
    const sitemapUrls = [...text.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
    if (sitemapUrls.length === 0) {
      return { urls: [], error: 'robots.txt has no Sitemap directive' };
    }

    const results = await Promise.all(
      sitemapUrls.slice(0, MAX_CHILD_SITEMAPS).map((u) => resolveSitemapUrls(u, rootUrl, maxPages, fetchFn)),
    );
    const merged = [...new Set(results.flatMap((r) => r.urls))].slice(0, maxPages);
    if (merged.length === 0) {
      return { urls: [], error: 'No page URLs found in robots.txt-referenced sitemap(s)' };
    }
    return { urls: merged };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch robots.txt';
    return { urls: [], error: message };
  }
}
