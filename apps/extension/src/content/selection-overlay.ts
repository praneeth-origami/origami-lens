/// <reference types="chrome" />
import type { BugReportDomEvidence, CodeTarget, ComponentAssetRef, ComponentDomNode, ComponentEvidence, ElementActionType, ComponentStyleSummary } from '@origami/contracts';
import { detectBlockingSensitiveContent } from '@origami/privacy';
import { detectBrowserAndOs } from './browser-info.js';

const HOST_ID = 'origami-selection-root';
const MIN_SELECTION_SIZE = 12;
const MAX_TREE_DEPTH = 4;
const MAX_CHILDREN_PER_NODE = 25;
const MAX_HTML_CHARS = 20_000;
const MAX_ASSETS = 20;
const CONTEXT_MARGIN_PX = 12;

const STYLE_PROPS: Array<[keyof ComponentStyleSummary, string]> = [
  ['display', 'display'],
  ['position', 'position'],
  ['flexDirection', 'flex-direction'],
  ['justifyContent', 'justify-content'],
  ['alignItems', 'align-items'],
  ['gap', 'gap'],
  ['gridTemplateColumns', 'grid-template-columns'],
  ['width', 'width'],
  ['height', 'height'],
  ['padding', 'padding'],
  ['margin', 'margin'],
  ['color', 'color'],
  ['backgroundColor', 'background-color'],
  ['backgroundImage', 'background-image'],
  ['border', 'border'],
  ['borderRadius', 'border-radius'],
  ['boxShadow', 'box-shadow'],
  ['fontFamily', 'font-family'],
  ['fontSize', 'font-size'],
  ['fontWeight', 'font-weight'],
  ['lineHeight', 'line-height'],
  ['letterSpacing', 'letter-spacing'],
  ['textAlign', 'text-align'],
  ['opacity', 'opacity'],
  ['overflow', 'overflow'],
  ['zIndex', 'z-index'],
];

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Explicit selection-lifecycle state, exposed via getSelectionState() for
 * the popup UI and tests — the actual behavior was already correctly
 * gated by `active`/`confirmedRect`/etc. below; this is a thin, additive
 * label over those same transitions, not a behavioral change.
 *   IDLE -> SELECTING -> SELECTED -> ANALYZING -> COMPLETED
 *                  \-> IDLE (Escape/Cancel)         \-> ERROR
 */
export type SelectionState = 'IDLE' | 'SELECTING' | 'SELECTED' | 'ANALYZING' | 'COMPLETED' | 'ERROR';
let selectionState: SelectionState = 'IDLE';

let active = false;
let host: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;
let hoverBox: HTMLDivElement | null = null;
let label: HTMLDivElement | null = null;
let dragBox: HTMLDivElement | null = null;
let confirmPanel: HTMLDivElement | null = null;
let hoveredElement: Element | null = null;
let dragStart: { x: number; y: number } | null = null;
let dragging = false;
let confirmedRect: Rect | null = null;
let confirmedElement: Element | null = null;
let currentTarget: CodeTarget = 'REACT';

