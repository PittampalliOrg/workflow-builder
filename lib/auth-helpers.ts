/**
 * Auth Helpers - Drop-in replacement for Better Auth's auth.api.getSession()
 *
 * Provides session extraction from JWT tokens in:
 * - Authorization: Bearer <token> header (API routes)
 * - wb_access_token cookie (SSR server components)
 */
import { cookies } from "next/headers";
import {
  ACCESS_TOKEN_COOKIE,
  type TokenPayload,
  verifyAccessToken,
} from "./auth-service";
import { db } from "./db";
import { users } from "./db/schema";
import { eq } from "drizzle-orm";

export type SessionUser = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  platformId: string;
  projectId: string;
};

export type Session = {
  user: SessionUser;
};

/**
 * Extract and verify session from a Request object.
 * Checks Authorization header first, falls back to cookie.
 * Drop-in replacement for: auth.api.getSession({ headers: request.headers })
 */
export async function getSession(request: Request): Promise<Session | null> {
  // Try Authorization header first
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    return verifyAndBuildSession(token);
  }

  // Fall back to cookie
  const cookieHeader = request.headers.get("cookie");
  if (cookieHeader) {
    const token = parseCookie(cookieHeader, ACCESS_TOKEN_COOKIE);
    if (token) {
      return verifyAndBuildSession(token);
    }
  }

  return null;
}

/**
 * Extract and verify session from cookies (for SSR server components).
 * Drop-in replacement for server component session fetching.
 */
export async function getSessionFromCookie(): Promise<Session | null> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(ACCESS_TOKEN_COOKIE)?.value;
    if (!token) return null;
    return verifyAndBuildSession(token);
  } catch {
    return null;
  }
}

/**
 * Verify a JWT token and build a Session object.
 */
async function verifyAndBuildSession(token: string): Promise<Session | null> {
  const payload = await verifyAccessToken(token);
  if (!payload) return null;

  // Look up user data for name/image (not stored in JWT)
  const user = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
    })
    .from(users)
    .where(eq(users.id, payload.sub))
    .limit(1);

  if (user.length === 0) return null;

  return {
    user: {
      id: user[0].id,
      name: user[0].name,
      email: user[0].email!,
      image: user[0].image,
      platformId: payload.platformId,
      projectId: payload.projectId,
    },
  };
}

/**
 * Parse a specific cookie from a Cookie header string.
 */
function parseCookie(cookieHeader: string, name: string): string | undefined {
  const cookies = cookieHeader.split(";");
  for (const cookie of cookies) {
    const [key, ...valueParts] = cookie.trim().split("=");
    if (key === name) {
      return valueParts.join("=");
    }
  }
  return undefined;
}
