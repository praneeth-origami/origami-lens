import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl } from './url-normalize.js';
import { isSameOrigin, filterSameOrigin } from './same-origin.js';
import { UrlQueue } from './dedupe.js';
import { validateManualUrls, parseManualUrlLines } from './manual-urls.js';
import { fetchSitemapUrls, fetchRobotsTxtSitemapUrls } from './sitemap.js';
import { discoverPages, extractLinksFromDom } from './link-discovery.js';

describe('url-normalize', () => {
  it('strips hash and trailing slash', () => {
    assert.equal(normalizeUrl('https://example.com/page/#section'), 'https://example.com/page');
    assert.equal(normalizeUrl('https://example.com/page/'), 'https://example.com/page');
  });

  it('removes tracking params', () => {
    const url = normalizeUrl('https://example.com/?utm_source=x&foo=bar');
    assert.ok(url?.includes('foo=bar'));
    assert.ok(!url?.includes('utm_source'));
  });

  it('resolves relative URLs', () => {
    assert.equal(normalizeUrl('/about', 'https://example.com'), 'https://example.com/about');
  });
});

describe('same-origin', () => {
  it('accepts same origin only', () => {
    assert.equal(isSameOrigin('https://example.com/a', 'https://example.com'), true);
    assert.equal(isSameOrigin('https://other.com/a', 'https://example.com'), false);
  });

  it('filters urls', () => {
    const urls = filterSameOrigin(
      ['https://example.com/a', 'https://other.com/b'],
      'https://example.com',
    );
    assert.deepEqual(urls, ['https://example.com/a']);
  });
});

describe('dedupe', () => {
  it('deduplicates urls', () => {
    const q = new UrlQueue(['https://a.com', 'https://a.com']);
    assert.equal(q.size, 1);
    q.add('https://b.com');
    assert.equal(q.size, 2);
  });
});

describe('manual-urls', () => {
  it('validates manual urls against root', () => {
    const { urls, invalid } = validateManualUrls(['/about', 'https://evil.com/x'], 'https://example.com');
    assert.deepEqual(urls, ['https://example.com/about']);
    assert.equal(invalid.length, 1);
  });

  it('parses lines', () => {
    assert.deepEqual(parseManualUrlLines('/a\n/b, /c'), ['/a', '/b', '/c']);
  });
});

describe('sitemap', () => {
  it('parses sitemap xml', async () => {
    const xml = `<?xml version="1.0"?><urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/about</loc></url></urlset>`;
    const fetchFn = async () => new Response(xml, { status: 200 });
    const result = await fetchSitemapUrls('https://example.com', 10, fetchFn);
    assert.equal(result.urls.length, 2);
  });

  it('returns error when sitemap missing', async () => {
    const fetchFn = async () => new Response('', { status: 404 });
    const result = await fetchSitemapUrls('https://example.com', 10, fetchFn);
    assert.equal(result.urls.length, 0);
    assert.ok(result.error);
  });

  it('recurses one level into a sitemap index, fetching its child sitemaps for page URLs', async () => {
    const indexXml = `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap></sitemapindex>`;
    const childXml = `<?xml version="1.0"?><urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/about</loc></url></urlset>`;
    const fetchFn = async (url: string | URL | Request) => {
      const href = url.toString();
      if (href.includes('sitemap-pages.xml')) return new Response(childXml, { status: 200 });
      return new Response(indexXml, { status: 200 });
    };
    const result = await fetchSitemapUrls('https://example.com', 10, fetchFn);
    assert.deepEqual(result.urls.sort(), ['https://example.com/', 'https://example.com/about'].sort());
  });

  it('filters off-origin sitemap entries', async () => {
    const xml = `<?xml version="1.0"?><urlset><url><loc>https://example.com/a</loc></url><url><loc>https://evil.com/b</loc></url></urlset>`;
    const fetchFn = async () => new Response(xml, { status: 200 });
    const result = await fetchSitemapUrls('https://example.com', 10, fetchFn);
    assert.deepEqual(result.urls, ['https://example.com/a']);
  });
});

