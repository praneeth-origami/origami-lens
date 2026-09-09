import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verifyGeneratedComponent } from './index.js';

describe('verifyGeneratedComponent', () => {
  it('passes well-formed React output', () => {
    const result = verifyGeneratedComponent('REACT', 'PricingCard', [
      { path: 'PricingCard.jsx', content: 'export function PricingCard() { return (<div className="card">{"$9"}</div>); }' },
      { path: 'PricingCard.module.css', content: '.card { padding: 16px; }' },
    ]);
    assert.equal(result.passed, true);
    assert.deepEqual(result.issues, []);
  });

  it('fails on unbalanced braces', () => {
    const result = verifyGeneratedComponent('REACT', 'PricingCard', [
      { path: 'PricingCard.jsx', content: 'export function PricingCard() { return <div>;' },
    ]);
    assert.equal(result.passed, false);
    assert.ok(result.issues.some((i) => i.includes('unbalanced braces')));
  });

  it('fails on unclosed HTML tags', () => {
    const result = verifyGeneratedComponent('HTML_CSS', 'Footer', [
      { path: 'footer.html', content: '<footer><div class="row"><p>Copyright</div></footer>' },
    ]);
    assert.equal(result.passed, false);
    assert.ok(result.issues.some((i) => i.includes('mismatched')));
  });

  it('flags placeholder component names', () => {
    const result = verifyGeneratedComponent('REACT', 'Component1', [
      { path: 'Component1.jsx', content: 'export function Component1() { return <div />; }' },
    ]);
    assert.equal(result.passed, false);
    assert.ok(result.issues.some((i) => i.includes('placeholder')));
  });

  it('flags leaked secrets in generated output', () => {
    const result = verifyGeneratedComponent('REACT', 'Card', [
      { path: 'Card.jsx', content: 'const key = "sk-abcdefghijklmnopqrstuvwx"; export function Card() { return <div>{key}</div>; }' },
    ]);
    assert.equal(result.passed, false);
    assert.ok(result.issues.some((i) => i.includes('secret-looking')));
  });

  it('fails when no file matches the expected target extension', () => {
    const result = verifyGeneratedComponent('HTML_CSS', 'Nav', [
      { path: 'Nav.jsx', content: 'export function Nav() { return <nav />; }' },
    ]);
    assert.equal(result.passed, false);
    assert.ok(result.issues.some((i) => i.includes('expected extensions')));
  });
});
