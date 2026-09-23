import Parser from 'web-tree-sitter';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { GRAMMAR_WASM_FILE, type DetectedLanguage } from './repository-language.js';

type SyntaxNode = Parser.SyntaxNode;

const require = createRequire(import.meta.url);

/**
 * Tree-sitter is pure parsing only, nothing else: no code in a repository is
 * ever executed, imported, or evaluated — every operation in this module and
 * repository-chunker.ts is limited to walking the syntax tree and slicing
 * text out of it.
 */

let initPromise: Promise<void> | null = null;
function ensureInitialized(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  return initPromise;
}

const wasmDir = path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');
const languageCache = new Map<string, Promise<Parser.Language>>();

function loadGrammar(wasmFile: string): Promise<Parser.Language> {
  let cached = languageCache.get(wasmFile);
  if (!cached) {
    cached = ensureInitialized().then(() => Parser.Language.load(fs.readFileSync(path.join(wasmDir, wasmFile))));
    languageCache.set(wasmFile, cached);
  }
  return cached;
}

export interface ExtractedSymbol {
  symbol: string;
  symbolType: string;
  parentSymbol: string | null;
  /** 1-based, inclusive — see the module-level convention note in repository-index-service.ts. */
  startLine: number;
  endLine: number;
  /** 0-based, matching Tree-sitter's own (and most editors') column convention. */
  startColumn: number;
  endColumn: number;
  startIndex: number;
  endIndex: number;
  isExported: boolean;
  content: string;
}

export interface ExtractedImport {
  statement: string;
  startLine: number;
  endLine: number;
}

export interface FileAstResult {
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
  /** True if Tree-sitter's error-recovery kicked in anywhere in the file — the file is still processed (see the module comment on malformed source), this is informational only. */
  hasSyntaxError: boolean;
}

interface LangConfig {
  /** node.type -> our normalized symbolType, before refineType. */
  symbolNodeTypes: Record<string, string>;
  /** Node types collected as import/include statements. */
  importNodeTypes: string[];
  /** Checked before symbolNodeTypes — lets a language match a shape that isn't a single node type (e.g. `const X = () => {}`). */
  extraMatch?: (node: SyntaxNode) => string | null;
  getName: (node: SyntaxNode) => string | null;
  getIsExported: (node: SyntaxNode) => boolean;
  refineType?: (rawType: string, node: SyntaxNode, name: string) => string;
  /** Extra gate beyond "is this node type interesting" — used by JSON to keep only top-level keys. */
  shouldEmit?: (node: SyntaxNode) => boolean;
}

function defaultGetName(node: SyntaxNode): string | null {
  return node.childForFieldName('name')?.text ?? null;
}

function jsFamilyIsExported(node: SyntaxNode): boolean {
  // `const X = ...` symbols are matched on the variable_declarator, whose
  // export wrapper (if any) is one level further up than a plain
  // declaration's (variable_declarator -> lexical_declaration -> export_statement).
  const target = node.type === 'variable_declarator' ? (node.parent ?? node) : node;
  return target.parent?.type === 'export_statement';
}

function jsFamilyExtraMatch(node: SyntaxNode): string | null {
  if (node.type !== 'variable_declarator') return null;
  const value = node.childForFieldName('value');
  if (value && (value.type === 'arrow_function' || value.type === 'function_expression')) return 'function';
  return null;
}

function jsFamilyRefineType(rawType: string, _node: SyntaxNode, name: string): string {
  // Idiomatic React components are capitalized functions — a lowercase
  // `function` (or `const helper = () => {}`) stays a plain function.
  if (rawType === 'function' && /^[A-Z]/.test(name)) return 'component';
  return rawType;
}

const JS_FAMILY_CONFIG: LangConfig = {
  symbolNodeTypes: {
    function_declaration: 'function',
    method_definition: 'method',
    class_declaration: 'class',
    interface_declaration: 'interface',
    type_alias_declaration: 'type',
    enum_declaration: 'enum',
  },
  importNodeTypes: ['import_statement'],
  extraMatch: jsFamilyExtraMatch,
  getName: defaultGetName,
  getIsExported: jsFamilyIsExported,
  refineType: jsFamilyRefineType,
};

const PYTHON_CONFIG: LangConfig = {
  symbolNodeTypes: {
    function_definition: 'function',
    class_definition: 'class',
  },
  importNodeTypes: ['import_statement', 'import_from_statement'],
  getName: defaultGetName,
  // Python has no export keyword — module-level visibility is a convention
  // (leading underscore / __all__), not something deterministically parseable
  // from a single declaration's syntax, so this is never claimed as known.
  getIsExported: () => false,
};

