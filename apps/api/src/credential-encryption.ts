/**
 * AES-256-GCM encryption for the only genuinely secret values this
 * application ever persists: GitLab/Bitbucket OAuth access/refresh tokens
 * (provider_connections.encrypted_access_token/encrypted_refresh_token —
 * migration 013). GitHub never needs this (installation tokens are minted
 * fresh and never stored — see github-app-auth.ts); this module exists
 * specifically because Phase D introduces the first credential that
 * genuinely must survive between requests.
 *
 * CREDENTIAL_ENCRYPTION_KEY is a server-side-only secret (32 raw bytes,
 * base64-encoded) — never derived from anything client-supplied, never
 * logged, never returned in any API response.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

export class CredentialEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialEncryptionError';
  }
}

function getEncryptionKey(): Buffer {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new CredentialEncryptionError('CREDENTIAL_ENCRYPTION_KEY is not configured — cannot encrypt or decrypt provider credentials.');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_LENGTH) {
    throw new CredentialEncryptionError(`CREDENTIAL_ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH} bytes (got ${key.length}).`);
  }
  return key;
}

export function isCredentialEncryptionConfigured(): boolean {
  try {
    getEncryptionKey();
    return true;
  } catch {
    return false;
  }
}

/** Encodes as base64(iv) + ':' + base64(authTag) + ':' + base64(ciphertext) — plain text, safe to store in a TEXT column, never itself the plaintext secret. */
export function encryptCredential(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptCredential(encoded: string): string {
  const key = getEncryptionKey();
  const parts = encoded.split(':');
  if (parts.length !== 3) {
    throw new CredentialEncryptionError('Encrypted credential is malformed.');
  }
  const [ivB64, authTagB64, ciphertextB64] = parts;
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]);
  return plaintext.toString('utf8');
}
