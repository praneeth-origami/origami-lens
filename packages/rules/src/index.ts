import type {
  BrowserEvidence,
  Issue,
  IssueCategory,
  IssueSource,
  RuleDefinition,
  RuleMatch,
  Severity,
} from '@origami/contracts';
import { randomUUID } from 'node:crypto';

export const RULE_DEFINITIONS: RuleDefinition[] = [
  // Functional
  {
    ruleId: 'FUNC_CONSOLE_ERROR',
    category: 'functional',
    severity: 'CRITICAL',
    confidence: 0.95,
    impact: 'JavaScript errors can break page functionality for users.',
    title: 'Console error detected',
    description: 'A JavaScript error occurred in the browser console.',
    type: 'CONSOLE_ERROR',
    source: 'cdp',
    problem: 'A JavaScript error was logged in the browser console.',
    cause: 'Uncaught exception or runtime error in page scripts.',
    suggestedFix: 'Inspect the console stack trace and fix the underlying JavaScript error.',
  },
  {
    ruleId: 'FUNC_NETWORK_FAILURE',
    category: 'functional',
    severity: 'HIGH',
    confidence: 0.9,
    impact: 'Failed network requests may break features or content loading.',
    title: 'Failed network request',
    description: 'A network request failed or returned an error status.',
    type: 'NETWORK_FAILURE',
    source: 'cdp',
    problem: 'A network request failed or returned a 4xx/5xx status.',
    cause: 'Server error, broken endpoint, or blocked resource.',
    suggestedFix: 'Verify the failing URL, server response, and CORS configuration.',
  },
  {
    ruleId: 'FUNC_EMPTY_BUTTON',
    category: 'functional',
    severity: 'HIGH',
    confidence: 0.85,
    impact: 'Users may not understand what the button does.',
    title: 'Empty button',
    description: 'Button has no visible text and no accessible name.',
    type: 'EMPTY_BUTTON',
    source: 'origami-rule',
    problem: 'An interactive button lacks visible text and accessible name.',
    cause: 'Button element is missing inner text, aria-label, or aria-labelledby.',
    suggestedFix: 'Add visible button text or an aria-label attribute.',
  },
  {
    ruleId: 'FUNC_EMPTY_LINK',
    category: 'functional',
    severity: 'LOW',
    confidence: 0.85,
    impact: 'Users may not know where the link goes.',
    title: 'Empty or unusable link',
    description: 'Link has empty href or no accessible text.',
    type: 'EMPTY_LINK',
    source: 'origami-rule',
    problem: 'A link is empty or points to an unusable destination.',
    cause: 'Missing href, placeholder href, or missing link text.',
    suggestedFix: 'Provide a valid href and descriptive link text.',
  },
  // Visual / Mobile
  {
    ruleId: 'VIS_HORIZONTAL_OVERFLOW',
    category: 'visualMobile',
    severity: 'HIGH',
    confidence: 0.9,
    impact: 'Horizontal scrolling frustrates mobile users.',
    title: 'Horizontal page overflow',
    description: 'Page content extends beyond the viewport width.',
    type: 'HORIZONTAL_OVERFLOW',
    source: 'playwright',
    problem: 'The page causes horizontal scrolling on the current viewport.',
    cause: 'Fixed-width elements or content wider than the viewport.',
    suggestedFix: 'Use responsive layouts, max-width: 100%, and overflow-x: hidden where appropriate.',
  },
  {
    ruleId: 'VIS_ELEMENT_OUTSIDE_VIEWPORT',
    category: 'visualMobile',
    severity: 'MEDIUM',
    confidence: 0.8,
    impact: 'Content may be clipped or unreachable on smaller screens.',
    title: 'Element outside viewport',
    description: 'An element extends beyond the visible viewport.',
    type: 'ELEMENT_OUTSIDE_VIEWPORT',
    source: 'playwright',
    problem: 'Important content may be positioned outside the visible area.',
    cause: 'Absolute/fixed positioning or non-responsive layout.',
    suggestedFix: 'Adjust layout and positioning for the target viewport size.',
  },
  {
    ruleId: 'VIS_TINY_TOUCH_TARGET',
    category: 'visualMobile',
    severity: 'LOW',
    confidence: 0.75,
    impact: 'Small touch targets are hard to tap on mobile.',
    title: 'Tiny touch target',
    description: 'Interactive element is smaller than recommended touch target size.',
    type: 'TINY_TOUCH_TARGET',
    source: 'playwright',
    problem: 'An interactive element is too small for comfortable mobile use.',
    cause: 'Button or link dimensions below 44x44px recommended minimum.',
    suggestedFix: 'Increase padding or minimum dimensions to at least 44x44 pixels.',
  },
  // Performance
  {
    ruleId: 'PERF_LARGE_IMAGE',
    category: 'performance',
    severity: 'HIGH',
    confidence: 0.85,
    impact: 'Large images slow page load and increase bandwidth usage.',
    title: 'Large image resource',
    description: 'An image exceeds the recommended size threshold.',
    type: 'LARGE_IMAGE',
    source: 'playwright',
    problem: 'A large image resource was detected.',
    cause: 'Unoptimized or oversized image served to users.',
    suggestedFix: 'Compress, resize, and serve appropriately sized images with modern formats.',
  },
  {
    ruleId: 'PERF_SLOW_LCP',
    category: 'performance',
    severity: 'HIGH',
    confidence: 0.85,
    impact: 'Slow LCP degrades perceived load performance.',
    title: 'Slow Largest Contentful Paint',
    description: 'LCP exceeds recommended threshold.',
    type: 'SLOW_LCP',
    source: 'lighthouse',
    problem: 'Largest Contentful Paint is slower than recommended.',
    cause: 'Slow server response, render-blocking resources, or large hero content.',
    suggestedFix: 'Optimize LCP element loading: preload hero image, reduce blocking JS/CSS.',
  },
  {
    ruleId: 'PERF_HIGH_CLS',
    category: 'performance',
    severity: 'HIGH',
    confidence: 0.85,
    impact: 'Layout shifts create a jarring user experience.',
    title: 'High Cumulative Layout Shift',
    description: 'CLS exceeds recommended threshold.',
    type: 'HIGH_CLS',
    source: 'lighthouse',
    problem: 'The page has significant unexpected layout shifts.',
    cause: 'Images without dimensions, dynamic content injection, or web fonts.',
    suggestedFix: 'Set explicit width/height on media, reserve space for dynamic content.',
  },
  // Accessibility
  {
    ruleId: 'A11Y_MISSING_ALT',
    category: 'accessibility',
    severity: 'MEDIUM',
    confidence: 0.95,
    impact: 'Screen reader users cannot understand image content.',
    title: 'Missing image alt text',
    description: 'Image is missing alt attribute.',
    type: 'MISSING_IMAGE_ALT',
    source: 'origami-rule',
    problem: 'An image does not have alternative text.',
    cause: 'The img element is missing an alt attribute.',
    suggestedFix: 'Add meaningful alternative text using the alt attribute.',
  },
  {
    ruleId: 'A11Y_MISSING_FORM_LABEL',
    category: 'accessibility',
    severity: 'HIGH',
    confidence: 0.9,
    impact: 'Form fields without labels are inaccessible to assistive technology.',
    title: 'Missing form label',
    description: 'Form input lacks associated label or accessible name.',
    type: 'MISSING_FORM_LABEL',
    source: 'origami-rule',
    problem: 'A form input has no associated label.',
    cause: 'Missing label element, aria-label, or aria-labelledby.',
    suggestedFix: 'Associate a visible label or provide aria-label on the input.',
  },
  {
    ruleId: 'A11Y_AXE_VIOLATION',
    category: 'accessibility',
    severity: 'HIGH',
    confidence: 0.95,
    impact: 'Accessibility violation detected by axe-core.',
    title: 'Accessibility violation',
    description: 'axe-core detected an accessibility rule violation.',
    type: 'AXE_VIOLATION',
    source: 'axe-core',
    problem: 'An accessibility rule was violated.',
    cause: 'Deterministic WCAG-related issue detected by axe-core.',
    suggestedFix: 'Review the axe violation details and apply the recommended fix.',
  },
  // Best Practices
  {
    ruleId: 'BP_DEPRECATED_PATTERN',
    category: 'bestPractices',
    severity: 'LOW',
    confidence: 0.7,
    impact: 'Deprecated patterns may break in future browser versions.',
    title: 'Deprecated HTML pattern',
    description: 'Page uses deprecated HTML elements or attributes.',
    type: 'DEPRECATED_PATTERN',
    source: 'origami-rule',
    problem: 'Deprecated HTML patterns were detected.',
    cause: 'Use of legacy elements like center, font, or obsolete attributes.',
    suggestedFix: 'Replace deprecated markup with modern semantic HTML and CSS.',
  },
  // SEO
  {
    ruleId: 'SEO_MISSING_TITLE',
    category: 'seo',
    severity: 'HIGH',
    confidence: 0.95,
    impact: 'Missing title hurts search rankings and browser tab clarity.',
    title: 'Missing page title',
    description: 'Document title is empty or missing.',
    type: 'MISSING_TITLE',
    source: 'origami-rule',
    problem: 'The page is missing a document title.',
    cause: 'Empty or absent title element in the document head.',
    suggestedFix: 'Add a descriptive title element in the head section.',
  },
  {
    ruleId: 'SEO_MISSING_DESCRIPTION',
    category: 'seo',
    severity: 'LOW',
    confidence: 0.9,
    impact: 'Missing meta description reduces search snippet quality.',
    title: 'Missing meta description',
    description: 'Page lacks meta description.',
    type: 'MISSING_DESCRIPTION',
    source: 'origami-rule',
    problem: 'The page is missing a meta description.',
    cause: 'No meta name="description" tag in document head.',
    suggestedFix: 'Add a concise meta description summarizing the page content.',
  },
  {
    ruleId: 'SEO_POOR_HEADINGS',
    category: 'seo',
    severity: 'LOW',
    confidence: 0.8,
    impact: 'Poor heading structure hurts SEO and accessibility.',
    title: 'Poor heading structure',
    description: 'Heading hierarchy has gaps or missing h1.',
    type: 'POOR_HEADING_STRUCTURE',
    source: 'origami-rule',
    problem: 'The page has a poor heading hierarchy.',
    cause: 'Missing h1 or skipped heading levels.',
    suggestedFix: 'Use a single h1 and sequential heading levels without skipping.',
  },
  // Security Hygiene
  {
    ruleId: 'SEC_MIXED_CONTENT',
    category: 'securityHygiene',
    severity: 'HIGH',
    confidence: 0.9,
    impact: 'Mixed content can be blocked and exposes users to downgrade attacks.',
    title: 'Mixed content detected',
    description: 'HTTPS page loads HTTP resources.',
    type: 'MIXED_CONTENT',
    source: 'cdp',
    problem: 'The HTTPS page loads insecure HTTP resources.',
    cause: 'Hardcoded http:// URLs for scripts, images, or other assets.',
    suggestedFix: 'Update all resource URLs to use HTTPS.',
  },
  {
    ruleId: 'SEC_INSECURE_RESOURCE',
    category: 'securityHygiene',
    severity: 'LOW',
    confidence: 0.85,
    impact: 'Insecure resources may be blocked by browsers.',
    title: 'Insecure resource loading',
    description: 'Page loads resources over insecure connection.',
    type: 'INSECURE_RESOURCE',
    source: 'cdp',
    problem: 'Insecure resources were detected on the page.',
    cause: 'HTTP resources or missing security attributes.',
    suggestedFix: 'Serve all resources over HTTPS and review CSP headers.',
  },
];