function javaGetIsExported(node: SyntaxNode): boolean {
  const modifiers = node.namedChildren.find((c) => c.type === 'modifiers');
  return modifiers ? /\bpublic\b/.test(modifiers.text) : false;
}

const JAVA_CONFIG: LangConfig = {
  symbolNodeTypes: {
    class_declaration: 'class',
    interface_declaration: 'interface',
    enum_declaration: 'enum',
    method_declaration: 'method',
    constructor_declaration: 'method',
  },
  importNodeTypes: ['import_declaration'],
  getName: defaultGetName,
  getIsExported: javaGetIsExported,
};

function goRefineType(rawType: string, node: SyntaxNode): string {
  if (rawType !== 'type') return rawType;
  const valueType = node.childForFieldName('type')?.type;
  if (valueType === 'struct_type') return 'struct';
  if (valueType === 'interface_type') return 'interface';
  return 'type';
}

const GO_CONFIG: LangConfig = {
  symbolNodeTypes: {
    function_declaration: 'function',
    method_declaration: 'method',
    type_spec: 'type',
  },
  importNodeTypes: ['import_declaration'],
  getName: defaultGetName,
  // Go has no export keyword — an identifier starting with an uppercase
  // letter is exported from its package, purely by naming convention. This
  // is part of the language specification, not a heuristic guess.
  getIsExported: (node) => {
    const name = defaultGetName(node);
    return Boolean(name && /^[A-Z]/.test(name));
  },
  refineType: goRefineType,
};

function rustGetName(node: SyntaxNode): string | null {
  const byField = defaultGetName(node);
  if (byField) return byField;
  if (node.type === 'impl_item') {
    return node.namedChildren.find((c) => c.type === 'type_identifier')?.text ?? null;
  }
  return null;
}

const RUST_CONFIG: LangConfig = {
  symbolNodeTypes: {
    function_item: 'function',
    struct_item: 'struct',
    enum_item: 'enum',
    trait_item: 'trait',
    impl_item: 'impl',
  },
  importNodeTypes: ['use_declaration'],
  getName: rustGetName,
  getIsExported: (node) => node.namedChildren.some((c) => c.type === 'visibility_modifier'),
};

/** C/C++ function_definition has no `name` field — the identifier is nested inside its `declarator` (possibly under pointer/parameter wrappers), so this digs for the first identifier/field_identifier. */
function findDeclaratorName(node: SyntaxNode): string | null {
  if (node.type === 'identifier' || node.type === 'field_identifier') return node.text;
  for (const child of node.namedChildren) {
    const found = findDeclaratorName(child);
    if (found) return found;
  }
  return null;
}

function cFamilyGetName(node: SyntaxNode): string | null {
  if (node.type === 'function_definition') {
    const declarator = node.childForFieldName('declarator');
    return declarator ? findDeclaratorName(declarator) : null;
  }
  return defaultGetName(node);
}

const C_CONFIG: LangConfig = {
  symbolNodeTypes: {
    function_definition: 'function',
    struct_specifier: 'struct',
  },
  importNodeTypes: ['preproc_include'],
  getName: cFamilyGetName,
  // C has no export keyword; a header-vs-static distinction would require
  // cross-file knowledge this phase deliberately doesn't attempt.
  getIsExported: () => false,
};

const CPP_CONFIG: LangConfig = {
  symbolNodeTypes: {
    function_definition: 'function',
    class_specifier: 'class',
    struct_specifier: 'struct',
  },
  importNodeTypes: ['preproc_include'],
  getName: cFamilyGetName,
  getIsExported: () => false,
};

const CSS_CONFIG: LangConfig = {
  symbolNodeTypes: {
    rule_set: 'rule',
  },
  importNodeTypes: ['import_statement'],
  getName: (node) => {
    const selectors = node.namedChildren.find((c) => c.type === 'selectors');
    return selectors ? selectors.text.trim().replace(/\s+/g, ' ') : null;
  },
  getIsExported: () => false,
};

const JSON_CONFIG: LangConfig = {
  symbolNodeTypes: {
    pair: 'property',
  },
  importNodeTypes: [],
  getName: (node) => {
    const keyNode = node.namedChildren[0];
    if (!keyNode) return null;
    const content = keyNode.namedChildren.find((c) => c.type === 'string_content');
    return content?.text ?? keyNode.text.replace(/^"|"$/g, '');
  },
  getIsExported: () => false,
  // Only the root object's direct keys are indexed — a deeply nested JSON
  // document would otherwise produce one "symbol" per key at every depth,
  // exactly the "thousands of useless chunks" the spec warns against.
  shouldEmit: (node) => node.parent?.type === 'object' && node.parent.parent?.type === 'document',
};