function styleSheet(): string {
  return `
    :host { all: initial; }
    /**
     * Bugfix: pointer-events was missing here. Without it, this
     * position:fixed, inset:0 element sits topmost across the ENTIRE
     * viewport and both event.target (Shadow DOM retargeting) and
     * document.elementFromPoint() — which never pierces a shadow tree from
     * outside it — report the shadow HOST at every point on the real page,
     * never the actual element under the cursor. Confirmed with a real-
     * browser test: the hover highlight never updated for a real page
     * element before this fix. pointer-events:none makes hit-testing skip
     * straight through to the real page, which is also why the crosshair
     * cursor this rule used to provide is now applied a different way —
     * see applySelectionCursor's doc comment. (.ol-hint, below, had the
     * SAME bug — it's the only other non-interactive overlay piece that is
     * position:fixed, and it was missing pointer-events:none too; that one
     * only surfaced in a small viewport/iframe where the hint banner
     * physically overlaps real content instead of floating over empty
     * space at the top of a full-size page.)
     */
    .ol-overlay { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; }
    .ol-hover, .ol-drag {
      position: fixed; pointer-events: none; z-index: 2147483001;
      border: 2px solid #5b4cdb; background: rgba(91, 76, 219, 0.08);
      border-radius: 2px; box-sizing: border-box; display: none;
    }
    .ol-drag { border-style: dashed; }
    .ol-label {
      position: fixed; pointer-events: none; z-index: 2147483002;
      background: #17123f; color: #fff; font: 600 11px -apple-system, 'Segoe UI', sans-serif;
      padding: 4px 8px; border-radius: 6px; white-space: nowrap; display: none;
    }
    .ol-hint {
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 2147483005;
      pointer-events: none;
      background: #17123f; color: #fff; font: 500 12px -apple-system, 'Segoe UI', sans-serif;
      padding: 8px 14px; border-radius: 999px; box-shadow: 0 8px 24px rgba(0,0,0,0.25);
    }
    .ol-panel {
      position: fixed; z-index: 2147483004; background: #ffffff; color: #111827;
      font: 13px -apple-system, 'Segoe UI', sans-serif; border-radius: 14px;
      box-shadow: 0 12px 32px rgba(17,24,39,0.22); padding: 14px; width: 300px;
      pointer-events: auto;
    }
    .ol-panel h4 { margin: 0 0 4px; font-size: 14px; font-weight: 600; }
    .ol-panel .ol-dims { color: #6b7280; font-size: 12px; margin-bottom: 10px; }
    .ol-panel select {
      width: 100%; padding: 7px 8px; margin-bottom: 10px; border-radius: 8px;
      border: 1px solid #d1d5db; font: inherit; background: #fff;
    }
    .ol-panel .ol-row { display: flex; gap: 8px; }
    .ol-panel button {
      flex: 1; padding: 9px 10px; border-radius: 8px; border: 1px solid transparent;
      font: 600 12px inherit; cursor: pointer;
    }
    .ol-panel .ol-primary { background: #5b4cdb; color: #fff; }
    .ol-panel .ol-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .ol-panel .ol-secondary { background: #f3f4f6; color: #111827; border-color: #e5e7eb; }
    .ol-panel .ol-warning {
      background: #fff7ed; color: #9a3412; border-radius: 8px; padding: 8px;
      font-size: 11px; margin-bottom: 10px; line-height: 1.4;
    }
    .ol-panel .ol-action-row { flex-wrap: wrap; margin-bottom: 10px; }
    .ol-panel .ol-action-btn { flex: 1 1 calc(50% - 4px); font-weight: 500; padding: 7px 6px; }
    .ol-panel .ol-action-btn:disabled { opacity: 0.6; cursor: wait; }
    .ol-panel .ol-action-result {
      margin-top: 10px; padding: 10px; border-radius: 8px; background: #f5f3ff;
      font-size: 12px; line-height: 1.5; max-height: 220px; overflow-y: auto;
    }
    .ol-panel .ol-action-result p { margin: 0; white-space: pre-wrap; }
    .ol-panel .ol-action-result-error { background: #fef2f2; color: #991b1b; }
    .ol-panel .ol-action-grounding {
      margin-top: 6px; font-size: 10.5px; color: #6b21a8; font-style: italic;
    }
  `;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x: clamp(x, 0, window.innerWidth),
    y: clamp(y, 0, window.innerHeight),
    width: clamp(Math.abs(a.x - b.x), 0, window.innerWidth - x),
    height: clamp(Math.abs(a.y - b.y), 0, window.innerHeight - y),
  };
}

function rectFromElement(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return {
    x: clamp(r.left, 0, window.innerWidth),
    y: clamp(r.top, 0, window.innerHeight),
    width: clamp(r.width, 0, window.innerWidth),
    height: clamp(r.height, 0, window.innerHeight),
  };
}

/** Short hover-label text only (kept brief on purpose — the overlay label has limited room) — NOT the selector used in captured evidence; see buildSelector below for that. */
function elementLabel(el: Element): string {
  const id = el.id ? `#${el.id}` : '';
  const cls = el.classList.length > 0 ? `.${Array.from(el.classList).slice(0, 2).join('.')}` : '';
  return `${el.tagName.toLowerCase()}${id}${cls}`;
}

/** Common stable test-attribute conventions, checked in this order — the same priority a human would use to write a resilient selector by hand. */
const STABLE_TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];

/**
 * A useful, reasonably stable selector for the captured element — never an
 * nth-child positional chain (fragile the moment a sibling is added/removed),
 * preferring in order: a stable test attribute, an id, a tag+class
 * combination, falling back to the bare tag name only when nothing else
 * distinguishes the element. This is deliberately NOT guaranteed to be
 * globally unique on the page (an nth-child suffix would be, at the cost of
 * fragility) — it's meant to be human- and AI-readable evidence, not a
 * runtime query selector.
 */
function buildSelector(el: Element): string {
  for (const attr of STABLE_TEST_ATTRS) {
    const value = el.getAttribute(attr);
    if (value) return `[${attr}="${value}"]`;
  }
  if (el.id) return `#${el.id}`;
  const tag = el.tagName.toLowerCase();
  if (el.classList.length > 0) {
    return `${tag}.${Array.from(el.classList).slice(0, 3).join('.')}`;
  }
  return tag;
}

/**
 * Best-effort accessible name — the same precedence the browser's own
 * accessible-name algorithm uses, simplified: an explicit aria-label wins,
 * then aria-labelledby's referenced text, then an associated <label>
 * (for/id or wrapping), then the title attribute, then (for elements whose
 * only content IS their name, like a button/link) trimmed visible text.
 * Returned as a synthetic attribute rather than a new contract field so it
 * flows through the EXISTING privacy scrubber/AI-context pipeline
 * unchanged — see scrubDomAttributes in packages/privacy, which already
 * scrubs every attribute VALUE generically.
 */