const LARGE_IMAGE_THRESHOLD_BYTES = 500_000;
const LCP_THRESHOLD_MS = 2500;
const CLS_THRESHOLD = 0.1;
const MIN_TOUCH_TARGET = 44;

function getRule(ruleId: string): RuleDefinition {
  const rule = RULE_DEFINITIONS.find((r) => r.ruleId === ruleId);
  if (!rule) throw new Error(`Unknown rule: ${ruleId}`);
  return rule;
}

export function runOrigamiRules(evidence: BrowserEvidence): RuleMatch[] {
  const matches: RuleMatch[] = [];

  // Functional: console errors
  for (const entry of evidence.console.filter((c) => c.type === 'error' || c.type === 'exception')) {
    matches.push({
      rule: getRule('FUNC_CONSOLE_ERROR'),
      evidence: { message: entry.message, stack: entry.stack },
    });
  }

  // Functional: network failures
  for (const req of evidence.network.filter((n) => n.failed || n.status >= 400)) {
    matches.push({
      rule: getRule('FUNC_NETWORK_FAILURE'),
      evidence: { url: req.url, statusCode: req.status, message: `HTTP ${req.status}` },
    });
  }

  // Functional: empty buttons
  for (const btn of evidence.dom.buttons) {
    const hasText = Boolean(btn.text?.trim());
    const hasAria = Boolean(btn.attributes['aria-label'] || btn.attributes['aria-labelledby']);
    if (!hasText && !hasAria) {
      matches.push({
        rule: getRule('FUNC_EMPTY_BUTTON'),
        evidence: { selector: btn.selector, snippet: btn.tag },
      });
    }
  }

  // Functional: empty links
  for (const link of evidence.dom.links) {
    const href = link.attributes.href ?? '';
    const hasText = Boolean(link.text?.trim());
    const hasAria = Boolean(link.attributes['aria-label']);
    if (!href || href === '#' || href === 'javascript:void(0)' || !hasText && !hasAria) {
      matches.push({
        rule: getRule('FUNC_EMPTY_LINK'),
        evidence: { selector: link.selector, value: href },
      });
    }
  }

  // Visual: horizontal overflow
  if (evidence.layout.horizontalOverflow) {
    matches.push({
      rule: getRule('VIS_HORIZONTAL_OVERFLOW'),
      evidence: {
        overflowWidth: evidence.layout.overflowWidth,
        viewport: evidence.viewport,
      },
    });
  }

  // Visual: elements outside viewport
  for (const el of evidence.layout.elementsOutsideViewport.slice(0, 10)) {
    matches.push({
      rule: getRule('VIS_ELEMENT_OUTSIDE_VIEWPORT'),
      evidence: { selector: el.selector, boundingBox: el.boundingBox },
    });
  }

  // Visual: tiny touch targets (mobile viewport)
  if (evidence.viewport.width <= 480) {
    for (const el of [...evidence.dom.buttons, ...evidence.dom.links]) {
      const box = el.boundingBox;
      if (box && (box.width < MIN_TOUCH_TARGET || box.height < MIN_TOUCH_TARGET)) {
        matches.push({
          rule: getRule('VIS_TINY_TOUCH_TARGET'),
          evidence: { selector: el.selector, boundingBox: box },
          groupKey: 'tiny-touch-targets',
        });
      }
    }
  }

  // Performance: large images via network
  for (const req of evidence.network.filter((n) => n.resourceType === 'image' && (n.size ?? 0) > LARGE_IMAGE_THRESHOLD_BYTES)) {
    matches.push({
      rule: getRule('PERF_LARGE_IMAGE'),
      evidence: { url: req.url, metric: 'size', metricValue: req.size },
    });
  }

  // Performance: LCP / CLS from metrics
  if (evidence.performance.lcp !== undefined && evidence.performance.lcp > LCP_THRESHOLD_MS) {
    matches.push({
      rule: getRule('PERF_SLOW_LCP'),
      evidence: { metric: 'LCP', metricValue: evidence.performance.lcp },
    });
  }
  if (evidence.performance.cls !== undefined && evidence.performance.cls > CLS_THRESHOLD) {
    matches.push({
      rule: getRule('PERF_HIGH_CLS'),
      evidence: { metric: 'CLS', metricValue: evidence.performance.cls },
    });
  }

  // Accessibility: missing alt
  const missingAltImages = evidence.dom.images.filter(
    (img) => !('alt' in img.attributes) || img.attributes.alt === undefined,
  );
  if (missingAltImages.length > 0) {
    matches.push({
      rule: getRule('A11Y_MISSING_ALT'),
      evidence: {
        count: missingAltImages.length,
        items: missingAltImages.slice(0, 5).map((img) => ({ selector: img.selector, url: img.attributes.src })),
        selector: missingAltImages[0]?.selector,
      },
      groupKey: 'missing-alt',
    });
  }

  // Accessibility: missing form labels
  for (const form of evidence.dom.forms) {
    const hasAriaLabel = Boolean(form.attributes['aria-label'] || form.attributes['aria-labelledby']);
    const hasLabel = Boolean(
      form.hasAssociatedLabel ||
        (form.labelText && form.labelText.trim()) ||
        hasAriaLabel,
    );
    const isHidden = form.attributes.type === 'hidden';
    if (!isHidden && !hasLabel && !form.text?.trim()) {
      matches.push({
        rule: getRule('A11Y_MISSING_FORM_LABEL'),
        evidence: { selector: form.selector, attribute: form.attributes.type ?? 'input' },
      });
    }
  }

  // Best practices: deprecated patterns (check headings for center tag etc via attributes)
  const deprecatedTags = evidence.dom.headings.filter((h) =>
    ['center', 'font', 'marquee'].includes(h.tag.toLowerCase()),
  );
  for (const el of deprecatedTags) {
    matches.push({
      rule: getRule('BP_DEPRECATED_PATTERN'),
      evidence: { selector: el.selector, snippet: el.tag },
    });
  }

  // SEO
  if (!evidence.page.title?.trim()) {
    matches.push({ rule: getRule('SEO_MISSING_TITLE'), evidence: { url: evidence.page.url } });
  }
  if (!evidence.page.description?.trim()) {
    matches.push({ rule: getRule('SEO_MISSING_DESCRIPTION'), evidence: { url: evidence.page.url } });
  }

  const h1Count = evidence.dom.headings.filter((h) => h.tag === 'h1').length;
  if (h1Count === 0 || h1Count > 1) {
    matches.push({
      rule: getRule('SEO_POOR_HEADINGS'),
      evidence: { metric: 'h1Count', metricValue: h1Count },
    });
  }

  // Security: mixed content on HTTPS pages
  if (evidence.page.url.startsWith('https://')) {
    const insecure = evidence.network.filter((n) => n.url.startsWith('http://'));
    for (const req of insecure) {
      matches.push({
        rule: getRule('SEC_MIXED_CONTENT'),
        evidence: { url: req.url },
        groupKey: 'mixed-content',
      });
    }
  }

  return matches;
}

