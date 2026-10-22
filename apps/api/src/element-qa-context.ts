import type { ComponentDomNode, ComponentEvidence } from '@origami/contracts';
import { scrubString } from '@origami/privacy';

function envInt(name: string, defaultValue: number, minValue = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minValue) {
    console.error(JSON.stringify({ event: 'invalid_element_qa_config', name, providedValue: raw, minValue, fallback: defaultValue }));
    return defaultValue;
  }
  return parsed;
}

/** Same "own dedicated context budget" pattern as page-qa-context.ts's AI_PAGE_QA_MAX_CONTEXT_CHARS. */
export const AI_ELEMENT_QA_MAX_CONTEXT_CHARS = envInt('AI_ELEMENT_QA_MAX_CONTEXT_CHARS', 6_000);
const MAX_CHILD_SUMMARY = 8;

function describeNode(node: ComponentDomNode): string {
  const id = node.id ? `#${node.id}` : '';
  const classes = node.classList && node.classList.length > 0 ? `.${node.classList.slice(0, 4).join('.')}` : '';
  const text = node.text ? ` text="${scrubString(node.text).slice(0, 120)}"` : '';
  const styleEntries = Object.entries(node.style).filter(([, v]) => v);
  const style = styleEntries.length > 0 ? ` styles={${styleEntries.map(([k, v]) => `${k}: ${v}`).join('; ')}}` : '';
  return `${node.tag}${id}${classes}${text}${style}`;
}

// Surfaces the accessibility-relevant attributes already captured (role,
// aria-*, disabled, tabindex, plus the computed accessible-name synthetic
// attribute) into the AI context, since Explain/Fix/Improve are explicitly
// asked to reason about accessibility problems.
function describeAccessibility(node: ComponentDomNode): string | undefined {
  const attrs = node.attributes ?? {};
  const parts: string[] = [];

  const accessibleName = attrs['data-origami-accessible-name'];
  if (accessibleName) parts.push(`accessible name: "${scrubString(accessibleName)}"`);
  if (attrs.role) parts.push(`role: ${attrs.role}`);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('aria-')) parts.push(`${key}: ${scrubString(value)}`);
  }
  if (attrs.disabled !== undefined) parts.push('disabled');
  if (attrs.tabindex !== undefined) parts.push(`tabindex: ${attrs.tabindex}`);

  return parts.length > 0 ? parts.join(', ') : undefined;
}

function describeChildren(node: ComponentDomNode): string {
  if (node.children.length === 0) return '  (no child elements)';
  return node.children
    .slice(0, MAX_CHILD_SUMMARY)
    .map((child) => `  - ${describeNode(child)}`)
    .join('\n');
}

export interface ElementQaContextInput {
  url: string;
  pageTitle?: string;
  evidence: ComponentEvidence;
}

/**
 * Builds a bounded, deterministic context string from a selected element's
 * ALREADY privacy-scrubbed ComponentEvidence (element-action-service.ts
 * calls sanitizeComponentEvidence before this) — every free-text field is
 * passed through scrubString again here, defense in depth on top of that
 * pass (same posture as repository-ai-context.ts/page-qa-context.ts).
 */
export function buildElementQaContext(input: ElementQaContextInput): string {
  const { evidence } = input;
  const lines: string[] = [];

  lines.push(`Page URL: ${input.url}`);
  if (input.pageTitle) lines.push(`Page title: ${scrubString(input.pageTitle)}`);

  lines.push('', `Selected element: ${describeNode(evidence.element)}`);
  lines.push(`Bounding box: ${Math.round(evidence.boundingBox.width)}x${Math.round(evidence.boundingBox.height)}px at viewport ${evidence.boundingBox.viewportWidth}x${evidence.boundingBox.viewportHeight}px`);
  const accessibility = describeAccessibility(evidence.element);
  if (accessibility) lines.push(`Accessibility: ${accessibility}`);

  lines.push('', 'Direct children:');
  lines.push(describeChildren(evidence.element));

  if (evidence.ancestors.length > 0) {
    lines.push('', 'Ancestor chain (closest first):');
    for (const ancestor of evidence.ancestors) {
      lines.push(`  - ${describeNode(ancestor)}`);
    }
  }

  const cssVarEntries = Object.entries(evidence.cssVariables).slice(0, 10);
  if (cssVarEntries.length > 0) {
    lines.push('', 'Relevant CSS custom properties:');
    for (const [key, value] of cssVarEntries) lines.push(`  ${key}: ${scrubString(value)}`);
  }

  if (evidence.assets.length > 0) {
    lines.push('', `Assets referenced: ${evidence.assets.length} (${[...new Set(evidence.assets.map((a) => a.type))].join(', ')})`);
  }

  lines.push('', 'A cropped screenshot of this element was captured but is not analyzed for this answer — only the structured evidence above.');

  const context = lines.join('\n');
  return context.length > AI_ELEMENT_QA_MAX_CONTEXT_CHARS ? `${context.slice(0, AI_ELEMENT_QA_MAX_CONTEXT_CHARS)}…` : context;
}
