const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
]);

export function normalizeUrl(raw: string, baseUrl?: string): string | null {
  try {
    const resolved = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
    resolved.hash = '';

    for (const param of [...resolved.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(param.toLowerCase())) {
        resolved.searchParams.delete(param);
      }
    }

    let pathname = resolved.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    resolved.pathname = pathname || '/';

    return resolved.href;
  } catch {
    return null;
  }
}

export function getOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
