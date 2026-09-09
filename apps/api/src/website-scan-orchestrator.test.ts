import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWebsiteOptions } from './db/scan-repository.js';

describe('resolveWebsiteOptions', () => {
  it('defaults discovery and caps max pages', () => {
    const opts = resolveWebsiteOptions({ discoveryMethod: 'SITEMAP', maxPages: 100 });
    assert.equal(opts.discoveryMethod, 'SITEMAP');
    assert.equal(opts.maxPages, 50);
  });

  it('uses default max pages when omitted', () => {
    const opts = resolveWebsiteOptions({ discoveryMethod: 'AUTOMATIC' });
    assert.equal(opts.maxPages, 20);
  });
});
