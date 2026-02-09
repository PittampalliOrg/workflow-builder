/**
 * Auth Service - JWT-based authentication replacing Better Auth
 *
 * Provides sign-up, sign-in, token generation/verification using RS256 JWTs.
 * Password hashing uses bcrypt (AP-compatible).
 */
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { SignJWT, importPKCS8, importSPKI, jwtVerify } from "jose";
import { db } from "./db";
import {
  platforms,
  projectMembers,
  projects,
  userIdentities,
  users,
} from "./db/schema";
import { ensureDefaultPlatform, getSigningKey } from "./platform-service";
import { getOrCreateDefaultProject } from "./project-service";
import { generateId } from "./utils/id";

// Token expiry defaults
const ACCESS_TOKEN_EXPIRY = process.env.JWT_ACCESS_TOKEN_EXPIRY || "15m";
const REFRESH_TOKEN_EXPIRY = process.env.JWT_REFRESH_TOKEN_EXPIRY || "7d";

// Cookie names
export const ACCESS_TOKEN_COOKIE = "wb_access_token";
export const REFRESH_TOKEN_COOKIE = "wb_refresh_token";

export type TokenPayload = {
  sub: string; // userId
  email: string;
  platformId: string;
  projectId: string;
  tokenVersion: number;
  type: "access" | "refresh";
};

export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
};

export type AuthResponse = AuthTokens & {
  user: {
    id: string;
    email: string;
    name: string | null;
    image: string | null;
    platformId: string;
    projectId: string;
  };
};

// ============================================================================
// Password Hashing (bcrypt)
// ============================================================================

const BCRYPT_ROUNDS = 10;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  // Try bcrypt first
  try {
    const bcryptMatch = await bcrypt.compare(password, hash);
    if (bcryptMatch) return true;
  } catch {
    // Not a valid bcrypt hash, try scrypt fallback
  }

  // Fallback: try Better Auth scrypt format (salt:hash)
  if (hash.includes(":")) {
    try {
      const { scryptSync } = await import("node:crypto");
      const [salt, storedHash] = hash.split(":");
      const derivedHash = scryptSync(password, salt, 64).toString("hex");
      if (derivedHash === storedHash) {
        return true;
      }
    } catch {
      // scrypt verification failed
    }
  }

  return false;
}

// ============================================================================
// JWT Token Generation & Verification
// ============================================================================

async function getPrivateKey() {
  const keyPem = process.env.JWT_SIGNING_KEY;
  if (!keyPem) {
    throw new Error(
      "JWT_SIGNING_KEY environment variable is required. Set it to an RSA private key in PEM format."
    );
  }
  return importPKCS8(keyPem, "RS256");
}

async function getPublicKey(platformId: string) {
  const publicKeyPem = await getSigningKey(platformId);
  if (!publicKeyPem) {
    throw new Error(`No signing key found for platform ${platformId}`);
  }
  return importSPKI(publicKeyPem, "RS256");
}

export async function generateTokens(
  userId: string,
  email: string,
  platformId: string,
  projectId: string,
  tokenVersion: number
): Promise<AuthTokens> {
  const privateKey = await getPrivateKey();

  const accessToken = await new SignJWT({
    sub: userId,
    email,
    platformId,
    projectId,
    tokenVersion,
    type: "access",
  } satisfies TokenPayload)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_EXPIRY)
    .sign(privateKey);

  const refreshToken = await new SignJWT({
    sub: userId,
    email,
    platformId,
    projectId,
    tokenVersion,
    type: "refresh",
  } satisfies TokenPayload)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setExpirationTime(REFRESH_TOKEN_EXPIRY)
    .sign(privateKey);

  return { accessToken, refreshToken };
}

