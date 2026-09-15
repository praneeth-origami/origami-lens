import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAndExtract } from './repository-ast.js';

function find(symbols: Awaited<ReturnType<typeof parseAndExtract>> extends infer T ? (T extends { symbols: infer S } ? S : never) : never, name: string) {
  return (symbols as { symbol: string }[]).find((s) => s.symbol === name);
}

describe('parseAndExtract — TypeScript', () => {
  it('TEST 9 — extracts a function declaration', async () => {
    const result = await parseAndExtract('typescript', 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
    const fn = find(result!.symbols, 'add');
    assert.ok(fn);
    assert.equal(fn!.symbolType, 'function');
    assert.equal(fn!.isExported, true);
  });

  it('TEST 10 — extracts a class declaration and its methods', async () => {
    const result = await parseAndExtract(
      'typescript',
      'export class UserService {\n  getUser(id: string) {\n    return id;\n  }\n}\n',
    );
    const cls = find(result!.symbols, 'UserService');
    const method = find(result!.symbols, 'getUser');
    assert.equal(cls!.symbolType, 'class');
    assert.equal(cls!.isExported, true);
    assert.equal(method!.symbolType, 'method');
    assert.equal(method!.parentSymbol, 'UserService');
  });

  it('TEST 11 — extracts an interface declaration', async () => {
    const result = await parseAndExtract('typescript', 'export interface Props {\n  title: string;\n}\n');
    const iface = find(result!.symbols, 'Props');
    assert.equal(iface!.symbolType, 'interface');
    assert.equal(iface!.isExported, true);
  });

  it('TEST 12 — extracts a type alias declaration', async () => {
    const result = await parseAndExtract('typescript', 'export type Point = { x: number; y: number };\n');
    const alias = find(result!.symbols, 'Point');
    assert.equal(alias!.symbolType, 'type');
    assert.equal(alias!.isExported, true);
  });

  it('extracts an enum declaration', async () => {
    const result = await parseAndExtract('typescript', 'export enum Color { Red, Green }\n');
    const en = find(result!.symbols, 'Color');
    assert.equal(en!.symbolType, 'enum');
  });

  it('a non-exported top-level function is not marked exported', async () => {
    const result = await parseAndExtract('typescript', 'function internalHelper() { return 1; }\n');
    const fn = find(result!.symbols, 'internalHelper');
    assert.equal(fn!.isExported, false);
  });

  it('TEST 20 — extracts import statements', async () => {
    const result = await parseAndExtract('typescript', "import React from 'react';\nimport { useState } from 'react';\n\nexport function App() {}\n");
    assert.equal(result!.imports.length, 2);
    assert.match(result!.imports[0].statement, /^import React from 'react';?$/);
  });

  it('resolves `export default Identifier` back to the declaration it references', async () => {
    const result = await parseAndExtract('typescript', 'function Main() { return null; }\n\nexport default Main;\n');
    const fn = find(result!.symbols, 'Main');
    assert.equal(fn!.isExported, true);
  });

  it('TEST 16 — start/end line and column metadata is accurate and 1-based for lines', async () => {
    const result = await parseAndExtract('typescript', 'export function add(a: number) {\n  return a;\n}\n');
    const fn = find(result!.symbols, 'add')!;
    assert.equal(fn.startLine, 1);
    assert.equal(fn.endLine, 3);
    assert.equal(fn.startColumn, 7); // after "export "
  });

  it('does not fail on malformed/incomplete source — extracts whatever real symbols still exist', async () => {
    const result = await parseAndExtract('typescript', 'export function broken( {\n\nexport function ok() { return 1; }\n');
    assert.ok(result);
    assert.equal(result!.hasSyntaxError, true);
    assert.ok(find(result!.symbols, 'ok'));
  });
});

describe('parseAndExtract — TSX', () => {
  it('TEST 13 — extracts a capitalized function component as symbolType "component"', async () => {
    const result = await parseAndExtract(
      'tsx',
      "import React from 'react';\nexport function Header(props: { title: string }) {\n  return <div>{props.title}</div>;\n}\n",
    );
    const header = find(result!.symbols, 'Header');
    assert.equal(header!.symbolType, 'component');
    assert.equal(header!.isExported, true);
  });

  it('a lowercase-named arrow function assigned to a const is a plain function, not a component', async () => {
    const result = await parseAndExtract('tsx', 'const formatTitle = (title: string) => title.toUpperCase();\n');
    const fn = find(result!.symbols, 'formatTitle');
    assert.equal(fn!.symbolType, 'function');
  });

  it('TEST 19 — an exported const arrow-function component is marked exported', async () => {
    const result = await parseAndExtract('tsx', 'export const Button = () => <button />;\n');
    const btn = find(result!.symbols, 'Button');
    assert.equal(btn!.symbolType, 'component');
    assert.equal(btn!.isExported, true);
  });
});

describe('parseAndExtract — JavaScript/JSX', () => {
  it('TEST 14 — extracts a plain JavaScript function declaration', async () => {
    const result = await parseAndExtract('javascript', 'function greet(name) {\n  return "hi " + name;\n}\n');
    const fn = find(result!.symbols, 'greet');
    assert.equal(fn!.symbolType, 'function');
  });

  it('parses JSX syntax inside a .jsx file using the JavaScript grammar', async () => {
    const result = await parseAndExtract('jsx', 'export function Card() {\n  return <div className="card" />;\n}\n');
    const card = find(result!.symbols, 'Card');
    assert.equal(card!.symbolType, 'component');
    assert.equal(result!.hasSyntaxError, false);
  });
});

describe('parseAndExtract — Python', () => {
  it('TEST 15 — extracts a function and a class with a method', async () => {
    const result = await parseAndExtract(
      'python',
      'def hello(name):\n    return name\n\nclass Foo:\n    def bar(self):\n        pass\n',
    );
    const hello = find(result!.symbols, 'hello');
    const foo = find(result!.symbols, 'Foo');
    const bar = find(result!.symbols, 'bar');
    assert.equal(hello!.symbolType, 'function');
    assert.equal(foo!.symbolType, 'class');
    assert.equal(bar!.symbolType, 'function');
    assert.equal(bar!.parentSymbol, 'Foo');
  });

  it('TEST 20 — extracts Python import and from-import statements', async () => {
    const result = await parseAndExtract('python', 'import os\nfrom services.auth import AuthService\n');
    assert.equal(result!.imports.length, 2);
  });
});

describe('parseAndExtract — Java/Go/Rust/C/C++/CSS/JSON', () => {
  it('extracts a Java class and public method', async () => {
    const result = await parseAndExtract('java', 'public class Foo {\n  public void bar() {}\n}\n');
    const cls = find(result!.symbols, 'Foo');
    const method = find(result!.symbols, 'bar');
    assert.equal(cls!.symbolType, 'class');
    assert.equal(cls!.isExported, true);
    assert.equal(method!.parentSymbol, 'Foo');
  });

  it('extracts a Go function and marks capitalized names exported', async () => {
    const result = await parseAndExtract('go', 'package main\n\nfunc Hello() string { return "hi" }\nfunc unexported() {}\n');
    const hello = find(result!.symbols, 'Hello');
    const unexported = find(result!.symbols, 'unexported');
    assert.equal(hello!.isExported, true);
    assert.equal(unexported!.isExported, false);
  });

  it('extracts a Go struct type as symbolType "struct"', async () => {
    const result = await parseAndExtract('go', 'package main\n\ntype Point struct {\n  X int\n  Y int\n}\n');
    const point = find(result!.symbols, 'Point');
    assert.equal(point!.symbolType, 'struct');
  });

  it('extracts a Rust function and struct, and treats `pub` as exported', async () => {
    const result = await parseAndExtract('rust', 'pub fn hello() -> String { "hi".to_string() }\nstruct Internal {}\n');
    const hello = find(result!.symbols, 'hello');
    const internal = find(result!.symbols, 'Internal');
    assert.equal(hello!.isExported, true);
    assert.equal(internal!.isExported, false);
  });

  it('extracts a C function via its nested declarator', async () => {
    const result = await parseAndExtract('c', 'int add(int a, int b) {\n  return a + b;\n}\n');
    const fn = find(result!.symbols, 'add');
    assert.equal(fn!.symbolType, 'function');
  });

  it('extracts a C++ class and its member function', async () => {
    const result = await parseAndExtract('cpp', 'class Foo {\npublic:\n  void bar() {}\n};\n');
    const cls = find(result!.symbols, 'Foo');
    assert.equal(cls!.symbolType, 'class');
  });

  it('extracts a CSS rule by its selector text', async () => {
    const result = await parseAndExtract('css', '.header { color: red; }\n');
    const rule = find(result!.symbols, '.header');
    assert.equal(rule!.symbolType, 'rule');
  });

  it('extracts only top-level JSON keys, not deeply nested ones', async () => {
    const result = await parseAndExtract('json', '{"name": "test", "nested": {"inner": 1}}');
    assert.ok(find(result!.symbols, 'name'));
    assert.ok(!find(result!.symbols, 'inner'));
  });
});

describe('parseAndExtract — unsupported languages', () => {
  it('returns null for a language with no wired grammar (e.g. html)', async () => {
    const result = await parseAndExtract('html', '<html></html>');
    assert.equal(result, null);
  });

  it('returns null for an unknown language', async () => {
    const result = await parseAndExtract('unknown', 'anything');
    assert.equal(result, null);
  });
});
