/**
 * Verification Engine.
 *
 * `VerificationEngine.verify()` below is the original architecture stub for
 * future Playwright-based visual fix verification (Generate → Render →
 * Playwright → Compare → Verify) — still not implemented, still honest about it.
 *
 * `verifyGeneratedComponent()` is a REAL, currently-implemented verification
 * pass for Screenshot -> Code output: static/structural checks (non-empty
 * files, target-appropriate extensions, balanced braces/tags, no leaked
 * secrets, no obviously-truncated output). It does not check visual fidelity
 * — that remains future scope, same as VerificationEngine.verify().
 */
export interface VerificationRequest {
  url: string;
  fixDescription: string;
  originalScreenshot?: string;
}

export interface VerificationResult {
  verified: boolean;
  message: string;
  diffScore?: number;
  screenshot?: string;
}

export class VerificationEngine {
  async verify(_request: VerificationRequest): Promise<VerificationResult> {
    return {
      verified: false,
      message: 'Verification engine not yet implemented. Future: Generate → Render → Playwright → Compare → Verify.',
    };
  }
}

import type { CodeTarget, ComponentVerification, GeneratedFile } from '@origami/contracts';
import { scrubString } from '@origami/privacy';

const EXTENSIONS_BY_TARGET: Record<CodeTarget, string[]> = {
  REACT: ['.jsx', '.tsx', '.js'],
  NEXT_JS: ['.jsx', '.tsx', '.js'],
  TAILWIND: ['.jsx', '.tsx', '.js'],
  HTML_CSS: ['.html', '.css'],
};

const PLACEHOLDER_NAMES = new Set(['component1', 'testcomponent', 'aicomponent', 'component']);
const TRUNCATION_MARKERS = [
  '// ... rest of',
  '/* rest of',
  '// implementation here',
  '/* implementation here',
  '// todo: implement',
  '<!-- rest of',
];

function checkBalanced(content: string, open: string, close: string): boolean {
  let depth = 0;
  for (const ch of content) {
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/** Lightweight stack-based tag matcher for HTML output — not a full parser, but catches real unclosed/mismatched tags. */
function checkHtmlTagsBalanced(html: string): boolean {
  const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
  const stack: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(html)) !== null) {
    const [full, tagName, selfClose] = match;
    const lower = tagName.toLowerCase();
    if (VOID_TAGS.has(lower) || selfClose === '/') continue;
    if (full.startsWith('</')) {
      const top = stack.pop();
      if (top !== lower) return false;
    } else {
      stack.push(lower);
    }
  }
  return stack.length === 0;
}

function detectLeakedSecrets(content: string): boolean {
  return scrubString(content) !== content;
}

/**
 * Real, structural verification of AI-generated component code. Does not
 * claim visual/runtime correctness — only what it actually checks: the
 * output is non-empty, syntactically balanced, target-appropriate, and free
 * of obviously truncated or secret-leaking content.
 */
export function verifyGeneratedComponent(
  target: CodeTarget,
  componentName: string,
  files: GeneratedFile[],
): ComponentVerification {
  const issues: string[] = [];

  if (files.length === 0) {
    issues.push('No files were generated.');
    return { passed: false, issues };
  }

  if (!componentName || PLACEHOLDER_NAMES.has(componentName.trim().toLowerCase())) {
    issues.push(`Component name "${componentName}" looks like a placeholder rather than a descriptive name.`);
  }

  const expectedExtensions = EXTENSIONS_BY_TARGET[target];
  const hasExpectedExtension = files.some((f) => expectedExtensions.some((ext) => f.path.endsWith(ext)));
  if (!hasExpectedExtension) {
    issues.push(`No file matches the expected extensions for ${target} (${expectedExtensions.join(', ')}).`);
  }

  for (const file of files) {
    if (!file.content || !file.content.trim()) {
      issues.push(`${file.path} is empty.`);
      continue;
    }

    if (!checkBalanced(file.content, '{', '}')) {
      issues.push(`${file.path} has unbalanced braces.`);
    }
    if (!checkBalanced(file.content, '(', ')')) {
      issues.push(`${file.path} has unbalanced parentheses.`);
    }

    if (file.path.endsWith('.html') && !checkHtmlTagsBalanced(file.content)) {
      issues.push(`${file.path} has unclosed or mismatched HTML tags.`);
    }

    const lowerContent = file.content.toLowerCase();
    for (const marker of TRUNCATION_MARKERS) {
      if (lowerContent.includes(marker)) {
        issues.push(`${file.path} appears truncated (contains "${marker.trim()}").`);
        break;
      }
    }

    if (detectLeakedSecrets(file.content)) {
      issues.push(`${file.path} contains a secret-looking value (JWT/API key/card number) that must be redacted before use.`);
    }
  }

  return { passed: issues.length === 0, issues };
}