function computeAccessibleName(el: Element): string | undefined {
  const ariaLabel = el.getAttribute('aria-label')?.trim();
  if (ariaLabel) return ariaLabel;

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim())
      .filter(Boolean)
      .join(' ');
    if (text) return text;
  }

  if (el.id) {
    const labelFor = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    const text = labelFor?.textContent?.trim();
    if (text) return text;
  }
  const parentLabel = el.closest('label');
  if (parentLabel) {
    const text = parentLabel.textContent?.trim();
    if (text) return text;
  }

  const title = el.getAttribute('title')?.trim();
  if (title) return title;

  if (/^(button|a)$/i.test(el.tagName)) {
    const text = el.textContent?.trim();
    if (text) return text;
  }

  return undefined;
}

function positionBox(box: HTMLDivElement, rect: Rect): void {
  box.style.display = 'block';
  box.style.left = `${rect.x}px`;
  box.style.top = `${rect.y}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
}

function positionLabel(rect: Rect, text: string): void {
  if (!label) return;
  label.textContent = text;
  label.style.display = 'block';
  const top = rect.y > 20 ? rect.y - 22 : rect.y + rect.height + 6;
  label.style.left = `${clamp(rect.x, 4, window.innerWidth - 160)}px`;
  label.style.top = `${top}px`;
}

function onMouseMove(event: MouseEvent): void {
  if (!active || confirmedRect) return;

  if (dragging && dragStart) {
    const rect = rectFromPoints(dragStart, { x: event.clientX, y: event.clientY });
    if (rect.width > 4 || rect.height > 4) {
      if (dragBox) positionBox(dragBox, rect);
      if (hoverBox) hoverBox.style.display = 'none';
      positionLabel(rect, `${Math.round(rect.width)} × ${Math.round(rect.height)}`);
    }
    return;
  }

  // Bugfix: `event.target` is unusable here — `.ol-overlay` is a
  // position:fixed, inset:0 shadow element with no pointer-events:none, so
  // it sits topmost across the ENTIRE viewport and Shadow DOM retargets
  // `event.target` to `host` for every single mousemove over the real
  // page, regardless of where the cursor actually is. The hover
  // highlight/label never updated for a real page element before this fix
  // (confirmed with a real-browser Playwright test) — document.
  // elementFromPoint(), which onMouseUp's click-selection path already
  // correctly relies on for the exact same reason, reports the REAL
  // topmost element at that point instead.
  const target = document.elementFromPoint(event.clientX, event.clientY);
  if (!target || target === host) return;
  hoveredElement = target;
  const rect = rectFromElement(target);
  if (hoverBox) positionBox(hoverBox, rect);
  positionLabel(rect, `${elementLabel(target)}  ${Math.round(rect.width)} × ${Math.round(rect.height)}`);
}

function onMouseDown(event: MouseEvent): void {
  if (!active || confirmedRect) return;
  event.preventDefault();
  event.stopPropagation();
  dragStart = { x: event.clientX, y: event.clientY };
  dragging = true;
}

function onMouseUp(event: MouseEvent): void {
  if (!active || confirmedRect || !dragging) return;
  event.preventDefault();
  event.stopPropagation();
  dragging = false;

  const rect = dragStart ? rectFromPoints(dragStart, { x: event.clientX, y: event.clientY }) : null;
  dragStart = null;

  if (rect && (rect.width > 8 && rect.height > 8)) {
    finalizeSelection(rect, document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) ?? hoveredElement);
  } else if (hoveredElement) {
    finalizeSelection(rectFromElement(hoveredElement), hoveredElement);
  }
}

function onClickCapture(event: MouseEvent): void {
  if (!active) return;
  // Shadow DOM retargets `event.target` to `host` for any listener outside the
  // shadow tree (this one, on `document`) — so a click that originated inside our
  // own overlay/confirm-panel UI always shows up as `host` here. Only swallow
  // clicks that land on the real underlying page (links, buttons, etc.); clicks on
  // our own UI (Generate Code, Cancel, the target select) must reach their own
  // handlers normally, or the whole confirm panel becomes unclickable.
  if (event.target === host) return;
  event.preventDefault();
  event.stopPropagation();
}

function onKeyDown(event: KeyboardEvent): void {
  if (!active) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    teardown();
  }
}

function finalizeSelection(rect: Rect, element: Element | null): void {
  if (rect.width < MIN_SELECTION_SIZE || rect.height < MIN_SELECTION_SIZE) return;

  confirmedRect = rect;
  confirmedElement = element ?? document.body;
  selectionState = 'SELECTED';
  if (dragBox) dragBox.style.display = 'none';
  if (hoverBox) positionBox(hoverBox, rect);
  positionLabel(rect, `Selected Area  ${Math.round(rect.width)} × ${Math.round(rect.height)} px`);
  showConfirmPanel(rect);
}

const GENERATE_BUTTON_LABELS: Record<CodeTarget, string> = {
  REACT: 'Convert to React',
  NEXT_JS: 'Recreate Component',
  TAILWIND: 'Convert to Tailwind',
  HTML_CSS: 'Convert to HTML/CSS',
};

const ELEMENT_ACTION_BUTTONS: Array<{ action: ElementActionType; label: string }> = [
  { action: 'explain', label: 'Explain' },
  { action: 'fix', label: 'Fix' },
  { action: 'improve', label: 'Improve' },
  { action: 'make_responsive', label: 'Make Responsive' },
];

function showConfirmPanel(rect: Rect): void {
  if (!shadow) return;
  confirmPanel?.remove();

  const panel = document.createElement('div');
  panel.className = 'ol-panel';
  const top = rect.y + rect.height + 10 + 200 < window.innerHeight ? rect.y + rect.height + 10 : Math.max(10, rect.y - 210);
  const left = clamp(rect.x, 10, window.innerWidth - 280);
  panel.style.top = `${top}px`;
  panel.style.left = `${left}px`;

  const blockReason = confirmedElement ? guardCheck(confirmedElement) : null;
  const actionButtonsHtml = ELEMENT_ACTION_BUTTONS
    .map(({ action, label }) => `<button type="button" class="ol-secondary ol-action-btn" data-action="${action}" ${blockReason ? 'disabled' : ''}>${label}</button>`)
    .join('');

  panel.innerHTML = `
    <h4>Selected Area</h4>
    <div class="ol-dims">${Math.round(rect.width)} × ${Math.round(rect.height)} px</div>
    ${blockReason ? `<div class="ol-warning">This selection contains ${blockReason}, which can't be safely captured. Choose a different area.</div>` : ''}
    <div class="ol-row ol-action-row">${actionButtonsHtml}</div>
    <select id="ol-target" ${blockReason ? 'disabled' : ''}>
      <option value="REACT">React</option>
      <option value="NEXT_JS">Next.js</option>
      <option value="TAILWIND">React + Tailwind</option>
      <option value="HTML_CSS">HTML / CSS</option>
    </select>
    <div class="ol-row">
      <button type="button" class="ol-secondary" id="ol-cancel">Cancel</button>
      <button type="button" class="ol-primary" id="ol-generate" ${blockReason ? 'disabled' : ''}>${GENERATE_BUTTON_LABELS[currentTarget]}</button>
    </div>
  `;

  shadow.appendChild(panel);
  confirmPanel = panel;

  panel.querySelector('#ol-cancel')!.addEventListener('click', () => teardown());
  panel.querySelector('#ol-target')!.addEventListener('change', (e) => {
    currentTarget = (e.target as HTMLSelectElement).value as CodeTarget;
    const generateBtn = panel.querySelector<HTMLButtonElement>('#ol-generate');
    if (generateBtn) generateBtn.textContent = GENERATE_BUTTON_LABELS[currentTarget];
  });
  if (!blockReason) {
    panel.querySelector('#ol-generate')!.addEventListener('click', () => void handleGenerate(rect));
    for (const btn of panel.querySelectorAll<HTMLButtonElement>('.ol-action-btn')) {
      btn.addEventListener('click', () => void handleElementAction(rect, btn.dataset.action as ElementActionType));
    }
  }
}

function guardCheck(element: Element): string | null {
  const node = buildNode(element, 0);
  const ancestors = collectAncestors(element);
  return detectBlockingSensitiveContent({ element: node, ancestors });
}

function computedStyleSummary(el: Element): ComponentStyleSummary {
  const cs = window.getComputedStyle(el);
  const out: ComponentStyleSummary = {};
  for (const [key, cssProp] of STYLE_PROPS) {
    const value = cs.getPropertyValue(cssProp);
    if (value) (out as Record<string, string>)[key] = value;
  }
  return out;
}

/**
 * Never captured, on ANY element — the CURRENT value a user may have typed
 * into a form control, matching the exact same exclusion the full-page-scan
 * evidence collector already uses (content-script.ts's collectElements) —
 * a `value` HTML attribute normally only reflects an element's initial/
 * default value, but some frameworks and, notably, a live-edited textarea's
 * rendered content, can echo back what the user actually typed. This is a
 * blanket precaution independent of (and in addition to)
 * detectBlockingSensitiveContent's type/name-based field classification,
 * which only blocks the OBVIOUSLY sensitive fields (password, payment),
 * never arbitrary free text someone typed into an ordinary-looking field.
 */
const NEVER_CAPTURED_ATTRS = new Set(['value', 'data-password']);

function buildNode(el: Element, depth: number): ComponentDomNode {
  const attributes: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    if (NEVER_CAPTURED_ATTRS.has(attr.name)) continue;
    attributes[attr.name] = attr.value;
  }
  const accessibleName = computeAccessibleName(el);
  if (accessibleName) attributes['data-origami-accessible-name'] = accessibleName;
  const rect = el.getBoundingClientRect();
  const directText = Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent ?? '')
    .join(' ')
    .trim()
    .slice(0, 300);

  const children =
    depth >= MAX_TREE_DEPTH
      ? []
      : Array.from(el.children)
          .slice(0, MAX_CHILDREN_PER_NODE)
          .map((child) => buildNode(child, depth + 1));

  return {
    tag: el.tagName.toLowerCase(),
    selector: buildSelector(el),
    id: el.id || undefined,
    classList: el.classList.length > 0 ? Array.from(el.classList) : undefined,
    attributes,
    text: directText || undefined,
    style: computedStyleSummary(el),
    boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    children,
  };
}

function collectAncestors(el: Element): ComponentDomNode[] {
  const ancestors: ComponentDomNode[] = [];
  let current = el.parentElement;
  let count = 0;
  while (current && current !== document.body.parentElement && count < 5) {
    ancestors.push(buildNode(current, MAX_TREE_DEPTH));
    current = current.parentElement;
    count++;
  }
  return ancestors;
}

function collectCssVariables(): Record<string, string> {
  const vars: Record<string, string> = {};
  try {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // cross-origin stylesheet — skip, can't read it safely
      }
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSStyleRule)) continue;
        if (!/^(:root|html)$/.test(rule.selectorText?.trim() ?? '')) continue;
        for (const prop of Array.from(rule.style)) {
          if (prop.startsWith('--')) {
            vars[prop] = rule.style.getPropertyValue(prop).trim();
          }
        }
      }
      if (Object.keys(vars).length > 40) break;
    }
  } catch {
    // best-effort only
  }
  return vars;
}

function collectAssets(root: Element): ComponentAssetRef[] {
  const assets: ComponentAssetRef[] = [];
  const seen = new Set<string>();

  const push = (asset: ComponentAssetRef) => {
    if (assets.length >= MAX_ASSETS || seen.has(asset.url)) return;
    seen.add(asset.url);
    assets.push(asset);
  };

  for (const img of root.querySelectorAll('img')) {
    if (img.src) {
      push({ url: img.src.startsWith('data:') && img.src.length > 6000 ? '[data-uri-omitted]' : img.src, type: 'image', width: img.naturalWidth || undefined, height: img.naturalHeight || undefined, alt: img.alt || undefined });
    }
  }
  for (const svg of root.querySelectorAll('svg')) {
    const box = svg.getBoundingClientRect();
    push({ url: '[inline-svg]', type: 'svg', width: box.width || undefined, height: box.height || undefined });
  }
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    const bg = window.getComputedStyle(el).backgroundImage;
    const match = /url\((['"]?)([^'")]+)\1\)/.exec(bg);
    if (match?.[2]) {
      const url = match[2].startsWith('data:') && match[2].length > 6000 ? '[data-uri-omitted]' : match[2];
      push({ url, type: 'background-image' });
    }
  }

  return assets;
}

interface FrameContext {
  /** This frame's origin relative to the TOP page, in top-page CSS pixels — (0, 0) when we ARE the top page. */
  offsetX: number;
  offsetY: number;
  /** The top page's own viewport width — chrome.tabs.captureVisibleTab always renders at the TOP page's device scale, so scale-factor math must use this, never a nested frame's own (possibly different) innerWidth. */
  topViewportWidth: number;
  /**
   * True as soon as the frame chain crosses a cross-origin boundary we
   * cannot see through — `window.frameElement` (and any property beyond
   * the small cross-origin-safe allowlist) throws/returns null for a
   * WindowProxy we don't share an origin with, by design (this is the
   * browser's own cross-origin isolation, not a bug to work around).
   * offsetX/offsetY still reflect every frame boundary successfully
   * walked before that point — never a wrong/guessed value, just
   * incomplete — so the caller can decide whether a still-useful partial
   * crop is possible or whether to skip screenshot cropping entirely.
   */
  crossOriginBlocked: boolean;
}

/**
 * Walks UP the frame chain to convert this frame's local coordinates into
 * top-page coordinates — needed because chrome.tabs.captureVisibleTab (see
 * CAPTURE_VISIBLE_TAB below) always returns the composited screenshot in
 * top-page pixel coordinates, but a selection made inside an iframe
 * (all_frames:true in the manifest lets Select Anything run inside them —
 * see manifest.json) reports its own rect in THAT IFRAME's local coordinate
 * space, which only equals the top page's space when there is no iframe
 * nesting at all (the overwhelmingly common case, handled by the fast path
 * below with zero added cost).
 */
function getFrameContext(): FrameContext {
  if (window === window.top) {
    return { offsetX: 0, offsetY: 0, topViewportWidth: window.innerWidth, crossOriginBlocked: false };
  }

  let offsetX = 0;
  let offsetY = 0;
  let win: Window = window;
  try {
    while (win !== win.top) {
      const frameEl = win.frameElement;
      if (!frameEl) return { offsetX, offsetY, topViewportWidth: window.innerWidth, crossOriginBlocked: true };
      const frameRect = frameEl.getBoundingClientRect();
      offsetX += frameRect.left;
      offsetY += frameRect.top;
      win = win.parent;
    }
    return { offsetX, offsetY, topViewportWidth: win.innerWidth, crossOriginBlocked: false };
  } catch {
    // A cross-origin WindowProxy throws on most property access rather than returning null/undefined — same "stop here, honestly" outcome as the `!frameEl` branch above.
    return { offsetX, offsetY, topViewportWidth: window.innerWidth, crossOriginBlocked: true };
  }
}

/**
 * Returns '' (never throws) when running inside a cross-origin embedded
 * iframe, where the top-page pixel offset needed to crop the right region
 * of chrome.tabs.captureVisibleTab's screenshot cannot be determined — a
 * real browser security boundary, not a bug (see getFrameContext). Every
 * other capture step (HTML/CSS/DOM/accessibility context) is completely
 * unaffected and still proceeds — see captureComponentEvidence.
 */
async function captureScreenshot(rect: Rect): Promise<string> {
  const frame = getFrameContext();
  if (frame.crossOriginBlocked) return '';

  const response = await chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE_TAB' });
  if (!response?.dataUrl) {
    throw new Error(response?.error ?? 'Could not capture a screenshot of this page.');
  }

  const img = await loadImage(response.dataUrl);
  const scale = img.naturalWidth / frame.topViewportWidth;

  const topPageX = rect.x + frame.offsetX;
  const topPageY = rect.y + frame.offsetY;

  const margin = CONTEXT_MARGIN_PX * scale;
  const sx = clamp(topPageX * scale - margin, 0, img.naturalWidth);
  const sy = clamp(topPageY * scale - margin, 0, img.naturalHeight);
  const sw = clamp(rect.width * scale + margin * 2, 1, img.naturalWidth - sx);
  const sh = clamp(rect.height * scale + margin * 2, 1, img.naturalHeight - sy);

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not supported.');
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return dataUrl.split(',')[1] ?? '';
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode captured screenshot.'));
    img.src = src;
  });
}

/**
 * Toasts must survive `teardown()`, which runs synchronously right after most
 * calls to this function (e.g. in handleGenerate's catch/finally) and removes
 * `host` — appending into the selection overlay's own shadow root would mean
 * the toast is created and destroyed in the same tick and a user never sees
 * it. This uses its own independent, self-contained host so error/status
 * messages remain visible after the selection UI tears down.
 */
function showToast(text: string): void {
  const toastHost = document.createElement('div');
  toastHost.style.all = 'initial';
  document.documentElement.appendChild(toastHost);
  const toastShadow = toastHost.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    .ol-toast {
      position: fixed; top: 16px; right: 16px; z-index: 2147483005;
      background: #17123f; color: #fff; font: 500 13px -apple-system, 'Segoe UI', sans-serif;
      padding: 10px 14px; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.25);
      max-width: 280px;
    }
  `;
  toastShadow.appendChild(style);

  const toast = document.createElement('div');
  toast.className = 'ol-toast';
  toast.textContent = text;
  toastShadow.appendChild(toast);

  setTimeout(() => toastHost.remove(), 4500);
}

