export function isSameOrigin(url: string, rootOrigin: string): boolean {
  try {
    const parsed = new URL(url);
    const root = new URL(rootOrigin);
    return parsed.origin === root.origin;
  } catch {
    return false;
  }
}

export function filterSameOrigin(urls: string[], rootUrl: string): string[] {
  const rootOrigin = new URL(rootUrl).origin;
  return urls.filter((url) => isSameOrigin(url, rootOrigin));
}
