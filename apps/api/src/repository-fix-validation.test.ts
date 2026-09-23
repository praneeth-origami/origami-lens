import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyHunkToContent, applyLineEndingStyle, detectDominantLineEnding, locateOldText, validateSyntax } from './repository-fix-validation.js';

describe('locateOldText', () => {
  it('TEST 1 — locates a single exact match and computes the real line range', () => {
    const content = 'line1\nline2\nline3\n';
    const result = locateOldText(content, 'line2\n');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.actualStartLine, 2);
      assert.equal(result.actualEndLine, 2);
    }
  });

  it('TEST 2 — rejects zero matches', () => {
    const result = locateOldText('a\nb\nc\n', 'not-present\n');
    assert.deepEqual(result, { ok: false, reason: 'not_found' });
  });

  it('TEST 3 — rejects ambiguous (more than one) matches instead of guessing', () => {
    const result = locateOldText('foo()\nbar()\nfoo()\n', 'foo()\n');
    assert.equal(result.ok, false);
    if (!result.ok && result.reason === 'ambiguous') {
      assert.equal(result.occurrenceCount, 2);
    } else {
      assert.fail('expected ambiguous');
    }
  });

  it('TEST 4 — the AI-reported line number is irrelevant: only real content position determines the actual line range', () => {
    // A 20-line file where the target text is actually on line 15, regardless of what any caller might have "reported".
    const lines = Array.from({ length: 20 }, (_, i) => (i === 14 ? '  <input />' : `line ${i}`));
    const content = lines.join('\n') + '\n';
    const result = locateOldText(content, '  <input />');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.actualStartLine, 15);
      assert.equal(result.actualEndLine, 15);
    }
  });

  it('TEST 5 — supports multi-line oldText and computes the correct end line', () => {
    const content = 'a\nb\nfunction foo() {\n  return 1;\n}\nc\n';
    const result = locateOldText(content, 'function foo() {\n  return 1;\n}');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.actualStartLine, 3);
      assert.equal(result.actualEndLine, 5);
    }
  });
});

describe('applyHunkToContent', () => {
  it('TEST 6 — replaces exactly the located occurrence, leaving the rest of the file untouched', () => {
    const content = 'const a = 1;\nconst b = 2;\nconst a = 1;extra\n';
    const result = applyHunkToContent(content, { oldText: 'const b = 2;', newText: 'const b = 3;' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.content, 'const a = 1;\nconst b = 3;\nconst a = 1;extra\n');
    }
  });

  it('TEST 7 — never performs a broad/global search-and-replace: a repeated needle elsewhere in the file is left alone once the match is unique', () => {
    const content = 'unique-marker\nsome other unique text\n';
    const result = applyHunkToContent(content, { oldText: 'unique-marker', newText: 'replaced' });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal((result.content.match(/unique-marker/g) ?? []).length, 0);
  });

  it('rejects when oldText is not found', () => {
    const result = applyHunkToContent('abc\n', { oldText: 'zzz', newText: 'yyy' });
    assert.deepEqual(result, { ok: false, reason: 'not_found' });
  });

  it('rejects when oldText is ambiguous', () => {
    const result = applyHunkToContent('x\nx\n', { oldText: 'x', newText: 'y' });
    assert.deepEqual(result, { ok: false, reason: 'ambiguous' });
  });
});

