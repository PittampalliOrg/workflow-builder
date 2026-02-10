import { NextResponse } from "next/server";
import type { SocialProfile } from "@/lib/auth-service";
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  signInSocial,
} from "@/lib/auth-service";

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

// ============================================================================
// GitHub helpers
// ============================================================================

async function exchangeGitHubCode(
  code: string,
  redirectUri: string
): Promise<string> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(
      `GitHub token exchange failed: ${data.error_description || data.error}`
    );
  }

  return data.access_token;
}

async function fetchGitHubProfile(accessToken: string): Promise<SocialProfile> {
  // Fetch user profile
  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!userResponse.ok) {
    throw new Error("Failed to fetch GitHub user profile");
  }

  const userData = await userResponse.json();

  // Fetch primary email
  let email = userData.email;

  if (!email) {
    const emailsResponse = await fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (emailsResponse.ok) {
      const emails = await emailsResponse.json();
      const primaryEmail = emails.find(
        (e: { primary: boolean; verified: boolean; email: string }) =>
          e.primary && e.verified
      );
      email = primaryEmail?.email || emails[0]?.email;
    }
  }

  if (!email) {
    throw new Error("Could not retrieve email from GitHub");
  }

  return {
    email,
    name: userData.name || userData.login,
    image: userData.avatar_url || null,
    provider: "GITHUB",
  };
}

// ============================================================================
// Google helpers
// ============================================================================

async function exchangeGoogleCode(
  code: string,
  redirectUri: string
): Promise<string> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(
      `Google token exchange failed: ${data.error_description || data.error}`
    );
  }

  return data.access_token;
}

async function fetchGoogleProfile(accessToken: string): Promise<SocialProfile> {
  const response = await fetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error("Failed to fetch Google user profile");
  }

  const data = await response.json();

  if (!data.email) {
    throw new Error("Could not retrieve email from Google");
  }

  return {
    email: data.email,
    name: data.name || null,
    image: data.picture || null,
    provider: "GOOGLE",
  };
}

// ============================================================================
// Route handler
// ============================================================================

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  try {
    const { provider } = await params;
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    // Validate required params
    if (!(code && state)) {
      return NextResponse.redirect(
        `${APP_URL}/sign-in?error=Missing+code+or+state+parameter`
      );
    }

    // Verify state against cookie
    const cookieHeader = request.headers.get("cookie");
    let storedState: string | undefined;

    if (cookieHeader) {
      const cookies = cookieHeader.split(";");
      for (const cookie of cookies) {
        const [key, ...valueParts] = cookie.trim().split("=");
        if (key === "oauth_state") {
          storedState = valueParts.join("=");
          break;
        }
      }
    }

    if (!storedState || storedState !== state) {
      return NextResponse.redirect(
        `${APP_URL}/sign-in?error=Invalid+OAuth+state`
      );
    }

    const redirectUri = `${APP_URL}/api/v1/auth/social/${provider}/callback`;

    // Exchange code and fetch profile based on provider
    let profile: SocialProfile;

    if (provider === "github") {
      const accessToken = await exchangeGitHubCode(code, redirectUri);
      profile = await fetchGitHubProfile(accessToken);
    } else if (provider === "google") {
      const accessToken = await exchangeGoogleCode(code, redirectUri);
      profile = await fetchGoogleProfile(accessToken);
    } else {
      return NextResponse.redirect(
        `${APP_URL}/sign-in?error=Unsupported+provider`
      );
    }

    // Sign in or create user
    const result = await signInSocial(profile);

    // Set cookies and redirect
    const response = NextResponse.redirect(APP_URL);

    response.cookies.set(ACCESS_TOKEN_COOKIE, result.accessToken, {
      ...COOKIE_OPTIONS,
      maxAge: 15 * 60, // 15 minutes
    });

    response.cookies.set(REFRESH_TOKEN_COOKIE, result.refreshToken, {
      ...COOKIE_OPTIONS,
      maxAge: 7 * 24 * 60 * 60, // 7 days
    });

    // Clear oauth_state cookie
    response.cookies.set("oauth_state", "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });

    return response;
  } catch (error) {
    console.error("OAuth callback failed:", error);
    const errorMessage =
      error instanceof Error ? error.message : "OAuth+callback+failed";
    return NextResponse.redirect(
      `${APP_URL}/sign-in?error=${encodeURIComponent(errorMessage)}`
    );
  }
}
