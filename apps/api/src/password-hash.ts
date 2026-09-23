/**
 * Password hashing — Node's built-in `crypto.scrypt`, not a new dependency
 * (matches this codebase's existing preference for hand-rolled crypto over
 * adding a library where the built-in is sufficient, e.g. github-app-auth.ts's
 * own hand-rolled JWT signer). scrypt is memory-hard by design, which is the
 * property that actually matters for password storage (unlike a fast general
 * hash like SHA-256).
 *
 * Stored format: `scrypt:<saltHex>:<hashHex>` — the salt travels with the
 * hash (standard practice), and the literal prefix makes the stored value
 * self-describing if a different scheme is ever introduced later.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

const SALT_BYTES = 16;
const KEY_BYTES = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scrypt(password, salt, KEY_BYTES)) as Buffer;
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

/** Constant-time comparison via timingSafeEqual — never a plain `===` on the derived key, which would leak timing information about how much of the hash matched. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, saltHex, hashHex] = parts;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== KEY_BYTES) return false;

  const actual = (await scrypt(password, salt, KEY_BYTES)) as Buffer;
  return timingSafeEqual(actual, expected);
}
