/**
 * SSRF / private-address protection for server-initiated navigation to a
 * USER-SUPPLIED, arbitrary website URL (continuous monitoring's own URL
 * field). This does NOT exist anywhere else in the codebase today — the
 * only other SSRF defense (repository-service.ts's parseRepositoryUrl) is
 * an exact-hostname ALLOWLIST of three known git-hosting SaaS domains,
 * which is the wrong shape here: a monitored site's URL is the customer's
 * own arbitrary domain, so this has to be a private/internal-address
 * BLOCKLIST instead (scheme check, credential check, literal private IPs,
 * and DNS-resolved private IPs, including the 169.254.169.254 cloud
 * metadata endpoint).
 *
 * Re-run this at every scan trigger (not just when the site is first
 * saved) — DNS can be repointed after creation (classic SSRF/DNS-rebinding
 * setup), so "was safe when saved" is not sufficient.
 *
 * Known limitation: this only pins safety at the DNS-resolution moment
 * this function runs. The actual page render/navigation happens in a
 * separate browser-worker service (outside this repository — its own
 * URL/redirect handling could not be audited from here), so true
 * rebinding-proof protection would need the SAME check re-applied at
 * actual navigation time inside that service. Flagged as a follow-up, not
 * solved here.
 */
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export type UrlSafetyErrorCode = 'INVALID_URL' | 'UNSUPPORTED_SCHEME' | 'CREDENTIALS_NOT_ALLOWED' | 'PRIVATE_ADDRESS' | 'DNS_RESOLUTION_FAILED';

export class UrlSafetyError extends Error {
  constructor(message: string, public readonly code: UrlSafetyErrorCode) {
    super(message);
    this.name = 'UrlSafetyError';
  }
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true; // malformed — fail closed
  const [a, b] = parts;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, INCLUDES the 169.254.169.254 cloud metadata endpoint
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast (224+) and reserved (240+)
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true; // loopback / unspecified
  if (normalized.startsWith('::ffff:')) {
    const embedded = normalized.slice('::ffff:'.length);
    if (isIP(embedded) === 4) return isPrivateIPv4(embedded);
  }
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local (fc00::/7)
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true; // link-local (fe80::/10)
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true; // not a recognizable literal IP — fail closed
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'metadata.google.internal']);

/** Validates that a user-supplied URL is safe for the server to navigate to on an unattended schedule. Throws UrlSafetyError, never returns a partially-validated result. */
export async function assertSafeMonitoringUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UrlSafetyError('Enter a valid URL.', 'INVALID_URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlSafetyError('Only http:// and https:// URLs are supported.', 'UNSUPPORTED_SCHEME');
  }
  if (url.username || url.password) {
    throw new UrlSafetyError('URLs with embedded credentials are not allowed.', 'CREDENTIALS_NOT_ALLOWED');
  }

  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new UrlSafetyError('This host cannot be monitored.', 'PRIVATE_ADDRESS');
  }

  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new UrlSafetyError('This address is not a public website and cannot be monitored.', 'PRIVATE_ADDRESS');
    return url;
  }

  let addresses: string[];
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    addresses = records.map((r) => r.address);
  } catch {
    throw new UrlSafetyError('Could not resolve this hostname.', 'DNS_RESOLUTION_FAILED');
  }
  if (addresses.length === 0 || addresses.some((addr) => isPrivateIp(addr))) {
    throw new UrlSafetyError('This website resolves to a private or internal address and cannot be monitored.', 'PRIVATE_ADDRESS');
  }

  return url;
}
