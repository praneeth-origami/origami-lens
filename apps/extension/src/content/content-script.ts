import type { EvidencePayload } from '../types/scan.js';
import { cancelElementSelection, startElementSelection } from './selection-overlay.js';

function getSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const tag = el.tagName.toLowerCase();
  return tag;
}

function resolveLabel(el: Element): { labelText: string; hasAssociatedLabel: boolean } {
  let labelText = '';
  let hasAssociatedLabel = false;

  if (el.id) {
    const labelFor = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (labelFor) {
      labelText = (labelFor.textContent ?? '').trim();
      hasAssociatedLabel = labelText.length > 0;
    }
  }

  if (!hasAssociatedLabel) {
    const parentLabel = el.closest('label');
    if (parentLabel) {
      labelText = (parentLabel.textContent ?? '').trim();
      hasAssociatedLabel = labelText.length > 0;
    }
  }

  return { labelText, hasAssociatedLabel };
}

function collectElements(selector: string, limit = 50, isForm = false) {
  return Array.from(document.querySelectorAll(selector)).slice(0, limit).map((el) => {
    const attrs: Record<string, string> = {};
    for (const attr of el.attributes) {
      if (!['value', 'data-password'].includes(attr.name)) {
        attrs[attr.name] = attr.value;
      }
    }

    const label = isForm ? resolveLabel(el) : { labelText: undefined, hasAssociatedLabel: undefined };

    return {
      selector: getSelector(el),
      tag: el.tagName.toLowerCase(),
      text: (el.textContent ?? '').trim().slice(0, 200),
      attributes: attrs,
      ...(isForm ? label : {}),
    };
  });
}

function collectEvidence(): EvidencePayload {
  const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? '';
  const docWidth = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0);
  const vpWidth = window.innerWidth;

  return {
    page: {
      url: location.href,
      title: document.title,
      description: metaDescription,
      canonical,
    },
    documentDimensions: { width: docWidth, height: document.documentElement.scrollHeight },
    viewport: { width: vpWidth, height: window.innerHeight },
    dom: {
      headings: collectElements('h1, h2, h3, h4, h5, h6'),
      images: collectElements('img'),
      links: collectElements('a[href]'),
      buttons: collectElements('button, [role="button"], input[type="button"], input[type="submit"]'),
      forms: collectElements('input:not([type="hidden"]), select, textarea', 50, true),
      iframes: collectElements('iframe'),
    },
    layout: {
      horizontalOverflow: docWidth > vpWidth + 1,
      overflowWidth: docWidth > vpWidth ? docWidth - vpWidth : 0,
      elementsOutsideViewport: [],
      fixedWidthElements: [],
    },
    collectedAt: new Date().toISOString(),
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'PING') {
    sendResponse({ pong: true });
    return true;
  }

  if (message.type === 'COLLECT_EVIDENCE') {
    try {
      sendResponse({ success: true, evidence: collectEvidence() });
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : 'Content script failed',
      });
    }
  }

  if (message.type === 'START_ELEMENT_SELECTION') {
    try {
      startElementSelection();
      sendResponse({ success: true });
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : 'Could not enter selection mode on this page.',
      });
    }
  }

  if (message.type === 'CANCEL_ELEMENT_SELECTION') {
    cancelElementSelection();
    sendResponse({ success: true });
  }

  return true;
});
