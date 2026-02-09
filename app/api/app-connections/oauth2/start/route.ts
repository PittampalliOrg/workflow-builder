import { NextResponse } from "next/server";
import {
  buildOAuth2AuthorizationUrl,
  generateOAuthState,
  generatePkceChallenge,
  generatePkceVerifier,
  getOAuth2AuthConfig,
} from "@/lib/app-connections/oauth2";
import { getSession } from "@/lib/auth-helpers";
import { getPieceMetadataByName } from "@/lib/db/piece-metadata";
import { getOAuthAppByPieceName } from "@/lib/db/oauth-apps";

export async function POST(request: Request) {
  try {
    const session = await getSession(request);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json()) as {
      pieceName?: string;
      pieceVersion?: string;
      clientId?: string;
      redirectUrl?: string;
      props?: Record<string, unknown>;
    };

    if (!body.pieceName) {
      return NextResponse.json(
        { error: "pieceName is required" },
        { status: 400 }
      );
    }

    const piece = await getPieceMetadataByName(
      body.pieceName,
      body.pieceVersion
    );
    if (!piece) {
      return NextResponse.json({ error: "Piece not found" }, { status: 404 });
    }

    const oauthAuth = getOAuth2AuthConfig(piece);
    if (!oauthAuth?.authUrl) {
      return NextResponse.json(
        { error: "Piece does not define OAuth2 auth URL" },
        { status: 400 }
      );
    }

    // Resolve clientId: from request body or from platform_oauth_apps table
    let clientId = body.clientId;
    if (!clientId) {
      const oauthApp = await getOAuthAppByPieceName(body.pieceName);
      if (!oauthApp) {
        return NextResponse.json(
          { error: "No OAuth app configured for this piece. Configure it in Settings > OAuth Apps." },
          { status: 400 }
        );
      }
      clientId = oauthApp.clientId;
    }

    // Resolve redirectUrl: from request body or derive from request origin
    const redirectUrl =
      body.redirectUrl ||
      `${new URL(request.url).origin}/api/app-connections/oauth2/callback`;

    const verifier = generatePkceVerifier();
    const challenge = generatePkceChallenge(verifier);
    const state = generateOAuthState();

    const authorizationUrl = buildOAuth2AuthorizationUrl({
      authUrl: oauthAuth.authUrl,
      clientId,
      redirectUrl,
      scope: oauthAuth.scope ?? [],
      state,
      codeChallenge: challenge,
      prompt: oauthAuth.prompt,
    });

    return NextResponse.json({
      authorizationUrl,
      clientId,
      state,
      codeVerifier: verifier,
      codeChallenge: challenge,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to start OAuth2 flow",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
