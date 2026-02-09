import { createPublicKey, createPrivateKey } from "node:crypto";
import { eq } from "drizzle-orm";
import { getSecretValueAsync } from "./dapr/config-provider";
import { db } from "./db";
import { platforms, signingKeys } from "./db/schema";
import { generateId } from "./utils/id";

let cachedPlatform: { id: string; name: string; ownerId: string | null } | null = null;

/**
 * Get or create the default platform for self-hosted deployments.
 * Self-hosted mode always has exactly one platform.
 */
export async function ensureDefaultPlatform(): Promise<{ id: string; name: string; ownerId: string | null }> {
  if (cachedPlatform) return cachedPlatform;

  // Try to find existing platform
  const existing = await db.select().from(platforms).limit(1);
  if (existing.length > 0) {
    cachedPlatform = { id: existing[0].id, name: existing[0].name, ownerId: existing[0].ownerId };
    return cachedPlatform;
  }

  // Create default platform
  const platformId = generateId();
  const now = new Date();
  await db.insert(platforms).values({
    id: platformId,
    name: "Default Platform",
    createdAt: now,
    updatedAt: now,
  });

  cachedPlatform = { id: platformId, name: "Default Platform", ownerId: null };
  return cachedPlatform;
}

/**
 * Generate RSA signing key pair and store the public key in the database.
 * Returns the private key PEM for JWT signing.
 */
export async function generateSigningKeyPair(platformId: string): Promise<string> {
  // Use Web Crypto API to generate RSA key pair
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true, // extractable
    ["sign", "verify"]
  );

  // Export keys in PEM format
  const publicKeyBuffer = await crypto.subtle.exportKey("spki", keyPair.publicKey);
  const privateKeyBuffer = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);

  const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(publicKeyBuffer).toString("base64")}\n-----END PUBLIC KEY-----`;
  const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(privateKeyBuffer).toString("base64")}\n-----END PRIVATE KEY-----`;

  // Store public key in database
  await db.insert(signingKeys).values({
    platformId,
    publicKey: publicKeyPem,
    algorithm: "RS256",
    displayName: "Default Signing Key",
  });

  return privateKeyPem;
}

/**
 * Get the public key for a platform (for JWT verification).
 * If no signing key exists in the DB but JWT_SIGNING_KEY env var is set,
 * derives the public key from the private key and stores it.
 */
export async function getSigningKey(platformId: string): Promise<string | null> {
  const key = await db.select().from(signingKeys)
    .where(eq(signingKeys.platformId, platformId))
    .limit(1);
  if (key.length > 0) return key[0].publicKey;

  // Auto-populate from JWT_SIGNING_KEY (Dapr secret store or env var)
  const privateKeyPem = await getSecretValueAsync("JWT_SIGNING_KEY");
  if (!privateKeyPem) return null;

  try {
    // Verify the platform exists before inserting a signing key (FK constraint).
    // Stale JWTs from a previous cluster may reference platforms that no longer exist.
    const platform = await db.select({ id: platforms.id }).from(platforms)
      .where(eq(platforms.id, platformId))
      .limit(1);
    if (platform.length === 0) return null;

    const privateKey = createPrivateKey(privateKeyPem);
    const publicKey = createPublicKey(privateKey);
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;

    // Store in DB for future lookups
    await db.insert(signingKeys).values({
      platformId,
      publicKey: publicKeyPem,
      algorithm: "RS256",
      displayName: "Auto-derived from JWT_SIGNING_KEY",
    });

    return publicKeyPem;
  } catch (err) {
    console.error("Failed to derive public key from JWT_SIGNING_KEY:", err);
    return null;
  }
}

/**
 * Get platform by ID with caching.
 */
export async function getPlatformById(id: string) {
  if (cachedPlatform && cachedPlatform.id === id) return cachedPlatform;

  const result = await db.select().from(platforms).where(eq(platforms.id, id)).limit(1);
  if (result.length === 0) return null;

  const platform = { id: result[0].id, name: result[0].name, ownerId: result[0].ownerId };
  cachedPlatform = platform;
  return platform;
}

/**
 * Clear platform cache (useful for testing or after updates).
 */
export function clearPlatformCache() {
  cachedPlatform = null;
}
