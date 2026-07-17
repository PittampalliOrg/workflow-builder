import { importPKCS8, SignJWT } from "jose";
import { env } from "$env/dynamic/private";

export type TokenPayload = {
  sub: string; // userId
  email: string;
  platformId: string;
  projectId: string;
  tokenVersion: number;
  type: "access" | "refresh";
};

export type AccessTokenIdentity = Omit<TokenPayload, "type">;

/**
 * Issue an access-only token. Callers that do not need refresh capability use
 * this helper so a short-lived service credential cannot be exchanged for a
 * longer-lived session.
 */
export async function generateAccessToken(
  identity: AccessTokenIdentity,
  expiresIn: string | number = env.JWT_ACCESS_TOKEN_EXPIRY || "1h",
): Promise<string> {
  const keyPem = env.JWT_SIGNING_KEY;
  if (!keyPem) throw new Error("JWT_SIGNING_KEY not configured");

  const privateKey = await importPKCS8(keyPem, "RS256");
  return new SignJWT({ ...identity, type: "access" } satisfies TokenPayload)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(privateKey);
}

/**
 * Generate new access + refresh token pair using the RS256 signing key.
 */
export async function generateTokens(
  userId: string,
  email: string,
  platformId: string,
  projectId: string,
  tokenVersion: number,
): Promise<{ accessToken: string; refreshToken: string }> {
  const keyPem = env.JWT_SIGNING_KEY;
  if (!keyPem) throw new Error("JWT_SIGNING_KEY not configured");

  const privateKey = await importPKCS8(keyPem, "RS256");

  const identity = {
    sub: userId,
    email,
    platformId,
    projectId,
    tokenVersion,
  } satisfies AccessTokenIdentity;
  const accessToken = await generateAccessToken(identity);

  const refreshToken = await new SignJWT({
    ...identity,
    type: "refresh",
  } satisfies TokenPayload)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setExpirationTime(env.JWT_REFRESH_TOKEN_EXPIRY || "7d")
    .sign(privateKey);

  return { accessToken, refreshToken };
}
