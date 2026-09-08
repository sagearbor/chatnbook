// AES-256-GCM encryption for OAuth tokens at rest in Postgres. The key
// comes from TOKEN_ENCRYPTION_KEY (base64-encoded, must decode to exactly
// 32 bytes -- generate one with `openssl rand -base64 32`). Never logged,
// never stored in the DB -- only ciphertext goes to Postgres.
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended for GCM

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` and set it in .env.'
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode (base64) to exactly 32 bytes, got ${key.length}.`
    );
  }
  cachedKey = key;
  return key;
}

/** Test-only: forces re-read of TOKEN_ENCRYPTION_KEY on next encrypt/decrypt call. */
export function __resetKeyCacheForTest() {
  cachedKey = null;
}

/** Encrypts plaintext, returning "iv.tag.ciphertext" (all base64). */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
}

/** Decrypts a string produced by encrypt(). Throws if the key or ciphertext is wrong/tampered. */
export function decrypt(encoded: string): string {
  const key = getKey();
  const parts = encoded.split('.');
  if (parts.length !== 3) {
    throw new Error('malformed encrypted token (expected "iv.tag.ciphertext")');
  }
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
