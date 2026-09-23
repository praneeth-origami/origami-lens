import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from './password-hash.js';

describe('password-hash', () => {
  it('hashPassword produces a distinct salt per call, even for the same password', async () => {
    const a = await hashPassword('correct horse battery staple');
    const b = await hashPassword('correct horse battery staple');
    assert.notEqual(a, b);
  });

  it('verifyPassword returns true for the correct password against its own hash', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  });

  it('verifyPassword returns false for a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('wrong password', hash), false);
  });

  it('verifyPassword returns false (never throws) for a malformed/foreign stored value', async () => {
    assert.equal(await verifyPassword('anything', 'not-a-real-hash'), false);
    assert.equal(await verifyPassword('anything', 'scrypt:onlyonepart'), false);
    assert.equal(await verifyPassword('anything', 'bcrypt:aa:bb'), false);
  });

  it('the stored hash never contains the plaintext password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.equal(hash.includes('correct horse battery staple'), false);
  });
});
