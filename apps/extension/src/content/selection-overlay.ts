/// <reference types="chrome" />
import type { CodeTarget, ComponentAssetRef, ComponentDomNode, ComponentEvidence, ComponentStyleSummary } from '@origami/contracts';
import { detectBlockingSensitiveContent } from '@origami/privacy';

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
    .ol-overlay { position: fixed; inset: 0; z-index: 2147483000; cursor: crosshair; }
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
      background: #17123f; color: #fff; font: 500 12px -apple-system, 'Segoe UI', sans-serif;
      padding: 8px 14px; border-radius: 999px; box-shadow: 0 8px 24px rgba(0,0,0,0.25);
    }
    .ol-panel {
      position: fixed; z-index: 2147483004; background: #ffffff; color: #111827;
      font: 13px -apple-system, 'Segoe UI', sans-serif; border-radius: 14px;
      box-shadow: 0 12px 32px rgba(17,24,39,0.22); padding: 14px; width: 260px;
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

function elementLabel(el: Element): string {
  const id = el.id ? `#${el.id}` : '';
  const cls = el.classList.length > 0 ? `.${Array.from(el.classList).slice(0, 2).join('.')}` : '';
  return `${el.tagName.toLowerCase()}${id}${cls}`;
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

  const target = event.target as Element | null;
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
  if (dragBox) dragBox.style.display = 'none';
  if (hoverBox) positionBox(hoverBox, rect);
  positionLabel(rect, `Selected Area  ${Math.round(rect.width)} × ${Math.round(rect.height)} px`);
  showConfirmPanel(rect);
}

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

  panel.innerHTML = `
    <h4>Selected Area</h4>
    <div class="ol-dims">${Math.round(rect.width)} × ${Math.round(rect.height)} px</div>
    ${blockReason ? `<div class="ol-warning">This selection contains ${blockReason}, which can't be safely captured. Choose a different area.</div>` : ''}
    <select id="ol-target" ${blockReason ? 'disabled' : ''}>
      <option value="REACT">React</option>
      <option value="NEXT_JS">Next.js</option>
      <option value="TAILWIND">React + Tailwind</option>
      <option value="HTML_CSS">HTML / CSS</option>
    </select>
    <div class="ol-row">
      <button type="button" class="ol-secondary" id="ol-cancel">Cancel</button>
      <button type="button" class="ol-primary" id="ol-generate" ${blockReason ? 'disabled' : ''}>Generate Code</button>
    </div>
  `;

  shadow.appendChild(panel);
  confirmPanel = panel;

  panel.querySelector('#ol-cancel')!.addEventListener('click', () => teardown());
  panel.querySelector('#ol-target')!.addEventListener('change', (e) => {
    currentTarget = (e.target as HTMLSelectElement).value as CodeTarget;
  });
  if (!blockReason) {
    panel.querySelector('#ol-generate')!.addEventListener('click', () => void handleGenerate(rect));
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

function buildNode(el: Element, depth: number): ComponentDomNode {
  const attributes: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    attributes[attr.name] = attr.value;
  }
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
    selector: elementLabel(el),
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

async function captureScreenshot(rect: Rect): Promise<string> {
  const response = await chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE_TAB' });
  if (!response?.dataUrl) {
    throw new Error(response?.error ?? 'Could not capture a screenshot of this page.');
  }

  const img = await loadImage(response.dataUrl);
  const scale = img.naturalWidth / window.innerWidth;

  const margin = CONTEXT_MARGIN_PX * scale;
  const sx = clamp(rect.x * scale - margin, 0, img.naturalWidth);
  const sy = clamp(rect.y * scale - margin, 0, img.naturalHeight);
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

async function handleGenerate(rect: Rect): Promise<void> {
  const generateBtn = confirmPanel?.querySelector<HTMLButtonElement>('#ol-generate');
  if (generateBtn) {
    generateBtn.disabled = true;
    generateBtn.textContent = 'Capturing…';
  }

  try {
    const element = confirmedElement ?? document.body;
    const elementNode = buildNode(element, 0);
    const ancestors = collectAncestors(element);

    const blockReason = detectBlockingSensitiveContent({ element: elementNode, ancestors });
    if (blockReason) {
      showToast(`Cannot generate code: selection contains ${blockReason}.`);
      teardown();
      return;
    }

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

    const response = await chrome.runtime.sendMessage({
      type: 'START_COMPONENT_GENERATION',
      target: currentTarget,
      evidence,
    });

    if (response?.ok) {
      showToast('Generating component… open the extension popup to track progress.');
    } else {
      showToast(response?.error ?? 'Could not start code generation.');
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Selection failed.');
  } finally {
    teardown();
  }
}

function teardown(): void {
  active = false;
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

export function startElementSelection(): void {
  if (active) return;
  active = true;

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
