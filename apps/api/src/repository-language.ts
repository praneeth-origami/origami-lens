import * as path from 'node:path';

/**
 * Every language this phase can detect. `html` is deliberately detected but
 * never parsed (see GRAMMAR_WASM_FILE) — markup has no natural
 * function/class-shaped "symbol" the way the other languages do, and
 * decomposing it by tag would mostly produce noise (divs/spans), which the
 * spec explicitly warns against. `unknown` covers every other extension.
 */
export type DetectedLanguage =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'jsx'
  | 'python'
  | 'java'
  | 'go'
  | 'rust'
  | 'c'
  | 'cpp'
  | 'css'
  | 'json'
  | 'html'
  | 'unknown';

const EXTENSION_TO_LANGUAGE: Record<string, DetectedLanguage> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'jsx',
  '.py': 'python',
  '.pyi': 'python',
  '.java': 'java',
  '.go': 'go',
  '.rs': 'rust',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.css': 'css',
  '.json': 'json',
  '.html': 'html',
  '.htm': 'html',
};

/**
 * Deterministic, extension-first language detection — the only detection
 * strategy this phase uses (no content sniffing/shebang parsing), matching
 * "use file extension first" and keeping the same input always producing the
 * same language.
 */
export function detectLanguage(filePath: string): DetectedLanguage {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? 'unknown';
}

/**
 * The Tree-sitter grammar (from the `tree-sitter-wasms` bundle) used to
 * parse each language. `javascript` and `jsx` intentionally share the same
 * grammar file — the plain JavaScript grammar already understands JSX
 * syntax, so a dedicated jsx.wasm is unnecessary (verified against actual
 * .jsx-shaped source during development). `html`/`unknown` have no entry:
 * see isParseableLanguage.
 */
export const GRAMMAR_WASM_FILE: Partial<Record<DetectedLanguage, string>> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  jsx: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  java: 'tree-sitter-java.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  css: 'tree-sitter-css.wasm',
  json: 'tree-sitter-json.wasm',
};

export function isParseableLanguage(language: DetectedLanguage): boolean {
  return language in GRAMMAR_WASM_FILE;
}
