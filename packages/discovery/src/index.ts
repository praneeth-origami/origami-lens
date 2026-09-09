export { normalizeUrl, getOrigin } from './url-normalize.js';
export { isSameOrigin, filterSameOrigin } from './same-origin.js';
export { UrlQueue } from './dedupe.js';
export { fetchSitemapUrls, fetchRobotsTxtSitemapUrls, type SitemapResult } from './sitemap.js';
export { validateManualUrls, parseManualUrlLines, type ManualUrlResult } from './manual-urls.js';
export {
  discoverPages,
  extractLinksFromDom,
  type DiscoveryOptions,
  type DiscoveryResult,
} from './link-discovery.js';
