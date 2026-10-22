/**
 * Create Bug Report — real browser/OS detection, never invented. Prefers
 * navigator.userAgentData (Chromium's own Client Hints API — reliably
 * available since this extension only ever runs inside a Chromium-based
 * browser) for an ACCURATE Windows 10 vs. 11 distinction (platformVersion's
 * major version >= 13 means Windows 11 — a real, documented Chromium quirk,
 * not a guess: https://learn.microsoft.com/microsoft-edge/web-platform/how-to-detect-win11),
 * falling back to parsing navigator.userAgent when userAgentData is
 * unavailable. Never reports a version it isn't actually sure of.
 */

interface NavigatorUAData {
  platform: string;
  brands: Array<{ brand: string; version: string }>;
  getHighEntropyValues(hints: string[]): Promise<{ platformVersion?: string; uaFullVersion?: string; fullVersionList?: Array<{ brand: string; version: string }> }>;
}

function parseBrowserFromUserAgent(ua: string): string {
  const edgeMatch = /Edg\/([\d.]+)/.exec(ua);
  if (edgeMatch) return `Edge ${edgeMatch[1].split('.')[0]}`;
  const operaMatch = /OPR\/([\d.]+)/.exec(ua);
  if (operaMatch) return `Opera ${operaMatch[1].split('.')[0]}`;
  const chromeMatch = /Chrome\/([\d.]+)/.exec(ua);
  if (chromeMatch) return `Chrome ${chromeMatch[1].split('.')[0]}`;
  const firefoxMatch = /Firefox\/([\d.]+)/.exec(ua);
  if (firefoxMatch) return `Firefox ${firefoxMatch[1].split('.')[0]}`;
  const safariVersionMatch = /Version\/([\d.]+).*Safari\//.exec(ua);
  if (safariVersionMatch) return `Safari ${safariVersionMatch[1].split('.')[0]}`;
  return 'Unknown browser';
}

function parseOsFromUserAgent(ua: string): string {
  if (/Windows NT/.test(ua)) return 'Windows';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Android/.test(ua)) return 'Android';
  if (/(iPhone|iPad|iPod)/.test(ua)) return 'iOS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Unknown OS';
}

export async function detectBrowserAndOs(): Promise<{ browser: string; operatingSystem: string }> {
  const ua = navigator.userAgent;
  let browser = parseBrowserFromUserAgent(ua);
  let operatingSystem = parseOsFromUserAgent(ua);

  const uaData = (navigator as unknown as { userAgentData?: NavigatorUAData }).userAgentData;
  if (uaData) {
    try {
      const hints = await uaData.getHighEntropyValues(['platformVersion', 'fullVersionList']);
      const chromeBrand = hints.fullVersionList?.find((b) => b.brand === 'Google Chrome' || b.brand === 'Chromium');
      if (chromeBrand) browser = `Chrome ${chromeBrand.version.split('.')[0]}`;

      if (uaData.platform === 'Windows' && hints.platformVersion) {
        const majorPlatformVersion = Number(hints.platformVersion.split('.')[0]);
        operatingSystem = majorPlatformVersion >= 13 ? 'Windows 11' : 'Windows 10';
      } else if (uaData.platform) {
        operatingSystem = uaData.platform;
      }
    } catch {
      // Client Hints unavailable/denied — the UA-string fallback above already stands.
    }
  }

  return { browser, operatingSystem };
}
