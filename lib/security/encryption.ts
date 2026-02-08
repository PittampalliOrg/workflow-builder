import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-CBC encryption aligned with Activepieces upstream.
 *
 * Reference:
 *   activepieces/packages/server/api/src/app/helper/encryption.ts
 *
 * Format: EncryptedObject = { iv: string (hex), data: string (hex) }
 *
 * Key handling:
 * - 32-char key: treated as binary (each char = 1 byte) for AP upstream compat
 * - 64-char hex key: decoded as hex → 32 bytes (from `openssl rand -hex 32`)
 */

const ALGORITHM = "aes-256-cbc";
const IV_LENGTH = 16;
const ENCRYPTION_KEY_ENV_PRIMARY = "INTEGRATION_ENCRYPTION_KEY";
const ENCRYPTION_KEY_ENV_ALIAS = "AP_ENCRYPTION_KEY";

export type EncryptedObject = {
  iv: string;
  data: string;
};

function isHex(s: string): boolean {
  return /^[0-9a-fA-F]+$/.test(s);
}

function getEncryptionKey(): Buffer {
  const secret =
    process.env[ENCRYPTION_KEY_ENV_PRIMARY] ??
    process.env[ENCRYPTION_KEY_ENV_ALIAS];

  if (!secret) {
    throw new Error(
      `${ENCRYPTION_KEY_ENV_PRIMARY} (or ${ENCRYPTION_KEY_ENV_ALIAS}) environment variable is required for encrypting connection credentials. ` +
        `Generate one with: openssl rand -hex 32`
    );
  }

  // 64-char hex string (from `openssl rand -hex 32`) → decode as hex → 32 bytes
  if (secret.length === 64 && isHex(secret)) {
    return Buffer.from(secret, "hex");
  }

  // 32-char key → binary encoding (AP upstream compat: 16 random bytes → 32 hex chars)
  if (secret.length === 32) {
    return Buffer.from(secret, "binary");
  }

  throw new Error(
    `${ENCRYPTION_KEY_ENV_PRIMARY}/${ENCRYPTION_KEY_ENV_ALIAS} must be either a 64-char hex string (openssl rand -hex 32) ` +
      `or a 32-char string. Got ${secret.length} characters.`
  );
}

export function encryptString(plaintext: string): EncryptedObject {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");

  return {
    iv: iv.toString("hex"),
    data: encrypted,
  };
}

export function decryptString(encryptedObject: EncryptedObject): string {
  const key = getEncryptionKey();
  const iv = Buffer.from(encryptedObject.iv, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);

  let decrypted = decipher.update(encryptedObject.data, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

export function encryptObject(
  obj: unknown
): EncryptedObject {
  return encryptString(JSON.stringify(obj));
}

export function decryptObject<
  T = unknown,
>(encryptedObject: EncryptedObject): T {
  const decrypted = decryptString(encryptedObject);
  return JSON.parse(decrypted) as T;
}