/**
 * Captures the same ComponentEvidence bundle for the confirmed selection,
 * shared by handleGenerate (Convert to React/Tailwind/Recreate Component)
 * and handleElementAction (Explain/Fix/Improve/Make Responsive) below — one
 * capture implementation, never duplicated per action. Returns a block
 * reason instead of throwing when the selection contains sensitive content,
 * so each caller can show its own action-appropriate message.
 */
async function captureComponentEvidence(rect: Rect): Promise<{ evidence: ComponentEvidence; screenshotUnavailable: boolean } | { blockReason: string }> {
  const element = confirmedElement ?? document.body;
  const elementNode = buildNode(element, 0);
  const ancestors = collectAncestors(element);

  const blockReason = detectBlockingSensitiveContent({ element: elementNode, ancestors });
  if (blockReason) return { blockReason };

  const screenshotBase64 = await captureScreenshot(rect);
  const html = element.outerHTML.slice(0, MAX_HTML_CHARS);
  const assets = collectAssets(element);
  const cssVariables = collectCssVariables();

  const evidence: ComponentEvidence = {
    sourceUrl: location.href,
    pageTitle: document.title,
    capturedAt: new Date().toISOString(),
    boundingBox: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      devicePixelRatio: window.devicePixelRatio,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    },
    screenshotBase64,
    element: elementNode,
    ancestors,
    html,
    cssVariables,
    assets,
    containsSensitiveFields: false,
  };

  return { evidence, screenshotUnavailable: screenshotBase64 === '' };
}