export function normalizeAxeViolations(axeResult: Record<string, unknown>): RuleMatch[] {
  const violations = (axeResult.violations as Array<Record<string, unknown>>) ?? [];
  const matches: RuleMatch[] = [];

  for (const violation of violations) {
    const nodes = (violation.nodes as Array<Record<string, unknown>>) ?? [];
    const rule = getRule('A11Y_AXE_VIOLATION');
    matches.push({
      rule: {
        ...rule,
        title: String(violation.help ?? rule.title),
        type: String(violation.id ?? 'AXE_VIOLATION'),
        severity: mapAxeImpact(String(violation.impact ?? 'moderate')),
      },
      evidence: {
        message: String(violation.description ?? ''),
        count: nodes.length,
        items: nodes.slice(0, 3).map((n) => ({
          selector: String((n.target as string[])?.[0] ?? ''),
          snippet: String(n.html ?? ''),
        })),
      },
      groupKey: `axe-${String(violation.id)}`,
    });
  }

  return matches;
}

function mapAxeImpact(impact: string): Severity {
  switch (impact) {
    case 'critical':
      return 'CRITICAL';
    case 'serious':
      return 'HIGH';
    case 'moderate':
      return 'MEDIUM';
    default:
      return 'LOW';
  }
}

export function normalizeLighthouseAudits(lighthouse: Record<string, unknown>): RuleMatch[] {
  const matches: RuleMatch[] = [];
  const audits = lighthouse.audits as Record<string, { score?: number | null; displayValue?: string; title?: string; description?: string; id?: string }> | undefined;
  if (!audits) return matches;

  for (const [auditId, audit] of Object.entries(audits)) {
    if (audit.score === null || audit.score === undefined) continue;
    if (audit.score >= 0.9) continue;

    const category = inferLighthouseCategory(auditId);
    const severity: Severity = audit.score < 0.5 ? 'HIGH' : 'MEDIUM';

    matches.push({
      rule: {
        ruleId: `LH_${auditId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`,
        category,
        severity,
        confidence: 0.85,
        impact: audit.description ?? 'Lighthouse audit failure.',
        title: audit.title ?? auditId,
        description: audit.description ?? '',
        type: auditId.toUpperCase(),
        source: 'lighthouse' as IssueSource,
        problem: audit.title ?? auditId,
        cause: audit.description ?? 'Lighthouse detected an issue.',
        suggestedFix: 'Review Lighthouse audit recommendations.',
      },
      evidence: {
        metric: auditId,
        metricValue: audit.displayValue ?? audit.score,
        message: audit.description,
      },
      groupKey: `lh-${auditId}`,
    });
  }

  return matches;
}

