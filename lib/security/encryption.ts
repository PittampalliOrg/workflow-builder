import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-CBC encryption aligned with Activepieces upstream.
 *
 * Reference:
 *   activepieces/packages/server/api/src/app/helper/encryption.ts
 *
 * Format: EncryptedObject = { iv: string (hex), data: string (hex) }
 * Key: 32-char hex string interpreted as 'binary' (32 bytes for AES-256).
 *      Upstream generates 16 random bytes → 32 hex chars, then uses
 *      Buffer.from(secret, 'binary') which treats each char as one byte.
 */

const ALGORITHM = "aes-256-cbc";
const IV_LENGTH = 16;
const ENCRYPTION_KEY_ENV = "AP_ENCRYPTION_KEY";

export type EncryptedObject = {
  iv: string;
  data: string;
};

function getEncryptionKey(): Buffer {
  const secret = process.env[ENCRYPTION_KEY_ENV];

  if (!secret) {
    throw new Error(
      `${ENCRYPTION_KEY_ENV} environment variable is required for encrypting connection credentials`
    );
  }

  // Match upstream: Buffer.from(secret, 'binary') — each char = 1 byte
  // A 32-char hex string becomes a 32-byte key (AES-256)
  return Buffer.from(secret, "binary");
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
  obj: Record<string, unknown>
): EncryptedObject {
  return encryptString(JSON.stringify(obj));
}

export function decryptObject<
  T extends Record<string, unknown> = Record<string, unknown>,
>(encryptedObject: EncryptedObject): T {
  const decrypted = decryptString(encryptedObject);
  return JSON.parse(decrypted) as T;
}
