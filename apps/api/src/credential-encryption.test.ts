import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  CredentialEncryptionError,
  decryptCredential,
  encryptCredential,
  isCredentialEncryptionConfigured,
} from './credential-encryption.js';

const originalKey = process.env.CREDENTIAL_ENCRYPTION_KEY;

function restoreEnv() {
  if (originalKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY; else process.env.CREDENTIAL_ENCRYPTION_KEY = originalKey;
}

afterEach(restoreEnv);

function setRealKey(): string {
  const key = randomBytes(32).toString('base64');
  process.env.CREDENTIAL_ENCRYPTION_KEY = key;
  return key;
}

describe('credential-encryption — configuration', () => {
  it('isCredentialEncryptionConfigured is false when the key is missing', () => {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    assert.equal(isCredentialEncryptionConfigured(), false);
  });

  it('isCredentialEncryptionConfigured is false when the key does not decode to exactly 32 bytes', () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.from('too-short').toString('base64');
    assert.equal(isCredentialEncryptionConfigured(), false);
  });

  it('isCredentialEncryptionConfigured is true for a real 32-byte key', () => {
    setRealKey();
    assert.equal(isCredentialEncryptionConfigured(), true);
  });

  it('encryptCredential throws CredentialEncryptionError (not a generic error) when unconfigured', () => {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    assert.throws(() => encryptCredential('secret'), CredentialEncryptionError);
  });
});

describe('credential-encryption — encrypt/decrypt round trip', () => {
  it('decrypts back to the exact original plaintext', () => {
    setRealKey();
    const plaintext = 'gl_oauth_access_token_abc123';
    const encrypted = encryptCredential(plaintext);
    assert.notEqual(encrypted, plaintext, 'the stored value must never equal the plaintext');
    assert.equal(decryptCredential(encrypted), plaintext);
  });

  it('two encryptions of the same plaintext produce different ciphertext (random IV)', () => {
    setRealKey();
    const a = encryptCredential('same-secret');
    const b = encryptCredential('same-secret');
    assert.notEqual(a, b);
    assert.equal(decryptCredential(a), 'same-secret');
    assert.equal(decryptCredential(b), 'same-secret');
  });

  it('the encoded form never contains the plaintext as a substring', () => {
    setRealKey();
    const plaintext = 'super-secret-refresh-token-xyz';
    const encrypted = encryptCredential(plaintext);
    assert.ok(!encrypted.includes(plaintext));
  });

  it('decryption fails (does not silently return garbage) when a different key is used', () => {
    setRealKey();
    const encrypted = encryptCredential('secret-value');
    setRealKey(); // a different real key
    assert.throws(() => decryptCredential(encrypted));
  });

  it('decryption fails on a tampered ciphertext (GCM auth tag catches it)', () => {
    setRealKey();
    const encrypted = encryptCredential('secret-value');
    const parts = encrypted.split(':');
    const tamperedCiphertext = Buffer.from(parts[2], 'base64');
    tamperedCiphertext[0] ^= 0xff;
    const tampered = `${parts[0]}:${parts[1]}:${tamperedCiphertext.toString('base64')}`;
    assert.throws(() => decryptCredential(tampered));
  });

  it('decryptCredential rejects a malformed (non-3-part) encoded value', () => {
    setRealKey();
    assert.throws(() => decryptCredential('not-a-valid-encoded-value'), CredentialEncryptionError);
  });
});