async function handleGenerate(rect: Rect): Promise<void> {
  const generateBtn = confirmPanel?.querySelector<HTMLButtonElement>('#ol-generate');
  if (generateBtn) {
    generateBtn.disabled = true;
    generateBtn.textContent = 'Capturing…';
  }
  selectionState = 'ANALYZING';

  try {
    const captured = await captureComponentEvidence(rect);
    if ('blockReason' in captured) {
      selectionState = 'ERROR';
      showToast(`Cannot generate code: selection contains ${captured.blockReason}.`);
      teardown();
      return;
    }
    if (captured.screenshotUnavailable) {
      // Code generation genuinely needs the visual reference — unlike
      // Explain/Fix/Improve/Make Responsive below, there's no useful
      // degraded mode here, so this fails clearly rather than generating
      // a low-quality/blank-looking component.
      selectionState = 'ERROR';
      showToast('This element is inside an embedded frame from a different site, so Origami Lens cannot capture a screenshot of it (a browser security restriction) — code generation needs a screenshot.');
      teardown();
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: 'START_COMPONENT_GENERATION',
      target: currentTarget,
      evidence: captured.evidence,
    });

    if (response?.ok) {
      selectionState = 'COMPLETED';
      showToast('Generating component… open the extension popup to track progress.');
    } else {
      selectionState = 'ERROR';
      showToast(response?.error ?? 'Could not start code generation.');
    }
  } catch (error) {
    selectionState = 'ERROR';
    showToast(error instanceof Error ? error.message : 'Selection failed.');
  } finally {
    teardown();
  }
}

