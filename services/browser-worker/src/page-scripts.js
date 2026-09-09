export function collectPageEvidence() {
  function getSelector(el) {
    if (el.id) return '#' + el.id;
    var tag = el.tagName.toLowerCase();
    var cls = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
    return tag + cls;
  }

  function collectFormElements(selector, limit) {
    limit = limit || 50;
    return Array.from(document.querySelectorAll(selector)).slice(0, limit).map(function (el) {
      var rect = el.getBoundingClientRect();
      var attrs = {};
      Array.from(el.attributes).forEach(function (attr) {
        attrs[attr.name] = attr.value;
      });

      var labelText = '';
      var hasAssociatedLabel = false;
      var elId = el.id;
      if (elId) {
        var labelFor = document.querySelector('label[for="' + elId.replace(/"/g, '\\"') + '"]');
        if (labelFor) {
          labelText = (labelFor.textContent || '').trim();
          hasAssociatedLabel = labelText.length > 0;
        }
      }
      if (!hasAssociatedLabel) {
        var parentLabel = el.closest('label');
        if (parentLabel) {
          labelText = (parentLabel.textContent || '').trim();
          hasAssociatedLabel = labelText.length > 0;
        }
      }

      return {
        selector: getSelector(el),
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 200),
        attributes: attrs,
        boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        labelText: labelText,
        hasAssociatedLabel: hasAssociatedLabel,
      };
    });
  }

  function collectElements(selector, limit) {
    if (selector.indexOf('input:not') >= 0 || selector === 'select, textarea' ||
        selector.indexOf('select') >= 0 && selector.indexOf('textarea') >= 0) {
      return collectFormElements(selector, limit);
    }
    limit = limit || 50;
    return Array.from(document.querySelectorAll(selector)).slice(0, limit).map(function (el) {
      var rect = el.getBoundingClientRect();
      var attrs = {};
      Array.from(el.attributes).forEach(function (attr) {
        attrs[attr.name] = attr.value;
      });
      return {
        selector: getSelector(el),
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 200),
        attributes: attrs,
        boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    });
  }

  var metaDescriptionEl = document.querySelector('meta[name="description"]');
  var metaDescription = metaDescriptionEl ? metaDescriptionEl.getAttribute('content') || '' : '';
  var canonicalEl = document.querySelector('link[rel="canonical"]');
  var robotsEl = document.querySelector('meta[name="robots"]');
  var viewportMetaEl = document.querySelector('meta[name="viewport"]');

  var docWidth = Math.max(document.documentElement.scrollWidth, (document.body && document.body.scrollWidth) || 0);
  var docHeight = Math.max(document.documentElement.scrollHeight, (document.body && document.body.scrollHeight) || 0);
  var vpWidth = window.innerWidth;
  var horizontalOverflow = docWidth > vpWidth + 1;

  var outsideViewport = [];
  document.querySelectorAll('a, button, img, h1, h2, input').forEach(function (el) {
    var rect = el.getBoundingClientRect();
    if (rect.right < 0 || rect.left > vpWidth || rect.bottom < 0) {
      var attrs = {};
      Array.from(el.attributes).forEach(function (attr) {
        attrs[attr.name] = attr.value;
      });
      outsideViewport.push({
        selector: getSelector(el),
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 100),
        attributes: attrs,
        boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
    }
  });

  var perf = performance.getEntriesByType('navigation')[0];
  var navTiming = {};
  if (perf) {
    navTiming.domContentLoaded = perf.domContentLoadedEventEnd - perf.startTime;
    navTiming.loadComplete = perf.loadEventEnd - perf.startTime;
    navTiming.ttfb = perf.responseStart - perf.startTime;
  }

  return {
    title: document.title,
    description: metaDescription,
    canonical: canonicalEl ? canonicalEl.getAttribute('href') || '' : '',
    robots: robotsEl ? robotsEl.getAttribute('content') || '' : '',
    viewportMeta: viewportMetaEl ? viewportMetaEl.getAttribute('content') || '' : '',
    lang: document.documentElement.lang,
    documentDimensions: { width: docWidth, height: docHeight },
    viewport: { width: vpWidth, height: window.innerHeight },
    layout: {
      horizontalOverflow: horizontalOverflow,
      overflowWidth: horizontalOverflow ? docWidth - vpWidth : 0,
      elementsOutsideViewport: outsideViewport.slice(0, 20),
      fixedWidthElements: [],
    },
    dom: {
      headings: collectElements('h1, h2, h3, h4, h5, h6'),
      images: collectElements('img'),
      links: collectElements('a[href]'),
      buttons: collectElements('button, [role="button"], input[type="button"], input[type="submit"]'),
      forms: collectFormElements('input:not([type="hidden"]), select, textarea'),
      iframes: collectElements('iframe'),
    },
    navigationTiming: navTiming,
  };
}

export function collectLayoutEvidence() {
  var docWidth = Math.max(document.documentElement.scrollWidth, (document.body && document.body.scrollWidth) || 0);
  var vpWidth = window.innerWidth;
  var horizontalOverflow = docWidth > vpWidth + 1;
  var outsideViewport = [];

  document.querySelectorAll('a, button, img').forEach(function (el) {
    var rect = el.getBoundingClientRect();
    if (rect.right < 0 || rect.left > vpWidth) {
      outsideViewport.push({
        selector: el.tagName.toLowerCase(),
        tag: el.tagName.toLowerCase(),
        attributes: {},
        boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
    }
  });

  return {
    horizontalOverflow: horizontalOverflow,
    overflowWidth: horizontalOverflow ? docWidth - vpWidth : 0,
    elementsOutsideViewport: outsideViewport.slice(0, 20),
    fixedWidthElements: [],
  };
}

export function runAxeInBrowser() {
  return window.axe.run();
}