function inferLighthouseCategory(auditId: string): IssueCategory {
  if (auditId.includes('seo') || auditId.startsWith('meta-') || auditId.includes('canonical')) return 'seo';
  if (auditId.includes('accessibility') || auditId.includes('aria') || auditId.includes('alt')) return 'accessibility';
  if (auditId.includes('security') || auditId.includes('mixed')) return 'securityHygiene';
  if (auditId.includes('render') || auditId.includes('lcp') || auditId.includes('cls') || auditId.includes('speed')) return 'performance';
  if (auditId.includes('best')) return 'bestPractices';
  return 'bestPractices';
}

export function groupRuleMatches(matches: RuleMatch[]): RuleMatch[] {
  const grouped = new Map<string, RuleMatch>();

  for (const match of matches) {
    const key = match.groupKey ?? `${match.rule.ruleId}:${match.evidence.selector ?? match.evidence.url ?? randomUUID()}`;
    const existing = grouped.get(key);
    if (existing && match.groupKey) {
      const count = ((existing.evidence.count as number) ?? 1) + 1;
      grouped.set(key, {
        ...existing,
        evidence: { ...existing.evidence, count },
      });
    } else if (!existing) {
      grouped.set(key, { ...match, evidence: { ...match.evidence, count: match.evidence.count ?? 1 } });
    } else {
      grouped.set(`${key}-${randomUUID()}`, match);
    }
  }

  return Array.from(grouped.values());
}