const ELEMENT_ACTION_LABELS: Record<ElementActionType, string> = {
  explain: 'Explaining…',
  fix: 'Finding a fix…',
  improve: 'Thinking of improvements…',
  make_responsive: 'Checking responsiveness…',
};

/**
 * Runs one Explain/Fix/Improve/Make Responsive action for the confirmed
 * selection. Unlike handleGenerate (a queued job tracked via the popup),
 * this is a single request whose answer is shown directly in the confirm
 * panel — see showActionResult below.
 */
async function handleElementAction(rect: Rect, action: ElementActionType): Promise<void> {
  const button = confirmPanel?.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
  const originalLabel = button?.textContent ?? '';
  if (button) {
    button.disabled = true;
    button.textContent = ELEMENT_ACTION_LABELS[action];
  }
  selectionState = 'ANALYZING';

  try {
    const captured = await captureComponentEvidence(rect);
    if ('blockReason' in captured) {
      selectionState = 'ERROR';
      showActionResult(`Cannot analyze this selection: it contains ${captured.blockReason}.`, true);
      return;
    }
    if (captured.screenshotUnavailable) {
      // Unlike Convert to Code, these actions are primarily structure/text
      // driven — a HTML/CSS/DOM-only analysis is still genuinely useful, so
      // this degrades gracefully (a toast note, not a hard failure) rather
      // than blocking the whole action over a browser security restriction
      // it has no control over (see getFrameContext's doc comment).
      showToast('This element is inside an embedded frame from a different site — Origami Lens will analyze it without a screenshot.');
    }

    const response = await chrome.runtime.sendMessage({
      type: 'RUN_ELEMENT_ACTION',
      action,
      evidence: captured.evidence,
    });

    if (response?.ok) {
      selectionState = 'COMPLETED';
      showActionResult(response.answer, false, response.groundedInRepository);
    } else {
      selectionState = 'ERROR';
      showActionResult(response?.error ?? 'Could not complete this action.', true);
    }
  } catch (error) {
    selectionState = 'ERROR';
    showActionResult(error instanceof Error ? error.message : 'This action failed.', true);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }
}

