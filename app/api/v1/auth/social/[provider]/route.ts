import { NextResponse } from "next/server";

const SUPPORTED_PROVIDERS = ["github", "google"] as const;
type Provider = (typeof SUPPORTED_PROVIDERS)[number];

function isSupportedProvider(provider: string): provider is Provider {
  return SUPPORTED_PROVIDERS.includes(provider as Provider);
}

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  try {
    const { provider } = await params;

    if (!isSupportedProvider(provider)) {
      return NextResponse.json(
        { error: `Unsupported provider: ${provider}. Supported: ${SUPPORTED_PROVIDERS.join(", ")}` },
        { status: 400 }
      );
    }

    const state = crypto.randomUUID();
    const redirectUri = `${APP_URL}/api/v1/auth/social/${provider}/callback`;

    let authUrl: string;

    if (provider === "github") {
      const clientId = process.env.GITHUB_CLIENT_ID;
      if (!clientId) {
        return NextResponse.json(
          { error: "GITHUB_CLIENT_ID is not configured" },
          { status: 500 }
        );
      }

      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: "read:user,user:email",
        state,
      });

      authUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;
    } else {
      // google
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (!clientId) {
        return NextResponse.json(
          { error: "GOOGLE_CLIENT_ID is not configured" },
          { status: 500 }
        );
      }

      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email profile",
        state,
        access_type: "offline",
        prompt: "consent",
      });

      authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    }

    const response = NextResponse.redirect(authUrl);

    response.cookies.set("oauth_state", state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 10 * 60, // 10 minutes
    });

    return response;
  } catch (error) {
    console.error("OAuth initiation failed:", error);
    return NextResponse.json(
      { error: "Failed to initiate OAuth flow" },
      { status: 500 }
    );
  }
}