describe('robots.txt sitemap fallback', () => {
  it('finds and fetches a sitemap referenced by robots.txt', async () => {
    const robotsTxt = 'User-agent: *\nDisallow: /admin\nSitemap: https://example.com/my-sitemap.xml\n';
    const sitemapXml = `<?xml version="1.0"?><urlset><url><loc>https://example.com/pricing</loc></url></urlset>`;
    const fetchFn = async (url: string | URL | Request) => {
      const href = url.toString();
      if (href.endsWith('/robots.txt')) return new Response(robotsTxt, { status: 200 });
      if (href.includes('my-sitemap.xml')) return new Response(sitemapXml, { status: 200 });
      return new Response('', { status: 404 });
    };
    const result = await fetchRobotsTxtSitemapUrls('https://example.com', 10, fetchFn);
    assert.deepEqual(result.urls, ['https://example.com/pricing']);
  });

  it('reports an error when robots.txt has no Sitemap directive', async () => {
    const fetchFn = async () => new Response('User-agent: *\nDisallow: /admin\n', { status: 200 });
    const result = await fetchRobotsTxtSitemapUrls('https://example.com', 10, fetchFn);
    assert.equal(result.urls.length, 0);
    assert.ok(result.error);
  });
});

describe('extractLinksFromDom — rendered-link discovery for SPAs', () => {
  it('resolves and normalizes hrefs from rendered <a> elements, skipping non-navigational ones', () => {
    const links = [
      { attributes: { href: '/about' } },
      { attributes: { href: 'https://example.com/pricing/' } },
      { attributes: { href: '#section' } },
      { attributes: { href: 'mailto:hi@example.com' } },
      { attributes: { href: 'javascript:void(0)' } },
      { attributes: {} },
    ];
    const urls = extractLinksFromDom(links, 'https://example.com/');
    assert.deepEqual(urls, ['https://example.com/about', 'https://example.com/pricing']);
  });

  it('keeps distinct routes distinct (does not collapse /products/1 and /products/2)', () => {
    const links = [{ attributes: { href: '/products/1' } }, { attributes: { href: '/products/2' } }];
    const urls = extractLinksFromDom(links, 'https://example.com/');
    assert.deepEqual(urls, ['https://example.com/products/1', 'https://example.com/products/2']);
  });
});

describe('discoverPages — AUTOMATIC seeding (reproduces the SPA/dev-server discovery gap)', () => {
  it('falls back to just the root page when no sitemap exists anywhere (rendered-link crawling then takes over in the orchestrator)', async () => {
    const fetchFn = async () => new Response('', { status: 404 });
    const result = await discoverPages({ rootUrl: 'https://dev.berides.com', method: 'AUTOMATIC', maxPages: 20, fetchFn });
    assert.deepEqual(result.urls, ['https://dev.berides.com/']);
    assert.equal(result.error, undefined, 'a missing sitemap must not fail AUTOMATIC discovery outright');
  });

  it('seeds from sitemap.xml when present, always including the root page even if the sitemap omits it', async () => {
    const xml = `<?xml version="1.0"?><urlset><url><loc>https://example.com/about</loc></url></urlset>`;
    const fetchFn = async (url: string | URL | Request) => {
      if (url.toString().endsWith('/sitemap.xml')) return new Response(xml, { status: 200 });
      return new Response('', { status: 404 });
    };
    const result = await discoverPages({ rootUrl: 'https://example.com', method: 'AUTOMATIC', maxPages: 20, fetchFn });
    assert.deepEqual(result.urls.sort(), ['https://example.com/', 'https://example.com/about'].sort());
  });

  it('falls back to robots.txt-referenced sitemaps when /sitemap.xml itself 404s', async () => {
    const robotsTxt = 'Sitemap: https://example.com/sitemap-alt.xml\n';
    const sitemapXml = `<?xml version="1.0"?><urlset><url><loc>https://example.com/blog</loc></url></urlset>`;
    const fetchFn = async (url: string | URL | Request) => {
      const href = url.toString();
      if (href.endsWith('/sitemap.xml')) return new Response('', { status: 404 });
      if (href.endsWith('/robots.txt')) return new Response(robotsTxt, { status: 200 });
      if (href.includes('sitemap-alt.xml')) return new Response(sitemapXml, { status: 200 });
      return new Response('', { status: 404 });
    };
    const result = await discoverPages({ rootUrl: 'https://example.com', method: 'AUTOMATIC', maxPages: 20, fetchFn });
    assert.deepEqual(result.urls.sort(), ['https://example.com/', 'https://example.com/blog'].sort());
  });
});