/** Renders an Explain/Fix/Improve/Make Responsive answer (or error) inline in the confirm panel — never torn down like handleGenerate's toast-and-teardown, since the user may want to try another action or read the answer before dismissing. */
function showActionResult(text: string, isError: boolean, groundedInRepository?: boolean): void {
  if (!confirmPanel) return;
  confirmPanel.querySelector('.ol-action-result')?.remove();

  const result = document.createElement('div');
  result.className = `ol-action-result${isError ? ' ol-action-result-error' : ''}`;

  // Built via textContent, never innerHTML — `text` is AI-generated/server
  // error content and must never be parsed as HTML.
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  result.appendChild(paragraph);

  if (!isError && groundedInRepository === false) {
    const grounding = document.createElement('div');
    grounding.className = 'ol-action-grounding';
    grounding.textContent = 'Browser-only analysis — connect a repository for a source-grounded fix.';
    result.appendChild(grounding);
  }

  confirmPanel.appendChild(result);
}

const CURSOR_STYLE_ID = 'origami-selection-cursor';

/**
 * Provides the crosshair cursor while selection mode is active — moved
 * here from .ol-overlay's own `cursor` CSS property (see .ol-overlay's
 * pointer-events bugfix above) since pointer-events:none means the
 * overlay itself no longer participates in cursor-hit-testing at all. A
 * single light-DOM `<style>` element with `cursor: crosshair !important`
 * on `*` — appended to `<head>` and removed in teardown() below, so it
 * never outlives selection mode and never alters the page's CSS
 * permanently, matching this feature's own "no permanent page
 * modification" requirement.
 */
function applySelectionCursor(): void {
  const style = document.createElement('style');
  style.id = CURSOR_STYLE_ID;
  style.textContent = '*, *::before, *::after { cursor: crosshair !important; }';
  document.head.appendChild(style);
}

function removeSelectionCursor(): void {
  document.getElementById(CURSOR_STYLE_ID)?.remove();
}

function teardown(): void {
  active = false;
  selectionState = 'IDLE';
  removeSelectionCursor();
  document.removeEventListener('mousemove', onMouseMove, true);
  document.removeEventListener('mousedown', onMouseDown, true);
  document.removeEventListener('mouseup', onMouseUp, true);
  document.removeEventListener('click', onClickCapture, true);
  document.removeEventListener('keydown', onKeyDown, true);
  host?.remove();
  host = null;
  shadow = null;
  hoverBox = null;
  label = null;
  dragBox = null;
  confirmPanel = null;
  hoveredElement = null;
  confirmedRect = null;
  confirmedElement = null;
  dragStart = null;
  dragging = false;
}

export function isSelectionActive(): boolean {
  return active;
}

/** IDLE / SELECTING / SELECTED / ANALYZING / COMPLETED / ERROR — see SelectionState's own doc comment. */
export function getSelectionState(): SelectionState {
  return selectionState;
}