export async function verifyAccessToken(
  token: string
): Promise<TokenPayload | null> {
  try {
    // First decode without verification to get platformId
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const payloadStr = Buffer.from(parts[1], "base64url").toString();
    const rawPayload = JSON.parse(payloadStr);
    const platformId = rawPayload.platformId;

    if (!platformId) return null;

    const publicKey = await getPublicKey(platformId);
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: ["RS256"],
    });

    const tokenPayload = payload as unknown as TokenPayload;

    // Check token type
    if (tokenPayload.type !== "access") return null;

    // Verify tokenVersion against DB
    const identity = await db
      .select({ tokenVersion: userIdentities.tokenVersion })
      .from(userIdentities)
      .where(eq(userIdentities.userId, tokenPayload.sub))
      .limit(1);

    if (identity.length === 0) return null;
    if (identity[0].tokenVersion !== tokenPayload.tokenVersion) return null;

    return tokenPayload;
  } catch {
    return null;
  }
}

export async function verifyRefreshToken(
  token: string
): Promise<TokenPayload | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const payloadStr = Buffer.from(parts[1], "base64url").toString();
    const rawPayload = JSON.parse(payloadStr);
    const platformId = rawPayload.platformId;

    if (!platformId) return null;

    const publicKey = await getPublicKey(platformId);
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: ["RS256"],
    });

    const tokenPayload = payload as unknown as TokenPayload;

    if (tokenPayload.type !== "refresh") return null;

    // Verify tokenVersion
    const identity = await db
      .select({ tokenVersion: userIdentities.tokenVersion })
      .from(userIdentities)
      .where(eq(userIdentities.userId, tokenPayload.sub))
      .limit(1);

    if (identity.length === 0) return null;
    if (identity[0].tokenVersion !== tokenPayload.tokenVersion) return null;

    return tokenPayload;
  } catch {
    return null;
  }
}

// ============================================================================
// Sign Up
// ============================================================================

export async function signUp(
  email: string,
  password: string,
  name: string
): Promise<AuthResponse> {
  // Check if email already exists
  const existingUser = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existingUser.length > 0) {
    throw new Error("Email already registered");
  }

  const platform = await ensureDefaultPlatform();
  const userId = generateId();
  const hashedPassword = await hashPassword(password);
  const now = new Date();

  // Create user
  await db.insert(users).values({
    id: userId,
    name,
    email,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
    platformId: platform.id,
    platformRole: "MEMBER",
    status: "ACTIVE",
  });

  // Create identity
  await db.insert(userIdentities).values({
    userId,
    email,
    password: hashedPassword,
    provider: "EMAIL",
    firstName: name.split(" ")[0] || name,
    lastName: name.split(" ").slice(1).join(" ") || null,
    tokenVersion: 0,
    verified: true,
  });

  // Create default project
  const project = await getOrCreateDefaultProject(userId, platform.id);

  // Generate tokens
  const tokens = await generateTokens(
    userId,
    email,
    platform.id,
    project.id,
    0
  );

  return {
    ...tokens,
    user: {
      id: userId,
      email,
      name,
      image: null,
      platformId: platform.id,
      projectId: project.id,
    },
  };
}

// ============================================================================
// Sign In
// ============================================================================

export async function signIn(
  email: string,
  password: string
): Promise<AuthResponse> {
  // Find user by email
  const user = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (user.length === 0) {
    throw new Error("Invalid email or password");
  }

  const userData = user[0];

  // Find identity
  const identity = await db
    .select()
    .from(userIdentities)
    .where(eq(userIdentities.userId, userData.id))
    .limit(1);

  if (identity.length === 0 || !identity[0].password) {
    throw new Error("Invalid email or password");
  }

  // Verify password
  const passwordValid = await verifyPassword(password, identity[0].password);
  if (!passwordValid) {
    throw new Error("Invalid email or password");
  }

  // If password was in scrypt format, re-hash with bcrypt
  if (identity[0].password.includes(":")) {
    const newHash = await hashPassword(password);
    await db
      .update(userIdentities)
      .set({ password: newHash, updatedAt: new Date() })
      .where(eq(userIdentities.id, identity[0].id));
  }

  // Ensure platform and project exist
  const platform = await ensureDefaultPlatform();
  const project = await getOrCreateDefaultProject(userData.id, platform.id);

  // Update user platformId if not set
  if (!userData.platformId) {
    await db
      .update(users)
      .set({ platformId: platform.id, updatedAt: new Date() })
      .where(eq(users.id, userData.id));
  }

  // Generate tokens
  const tokens = await generateTokens(
    userData.id,
    userData.email!,
    platform.id,
    project.id,
    identity[0].tokenVersion
  );

  return {
    ...tokens,
    user: {
      id: userData.id,
      email: userData.email!,
      name: userData.name,
      image: userData.image,
      platformId: platform.id,
      projectId: project.id,
    },
  };
}