const LANG_CONFIG: Partial<Record<DetectedLanguage, LangConfig>> = {
  typescript: JS_FAMILY_CONFIG,
  tsx: JS_FAMILY_CONFIG,
  javascript: JS_FAMILY_CONFIG,
  jsx: JS_FAMILY_CONFIG,
  python: PYTHON_CONFIG,
  java: JAVA_CONFIG,
  go: GO_CONFIG,
  rust: RUST_CONFIG,
  c: C_CONFIG,
  cpp: CPP_CONFIG,
  css: CSS_CONFIG,
  json: JSON_CONFIG,
};

const MAX_IMPORT_STATEMENT_LENGTH = 400;

/** `export default Foo;` (a bare identifier, not a declaration) references a symbol declared elsewhere in the same file — collected so that symbol can retroactively be marked isExported without any cross-file resolution. */
function collectDefaultExportReferences(root: SyntaxNode): Set<string> {
  const names = new Set<string>();
  for (const exportStatement of root.descendantsOfType('export_statement')) {
    if (exportStatement.namedChildCount === 1 && exportStatement.namedChildren[0].type === 'identifier') {
      names.add(exportStatement.namedChildren[0].text);
    }
  }
  return names;
}

function walk(node: SyntaxNode, config: LangConfig, parentSymbol: string | null, out: ExtractedSymbol[]): void {
  const rawType = config.extraMatch?.(node) ?? config.symbolNodeTypes[node.type];
  let nextParent = parentSymbol;

  if (rawType && (!config.shouldEmit || config.shouldEmit(node))) {
    const name = config.getName(node);
    if (name) {
      const symbolType = config.refineType ? config.refineType(rawType, node, name) : rawType;
      out.push({
        symbol: name,
        symbolType,
        parentSymbol,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        startColumn: node.startPosition.column,
        endColumn: node.endPosition.column,
        startIndex: node.startIndex,
        endIndex: node.endIndex,
        isExported: config.getIsExported(node),
        content: node.text,
      });
      nextParent = name;
    }
  }

  for (const child of node.namedChildren) {
    walk(child, config, nextParent, out);
  }
}

function extractImports(root: SyntaxNode, config: LangConfig): ExtractedImport[] {
  if (config.importNodeTypes.length === 0) return [];
  const imports: ExtractedImport[] = [];
  for (const node of root.descendantsOfType(config.importNodeTypes)) {
    const text = node.text.trim();
    imports.push({
      statement: text.length > MAX_IMPORT_STATEMENT_LENGTH ? `${text.slice(0, MAX_IMPORT_STATEMENT_LENGTH)}…` : text,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    });
  }
  return imports;
}

/**
 * Parses `source` as `language` and extracts symbols/imports. Returns `null`
 * only when the language has no wired grammar (see GRAMMAR_WASM_FILE) — the
 * caller treats that the same as UNSUPPORTED_LANGUAGE. A syntax error inside
 * an otherwise-parseable file does NOT return null: Tree-sitter's own
 * error-recovery produces a best-effort tree, and whatever real symbols it
 * still finds are extracted (see hasSyntaxError for the informational flag).
 */
export async function parseAndExtract(language: DetectedLanguage, source: string): Promise<FileAstResult | null> {
  const wasmFile = GRAMMAR_WASM_FILE[language];
  const config = LANG_CONFIG[language];
  if (!wasmFile || !config) return null;

  const grammar = await loadGrammar(wasmFile);
  const parser = new Parser();
  try {
    parser.setLanguage(grammar);
    const tree = parser.parse(source);
    if (!tree) return null;

    const symbols: ExtractedSymbol[] = [];
    walk(tree.rootNode, config, null, symbols);

    if (language === 'typescript' || language === 'tsx' || language === 'javascript' || language === 'jsx') {
      const referenced = collectDefaultExportReferences(tree.rootNode);
      if (referenced.size > 0) {
        for (const symbol of symbols) {
          if (symbol.parentSymbol === null && referenced.has(symbol.symbol)) symbol.isExported = true;
        }
      }
    }

    return {
      symbols,
      imports: extractImports(tree.rootNode, config),
      hasSyntaxError: tree.rootNode.hasError(),
    };
  } finally {
    parser.delete();
  }
}