export function startElementSelection(): void {
  if (active) return;
  active = true;
  selectionState = 'SELECTING';
  applySelectionCursor();

  host = document.createElement('div');
  host.id = HOST_ID;
  document.documentElement.appendChild(host);
  shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = styleSheet();
  shadow.appendChild(style);

  const overlay = document.createElement('div');
  overlay.className = 'ol-overlay';
  shadow.appendChild(overlay);

  hoverBox = document.createElement('div');
  hoverBox.className = 'ol-hover';
  shadow.appendChild(hoverBox);

  dragBox = document.createElement('div');
  dragBox.className = 'ol-drag';
  shadow.appendChild(dragBox);

  label = document.createElement('div');
  label.className = 'ol-label';
  shadow.appendChild(label);

  const hint = document.createElement('div');
  hint.className = 'ol-hint';
  hint.textContent = 'Click an element or drag a rectangle to select — Esc to cancel';
  shadow.appendChild(hint);

  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('click', onClickCapture, true);
  document.addEventListener('keydown', onKeyDown, true);
}

export function cancelElementSelection(): void {
  teardown();
}

/**
 * Jumps straight to the SELECTED state for a CSS selector rather than
 * waiting for a real hover/click — used by the Responsive Testing panel's
 * per-issue "Select Element"/"Fix" buttons (a responsive-test issue already
 * knows the real page's selector via evidence.selector; re-clicking through
 * the normal flow would be redundant). Reuses finalizeSelection/
 * showConfirmPanel unchanged, so every downstream action (Explain/Fix/
 * Improve/Make Responsive/Convert to.../Recreate Component) behaves exactly
 * like a manual selection — never a second, parallel selection path.
 */
export function selectElementBySelector(
  selector: string,
  autoAction?: ElementActionType,
): { success: boolean; error?: string } {
  let element: Element | null;
  try {
    element = document.querySelector(selector);
  } catch {
    return { success: false, error: 'Invalid selector.' };
  }
  if (!element) {
    return { success: false, error: 'This element could not be found on the page (the layout may have changed since the test ran).' };
  }

  if (!active) startElementSelection();
  const rect = rectFromElement(element);
  finalizeSelection(rect, element);
  if (selectionState !== 'SELECTED') {
    return { success: false, error: 'This element is too small to select (it may be hidden or collapsed at this viewport).' };
  }
  if (autoAction) void handleElementAction(rect, autoAction);
  return { success: true };
}

/** Honest, uncropped capture of whatever is currently on screen — used by Create Bug Report when there's no specific selected element (reuses the SAME CAPTURE_VISIBLE_TAB mechanism captureScreenshot already relies on, just without the canvas crop step). Returns '' for the same cross-origin-iframe reason captureScreenshot does. */
async function captureFullViewportScreenshot(): Promise<string> {
  const frame = getFrameContext();
  if (frame.crossOriginBlocked) return '';
  const response = await chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE_TAB' });
  if (!response?.dataUrl) return '';
  return (response.dataUrl as string).split(',')[1] ?? '';
}

/**
 * Create Bug Report — captures everything automatically available from the
 * live page: URL, title, viewport/DPR, a screenshot, and (ONLY when the
 * user has an active Select Anything selection) DOM evidence for that
 * specific element — reusing buildNode/computeAccessibleName/
 * computedStyleSummary/guardCheck/captureScreenshot unchanged, never a
 * second DOM-capture implementation. Browser/OS come from browser-info.ts.
 * Console/network errors are NOT included here — they live in a separate
 * content script (bug-report-monitor.ts) with its own buffer, merged by the
 * background coordinator (bug-report-coordinator.ts) that calls this.
 */
export async function captureBugReportEvidence(): Promise<
  | {
      url: string;
      pageTitle: string;
      browser: string;
      operatingSystem: string;
      viewportWidth: number;
      viewportHeight: number;
      devicePixelRatio: number;
      screenshotBase64: string;
      domEvidence?: BugReportDomEvidence;
    }
  | { blockReason: string }
> {
  const { browser, operatingSystem } = await detectBrowserAndOs();

  const hasSelection = selectionState === 'SELECTED' && confirmedElement && confirmedRect;
  let domEvidence: BugReportDomEvidence | undefined;
  let screenshotBase64: string;

  if (hasSelection) {
    const element = confirmedElement!;
    const blockReason = guardCheck(element);
    if (blockReason) return { blockReason };

    const rect = confirmedRect!;
    screenshotBase64 = await captureScreenshot(rect);
    domEvidence = {
      selector: buildSelector(element),
      tag: element.tagName.toLowerCase(),
      text: (element.textContent ?? '').trim().slice(0, 300) || undefined,
      html: element.outerHTML.slice(0, MAX_HTML_CHARS),
      attributes: Object.fromEntries(Array.from(element.attributes).filter((a) => !['value', 'data-password'].includes(a.name)).map((a) => [a.name, a.value])),
      computedStyles: computedStyleSummary(element) as unknown as Record<string, string>,
      boundingBox: rect,
      accessibleName: computeAccessibleName(element),
    };
  } else {
    screenshotBase64 = await captureFullViewportScreenshot();
  }

  return {
    url: location.href,
    pageTitle: document.title,
    browser,
    operatingSystem,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    screenshotBase64,
    domEvidence,
  };
}