// ============================================================================
// Social Auth (GitHub / Google)
// ============================================================================

export type SocialProfile = {
  email: string;
  name: string | null;
  image: string | null;
  provider: "GITHUB" | "GOOGLE";
};

/**
 * Sign in or create user from social OAuth profile.
 */
export async function signInSocial(
  profile: SocialProfile
): Promise<AuthResponse> {
  const platform = await ensureDefaultPlatform();

  // Check if user exists by email
  const existingUser = await db
    .select()
    .from(users)
    .where(eq(users.email, profile.email))
    .limit(1);

  let userId: string;
  let userName: string | null;
  let userImage: string | null;

  if (existingUser.length > 0) {
    // Existing user - sign in
    userId = existingUser[0].id;
    userName = existingUser[0].name;
    userImage = existingUser[0].image;

    // Update image if provided by social profile
    if (profile.image && !existingUser[0].image) {
      await db
        .update(users)
        .set({ image: profile.image, updatedAt: new Date() })
        .where(eq(users.id, userId));
      userImage = profile.image;
    }

    // Ensure identity exists for this provider
    const existingIdentity = await db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.userId, userId))
      .limit(1);

    if (existingIdentity.length === 0) {
      await db.insert(userIdentities).values({
        userId,
        email: profile.email,
        provider: profile.provider,
        firstName: profile.name?.split(" ")[0] || null,
        lastName: profile.name?.split(" ").slice(1).join(" ") || null,
        tokenVersion: 0,
        verified: true,
      });
    }
  } else {
    // New user - create account
    userId = generateId();
    userName = profile.name;
    userImage = profile.image;
    const now = new Date();

    await db.insert(users).values({
      id: userId,
      name: profile.name,
      email: profile.email,
      emailVerified: true,
      image: profile.image,
      createdAt: now,
      updatedAt: now,
      platformId: platform.id,
      platformRole: "MEMBER",
      status: "ACTIVE",
    });

    await db.insert(userIdentities).values({
      userId,
      email: profile.email,
      provider: profile.provider,
      firstName: profile.name?.split(" ")[0] || null,
      lastName: profile.name?.split(" ").slice(1).join(" ") || null,
      tokenVersion: 0,
      verified: true,
    });
  }

  // Ensure platform association
  const user = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (user.length > 0 && !user[0].platformId) {
    await db
      .update(users)
      .set({ platformId: platform.id, updatedAt: new Date() })
      .where(eq(users.id, userId));
  }

  // Ensure project exists
  const project = await getOrCreateDefaultProject(userId, platform.id);

  // Get token version
  const identity = await db
    .select({ tokenVersion: userIdentities.tokenVersion })
    .from(userIdentities)
    .where(eq(userIdentities.userId, userId))
    .limit(1);

  const tokenVersion = identity.length > 0 ? identity[0].tokenVersion : 0;

  // Generate tokens
  const tokens = await generateTokens(
    userId,
    profile.email,
    platform.id,
    project.id,
    tokenVersion
  );

  return {
    ...tokens,
    user: {
      id: userId,
      email: profile.email,
      name: userName,
      image: userImage,
      platformId: platform.id,
      projectId: project.id,
    },
  };
}

// ============================================================================
// Token Refresh
// ============================================================================

export async function refreshTokens(
  refreshToken: string
): Promise<AuthTokens | null> {
  const payload = await verifyRefreshToken(refreshToken);
  if (!payload) return null;

  // Get current token version
  const identity = await db
    .select({ tokenVersion: userIdentities.tokenVersion })
    .from(userIdentities)
    .where(eq(userIdentities.userId, payload.sub))
    .limit(1);

  if (identity.length === 0) return null;

  return generateTokens(
    payload.sub,
    payload.email,
    payload.platformId,
    payload.projectId,
    identity[0].tokenVersion
  );
}