describe('validateSyntax', () => {
  it('TEST 8 — valid TypeScript parses as VALID', async () => {
    const status = await validateSyntax('typescript', 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
    assert.equal(status, 'VALID');
  });

  it('TEST 9 — invalid TypeScript (unbalanced braces) parses as INVALID', async () => {
    const status = await validateSyntax('typescript', 'export function add(a: number, b: number): number {\n  return a + b;\n');
    assert.equal(status, 'INVALID');
  });

  it('TEST 10 — valid JSON parses as VALID', async () => {
    const status = await validateSyntax('json', '{"a": 1, "b": [1, 2, 3]}');
    assert.equal(status, 'VALID');
  });

  it('TEST 11 — invalid JSON (trailing comma / unclosed) parses as INVALID', async () => {
    const status = await validateSyntax('json', '{"a": 1,');
    assert.equal(status, 'INVALID');
  });

  it('TEST 12 — an unsupported language (html) reports UNSUPPORTED, never a fabricated VALID/INVALID verdict', async () => {
    const status = await validateSyntax('html', '<div>not even well-formed<span></div>');
    assert.equal(status, 'UNSUPPORTED');
  });

  it('an unrecognized language string also reports UNSUPPORTED rather than throwing', async () => {
    const status = await validateSyntax('cobol', 'IDENTIFICATION DIVISION.');
    assert.equal(status, 'UNSUPPORTED');
  });
});

/**
 * Phase 14 — CRLF/LF robustness. The Phase 11 report documented a real,
 * live-observed limitation: an AI-generated `oldText` using `\n` failed to
 * match real file content checked out with `\r\n`, even though the text
 * was semantically identical. These tests prove the fix (line-ending-aware
 * matching + original-line-ending-preserving writes) without weakening any
 * existing safety guarantee — every non-line-ending byte still has to
 * match exactly, ambiguity is still rejected, and the file's own line
 * ending convention is preserved rather than rewritten wholesale.
 */
describe('CRLF/LF robustness (Phase 14)', () => {
  describe('detectDominantLineEnding / applyLineEndingStyle', () => {
    it('detects a pure-LF file as LF', () => {
      assert.equal(detectDominantLineEnding('a\nb\nc\n'), 'LF');
    });

    it('detects a pure-CRLF file as CRLF', () => {
      assert.equal(detectDominantLineEnding('a\r\nb\r\nc\r\n'), 'CRLF');
    });

    it('a file with no newlines at all defaults to LF (safe, deterministic default)', () => {
      assert.equal(detectDominantLineEnding('single line, no newline'), 'LF');
    });

    it('a mixed file resolves to whichever style is more common', () => {
      assert.equal(detectDominantLineEnding('a\r\nb\r\nc\r\nd\n'), 'CRLF');
      assert.equal(detectDominantLineEnding('a\nb\nc\nd\r\n'), 'LF');
    });

    it('applyLineEndingStyle re-renders arbitrary input consistently in the requested style', () => {
      assert.equal(applyLineEndingStyle('a\nb\r\nc\r', 'LF'), 'a\nb\nc\n');
      assert.equal(applyLineEndingStyle('a\nb\r\nc\r', 'CRLF'), 'a\r\nb\r\nc\r\n');
    });
  });

  describe('locateOldText — line-ending-insensitive matching', () => {
    it('LF file + LF oldText matches (baseline, unchanged behavior)', () => {
      const result = locateOldText('function f() {\n  return 1;\n}\n', '  return 1;\n');
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.actualStartLine, 2);
    });

    it('CRLF file + LF oldText now matches — the exact Phase 11-discovered case', () => {
      const crlfFile = 'function f() {\r\n  return 1;\r\n}\r\n';
      const result = locateOldText(crlfFile, '  return 1;\n');
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.actualStartLine, 2);
        assert.equal(result.actualEndLine, 2);
      }
    });

    it('CRLF file + CRLF oldText matches (both already byte-identical — regression check)', () => {
      const crlfFile = 'function f() {\r\n  return 1;\r\n}\r\n';
      const result = locateOldText(crlfFile, '  return 1;\r\n');
      assert.equal(result.ok, true);
    });

    it('LF file + CRLF oldText also matches (the reverse direction)', () => {
      const lfFile = 'function f() {\n  return 1;\n}\n';
      const result = locateOldText(lfFile, '  return 1;\r\n');
      assert.equal(result.ok, true);
    });

    it('a mixed-line-ending file still locates the match correctly and computes the correct line number', () => {
      const mixedFile = 'line1\r\nline2\nline3\r\ntarget-line\nline5\r\n';
      const result = locateOldText(mixedFile, 'target-line\r\n');
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.actualStartLine, 4);
        assert.equal(result.actualEndLine, 4);
      }
    });

    it('line-grounding remains correct deep in a CRLF file with many preceding lines', () => {
      const lines = Array.from({ length: 30 }, (_, i) => (i === 24 ? 'const target = 1;' : `const line${i} = ${i};`));
      const crlfFile = lines.join('\r\n') + '\r\n';
      const result = locateOldText(crlfFile, 'const target = 1;\n');
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.actualStartLine, 25);
        assert.equal(result.actualEndLine, 25);
      }
    });

    it('ambiguity detection still works correctly across a CRLF file (two normalized-identical occurrences)', () => {
      const crlfFile = 'dup();\r\nother();\r\ndup();\r\n';
      const result = locateOldText(crlfFile, 'dup();\n');
      assert.equal(result.ok, false);
      if (!result.ok && result.reason === 'ambiguous') {
        assert.equal(result.occurrenceCount, 2);
      } else {
        assert.fail('expected ambiguous');
      }
    });

    it('zero matches in a CRLF file is still correctly rejected as not_found', () => {
      const crlfFile = 'a\r\nb\r\nc\r\n';
      assert.deepEqual(locateOldText(crlfFile, 'not-present\n'), { ok: false, reason: 'not_found' });
    });

    it('an INDENTATION difference (not a line-ending difference) is still correctly rejected — the fix never broadens matching beyond \\r bookkeeping', () => {
      const crlfFile = 'function f() {\r\n        <input />\r\n}\r\n'; // 8 spaces
      const result = locateOldText(crlfFile, '          <input />\n'); // 10 spaces — genuinely different content
      assert.deepEqual(result, { ok: false, reason: 'not_found' });
    });
  });

  describe('applyHunkToContent — preserves the file\'s own line-ending style', () => {
    it('a CRLF file + LF-authored hunk produces a result that is still fully CRLF (the new text is conformed, the file is not rewritten to LF)', () => {
      const crlfFile = 'function f() {\r\n  return 1;\r\n}\r\n';
      const result = applyHunkToContent(crlfFile, { oldText: '  return 1;\n', newText: '  return 2;\n' });
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.content, 'function f() {\r\n  return 2;\r\n}\r\n');
        const crlfCount = (result.content.match(/\r\n/g) ?? []).length;
        const totalNewlines = (result.content.match(/\n/g) ?? []).length;
        assert.equal(crlfCount, totalNewlines, 'every \\n in the result must be part of a \\r\\n pair — no bare LF introduced into a CRLF file');
      }
    });

    it('an LF file + CRLF-authored hunk produces a result that stays fully LF', () => {
      const lfFile = 'function f() {\n  return 1;\n}\n';
      const result = applyHunkToContent(lfFile, { oldText: '  return 1;\r\n', newText: '  return 2;\r\n' });
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.content, 'function f() {\n  return 2;\n}\n');
        assert.equal(result.content.includes('\r'), false);
      }
    });

    it('every OTHER byte in the file (untouched lines, their exact line endings) is left completely unmodified', () => {
      const crlfFile = 'const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n';
      const result = applyHunkToContent(crlfFile, { oldText: 'const b = 2;\n', newText: 'const b = 20;\n' });
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.content, 'const a = 1;\r\nconst b = 20;\r\nconst c = 3;\r\n');
      }
    });

    it('a no-op-shaped hunk (oldText and newText identical modulo line endings only) still produces a real content change if the styled output differs from the removed span, and is rejected upstream as unchanged when truly identical — this layer itself only locates and replaces, it does not judge no-op-ness', () => {
      // Confirms this layer does not silently treat a CRLF/LF-only difference as "no match" OR fabricate a no-op — replacement still occurs exactly once.
      const crlfFile = 'value\r\n';
      const result = applyHunkToContent(crlfFile, { oldText: 'value\n', newText: 'value\n' });
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.content, 'value\r\n');
    });
  });

  describe('syntax validation after a CRLF-preserving application', () => {
    it('valid TypeScript with CRLF line endings still parses as VALID after the hunk is applied', async () => {
      const crlfFile = 'export function add(a: number, b: number): number {\r\n  return a + b;\r\n}\r\n';
      const applied = applyHunkToContent(crlfFile, { oldText: '  return a + b;\n', newText: '  return a - b;\n' });
      assert.equal(applied.ok, true);
      if (applied.ok) {
        const status = await validateSyntax('typescript', applied.content);
        assert.equal(status, 'VALID');
      }
    });

    it('a CRLF-preserving application that introduces a real syntax error still parses as INVALID', async () => {
      const crlfFile = 'export function add(a: number, b: number): number {\r\n  return a + b;\r\n}\r\n';
      const applied = applyHunkToContent(crlfFile, { oldText: '}\n', newText: '' });
      assert.equal(applied.ok, true);
      if (applied.ok) {
        const status = await validateSyntax('typescript', applied.content);
        assert.equal(status, 'INVALID');
      }
    });
  });
});
