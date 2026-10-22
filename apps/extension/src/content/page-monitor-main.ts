/**
 * Create Bug Report — real console-error/network-error capture. Runs in the
 * page's MAIN world (manifest.json's content_scripts world:"MAIN"), the ONLY
 * way to observe the page's OWN console.error()/fetch()/XMLHttpRequest
 * calls — an isolated-world content script (content-script.ts) has its own
 * separate `console`/`fetch` bindings and never sees the page's own calls
 * to them, even though both appear in the same DevTools panel. Relays
 * bounded, plain-data events to the isolated world via CustomEvent on
 * `window`, which IS visible across the world boundary (unlike function/
 * object references) — content-script.ts listens for these and keeps a
 * small rolling buffer. Never sends request/response BODIES, headers, or
 * cookies — only method/url/status/duration, matching the audit's explicit
 * "do not expose sensitive request bodies/headers/cookies" requirement by
 * construction, not by scrubbing afterward.
 *
 * This is the ONLY new "always on" page instrumentation Create Bug Report
 * adds — a deliberate tradeoff: the whole point of the feature is to
 * capture the error that already happened by the time a user notices a bug
 * and decides to report it, which is impossible if capture only starts once
 * they click the button. It never modifies the page's visible behavior or
 * blocks/alters any request/response — purely observational.
 */

const CONSOLE_EVENT = '__origami_console_error__';
const NETWORK_EVENT = '__origami_network_error__';

function dispatch(name: string, detail: Record<string, unknown>): void {
  try {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  } catch {
    // Never let a monitoring failure affect the page itself.
  }
}

function installConsoleMonitor(): void {
  const originalError = console.error;
  console.error = function origamiConsoleError(...args: unknown[]) {
    try {
      const message = args.map((a) => (a instanceof Error ? `${a.message}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 2000);
      const stack = args.find((a) => a instanceof Error)?.stack;
      dispatch(CONSOLE_EVENT, { type: 'error', message, stack: stack?.slice(0, 2000), timestamp: Date.now() });
    } catch {
      // ignore
    }
    return originalError.apply(console, args);
  };

  window.addEventListener('error', (event) => {
    dispatch(CONSOLE_EVENT, {
      type: 'exception',
      message: (event.message || event.error?.message || 'Uncaught exception').slice(0, 2000),
      stack: event.error?.stack?.slice(0, 2000),
      timestamp: Date.now(),
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'Unhandled promise rejection';
    dispatch(CONSOLE_EVENT, {
      type: 'exception',
      message: `Unhandled promise rejection: ${message}`.slice(0, 2000),
      stack: reason instanceof Error ? reason.stack?.slice(0, 2000) : undefined,
      timestamp: Date.now(),
    });
  });
}

function installNetworkMonitor(): void {
  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = async function origamiFetch(...args: Parameters<typeof fetch>) {
      const start = Date.now();
      const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof Request ? args[0].url : String(args[0]);
      const method = (args[1]?.method ?? (args[0] instanceof Request ? args[0].method : 'GET')).toUpperCase();
      try {
        const response = await originalFetch.apply(window, args);
        if (!response.ok) {
          dispatch(NETWORK_EVENT, { url: url.slice(0, 500), method, status: response.status, duration: Date.now() - start, resourceType: 'fetch', failed: true });
        }
        return response;
      } catch (error) {
        dispatch(NETWORK_EVENT, { url: url.slice(0, 500), method, status: 0, duration: Date.now() - start, resourceType: 'fetch', failed: true });
        throw error;
      }
    };
  }

  const OriginalXhr = window.XMLHttpRequest;
  if (OriginalXhr) {
    const originalOpen = OriginalXhr.prototype.open;
    const originalSend = OriginalXhr.prototype.send;
    OriginalXhr.prototype.open = function origamiXhrOpen(method: string, url: string | URL, ...rest: unknown[]) {
      (this as unknown as { __origamiMethod?: string; __origamiUrl?: string }).__origamiMethod = method;
      (this as unknown as { __origamiMethod?: string; __origamiUrl?: string }).__origamiUrl = String(url);
      // @ts-expect-error — passthrough to the original variadic signature
      return originalOpen.apply(this, [method, url, ...rest]);
    };
    OriginalXhr.prototype.send = function origamiXhrSend(...args: unknown[]) {
      const start = Date.now();
      this.addEventListener('loadend', () => {
        if (this.status === 0 || this.status >= 400) {
          const self = this as unknown as { __origamiMethod?: string; __origamiUrl?: string };
          dispatch(NETWORK_EVENT, {
            url: (self.__origamiUrl ?? '').slice(0, 500),
            method: self.__origamiMethod ?? 'GET',
            status: this.status,
            duration: Date.now() - start,
            resourceType: 'xhr',
            failed: true,
          });
        }
      });
      // @ts-expect-error — passthrough to the original variadic signature
      return originalSend.apply(this, args);
    };
  }
}

installConsoleMonitor();
installNetworkMonitor();
