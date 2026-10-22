import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeMonitoringUrl, isPrivateIp, UrlSafetyError } from './url-safety.js';

describe('isPrivateIp', () => {
  it('flags RFC1918, loopback, link-local (incl. cloud metadata), and CGNAT ranges', () => {
    assert.equal(isPrivateIp('10.0.0.1'), true);
    assert.equal(isPrivateIp('172.16.0.1'), true);
    assert.equal(isPrivateIp('172.31.255.255'), true);
    assert.equal(isPrivateIp('192.168.1.1'), true);
    assert.equal(isPrivateIp('127.0.0.1'), true);
    assert.equal(isPrivateIp('169.254.169.254'), true); // cloud metadata endpoint
    assert.equal(isPrivateIp('100.64.0.1'), true);
    assert.equal(isPrivateIp('0.0.0.0'), true);
    assert.equal(isPrivateIp('::1'), true);
    assert.equal(isPrivateIp('fd00::1'), true);
    assert.equal(isPrivateIp('fe80::1'), true);
  });

  it('allows genuinely public addresses', () => {
    assert.equal(isPrivateIp('8.8.8.8'), false);
    assert.equal(isPrivateIp('1.1.1.1'), false);
    assert.equal(isPrivateIp('93.184.216.34'), false); // example.com
  });

  it('fails closed on malformed/unrecognizable input', () => {
    assert.equal(isPrivateIp('not-an-ip'), true);
    assert.equal(isPrivateIp('999.999.999.999'), true);
  });
});

describe('assertSafeMonitoringUrl', () => {
  it('rejects non-http(s) schemes', async () => {
    await assert.rejects(
      () => assertSafeMonitoringUrl('file:///etc/passwd'),
      (error: unknown) => { assert.ok(error instanceof UrlSafetyError); assert.equal(error.code, 'UNSUPPORTED_SCHEME'); return true; },
    );
  });

  it('rejects embedded credentials', async () => {
    await assert.rejects(
      () => assertSafeMonitoringUrl('https://user:pass@example.com'),
      (error: unknown) => { assert.ok(error instanceof UrlSafetyError); assert.equal(error.code, 'CREDENTIALS_NOT_ALLOWED'); return true; },
    );
  });

  it('rejects a literal private IP', async () => {
    await assert.rejects(
      () => assertSafeMonitoringUrl('http://127.0.0.1:8080/admin'),
      (error: unknown) => { assert.ok(error instanceof UrlSafetyError); assert.equal(error.code, 'PRIVATE_ADDRESS'); return true; },
    );
  });

  it('rejects the cloud metadata address', async () => {
    await assert.rejects(
      () => assertSafeMonitoringUrl('http://169.254.169.254/latest/meta-data/'),
      (error: unknown) => { assert.ok(error instanceof UrlSafetyError); assert.equal(error.code, 'PRIVATE_ADDRESS'); return true; },
    );
  });

  it('rejects "localhost" by name', async () => {
    await assert.rejects(
      () => assertSafeMonitoringUrl('http://localhost:3000'),
      (error: unknown) => { assert.ok(error instanceof UrlSafetyError); assert.equal(error.code, 'PRIVATE_ADDRESS'); return true; },
    );
  });

  it('rejects an invalid URL', async () => {
    await assert.rejects(
      () => assertSafeMonitoringUrl('not a url'),
      (error: unknown) => { assert.ok(error instanceof UrlSafetyError); assert.equal(error.code, 'INVALID_URL'); return true; },
    );
  });

  it('accepts a genuinely public https URL', async () => {
    const url = await assertSafeMonitoringUrl('https://example.com/checkout');
    assert.equal(url.hostname, 'example.com');
  });
});
