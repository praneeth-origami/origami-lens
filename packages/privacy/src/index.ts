import type { BrowserEvidence, ComponentDomNode, ComponentEvidence } from '@origami/contracts';

const SENSITIVE_KEYS = new Set([
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'session',
  'api_key',
  'apikey',
  'credit_card',
  'creditcard',
  'cvv',
  'cvc',
  'ssn',
]);

const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const API_KEY_PATTERN = /(?:api[_-]?key|sk-[a-zA-Z0-9]{20,})/gi;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/**
 * Card-shaped numbers only (grouped-by-4 format, or a bare 15/16-digit run) —
 * deliberately narrower than "any long digit run" to avoid mangling order IDs,
 * phone numbers, or tracking numbers in existing scan evidence.
 */
const CREDIT_CARD_PATTERN = /\b(?:\d{4}[ -]){3}\d{4}\b|\b3[47]\d{2}[ -]?\d{6}[ -]?\d{5}\b|\b\d{15,16}\b/g;

export function scrubString(value: string): string {
  let result = value;
  result = result.replace(JWT_PATTERN, '[REDACTED_JWT]');
  result = result.replace(BEARER_PATTERN, 'Bearer [REDACTED]');
  // Deliberately does not contain "api"+"key" — API_KEY_PATTERN matches that
  // sequence with an optional separator, so a placeholder literally named
  // [REDACTED_API_KEY] would match its own pattern on a second scrub pass
  // (e.g. verifyGeneratedComponent's leaked-secret re-check), flagging
  // already-redacted content as if it still contained a live secret.
  result = result.replace(API_KEY_PATTERN, '[REDACTED_CREDENTIAL]');
  result = result.replace(EMAIL_PATTERN, '[REDACTED_EMAIL]');
  result = result.replace(CREDIT_CARD_PATTERN, '[REDACTED_CARD_NUMBER]');
  return result;
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.has(lower) || [...SENSITIVE_KEYS].some((s) => lower.includes(s));
}

function scrubValue(key: string, value: unknown): unknown {
  if (typeof value === 'string') {
    if (isSensitiveKey(key)) return '[REDACTED]';
    return scrubString(value);
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => scrubValue(String(i), v));
  }
  if (value && typeof value === 'object') {
    return scrubObject(value as Record<string, unknown>);
  }
  return value;
}

function scrubObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isSensitiveKey(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = scrubValue(key, value);
    }
  }
  return result;
}

function scrubDomAttributes(attributes: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'type' && value === 'password') {
      result[key] = value;
      continue;
    }
    if (isSensitiveKey(key) || key === 'value' && attributes.type === 'password') {
      result[key] = '[REDACTED]';
    } else {
      result[key] = scrubString(value);
    }
  }
  return result;
}

export function sanitizeEvidence(evidence: BrowserEvidence): BrowserEvidence {
  const scrubDomElements = <T extends { attributes: Record<string, string>; text?: string }>(elements: T[]): T[] =>
    elements.map((el) => ({
      ...el,
      text: el.text ? scrubString(el.text) : el.text,
      attributes: scrubDomAttributes(el.attributes),
    }));

  return {
    ...evidence,
    page: {
      ...evidence.page,
      title: scrubString(evidence.page.title),
      description: evidence.page.description ? scrubString(evidence.page.description) : evidence.page.description,
    },
    dom: {
      headings: scrubDomElements(evidence.dom.headings),
      images: scrubDomElements(evidence.dom.images),
      links: scrubDomElements(evidence.dom.links),
      buttons: scrubDomElements(evidence.dom.buttons),
      forms: scrubDomElements(evidence.dom.forms),
      iframes: scrubDomElements(evidence.dom.iframes),
    },
    console: evidence.console.map((entry) => ({
      ...entry,
      message: scrubString(entry.message),
      stack: entry.stack ? scrubString(entry.stack) : entry.stack,
    })),
    network: evidence.network.map((entry) => ({
      ...entry,
      url: scrubString(entry.url),
    })),
  };
}

export class PrivacyScrubber {
  sanitize(evidence: BrowserEvidence): BrowserEvidence {
    return sanitizeEvidence(evidence);
  }
}

export function sanitizeForAi<T extends Record<string, unknown>>(payload: T): T {
  return scrubObject(payload) as T;
}

/* ------------------------------------------------------------------------ */
/* Screenshot -> Code: component evidence                                    */
/* ------------------------------------------------------------------------ */

const SENSITIVE_FIELD_NAME_PATTERN = /card.?number|cvv|cvc|ssn|social.?security|routing.?number|account.?number/i;

function flattenNodes(root: ComponentDomNode): ComponentDomNode[] {
  const out: ComponentDomNode[] = [root];
  for (const child of root.children ?? []) {
    out.push(...flattenNodes(child));
  }
  return out;
}

function nodeIsSensitiveField(node: ComponentDomNode): string | null {
  const attrs = node.attributes ?? {};
  if (attrs.type === 'password') return 'a password field';

  const autocomplete = (attrs.autocomplete ?? '').toLowerCase();
  if (autocomplete.startsWith('cc-')) return 'a payment card field';

  const identity = `${attrs.name ?? ''} ${attrs.id ?? ''} ${(node.classList ?? []).join(' ')}`;
  if (SENSITIVE_FIELD_NAME_PATTERN.test(identity)) return 'a payment or identity field';

  return null;
}

/**
 * Returns a human-readable reason if the selection contains a field the
 * Privacy Scrubber cannot safely sanitize (screenshots can't be redacted the
 * way text can), or null if the selection is safe to send to AI.
 */
export function detectBlockingSensitiveContent(evidence: Pick<ComponentEvidence, 'element' | 'ancestors'>): string | null {
  const nodes = [...evidence.ancestors, ...flattenNodes(evidence.element)];
  for (const node of nodes) {
    const reason = nodeIsSensitiveField(node);
    if (reason) return reason;
  }
  return null;
}

function scrubComponentNode(node: ComponentDomNode): ComponentDomNode {
  return {
    ...node,
    text: node.text ? scrubString(node.text) : node.text,
    attributes: scrubDomAttributes(node.attributes),
    children: node.children.map(scrubComponentNode),
  };
}

/**
 * Text/DOM sanitizer for ComponentEvidence. Mirrors sanitizeEvidence for full
 * page scans. Does NOT touch screenshotBase64 — images cannot be redacted by
 * this scrubber, which is why detectBlockingSensitiveContent exists as a hard
 * gate before any evidence (screenshot included) reaches the AI Gateway.
 */
export function sanitizeComponentEvidence(evidence: ComponentEvidence): ComponentEvidence {
  return {
    ...evidence,
    pageTitle: evidence.pageTitle ? scrubString(evidence.pageTitle) : evidence.pageTitle,
    html: scrubString(evidence.html),
    element: scrubComponentNode(evidence.element),
    ancestors: evidence.ancestors.map(scrubComponentNode),
    cssVariables: Object.fromEntries(
      Object.entries(evidence.cssVariables).map(([key, value]) => [key, scrubString(value)]),
    ),
  };
}