export function ruleMatchesToIssues(matches: RuleMatch[]): Issue[] {
  return matches.map((match) => ({
    id: randomUUID(),
    category: match.rule.category,
    type: match.rule.type,
    ruleId: match.rule.ruleId,
    severity: match.rule.severity,
    title: match.evidence.count && match.evidence.count > 1
      ? `${match.evidence.count} ${match.rule.title.replace(/^Missing /, 'items missing ').replace(/^An /, 'items ')}`
      : match.rule.title,
    evidence: match.evidence,
    confidence: match.rule.confidence,
    impact: match.rule.impact,
    source: match.rule.source,
    problem: match.rule.problem,
    cause: match.rule.cause,
    suggestedFix: match.rule.suggestedFix,
    groupKey: match.groupKey,
  }));
}

export class OrigamiRuleEngine {
  evaluate(evidence: BrowserEvidence): Issue[] {
    const matches: RuleMatch[] = [
      ...runOrigamiRules(evidence),
    ];

    if (evidence.axe) {
      matches.push(...normalizeAxeViolations(evidence.axe));
    }

    if (evidence.lighthouse) {
      matches.push(...normalizeLighthouseAudits(evidence.lighthouse));
    }

    const grouped = groupRuleMatches(matches);
    return ruleMatchesToIssues(grouped);
  }
}

export { IssueNormalizer } from './normalizer.js';
export { aggregateWebsiteIssues } from './website-aggregator.js';
