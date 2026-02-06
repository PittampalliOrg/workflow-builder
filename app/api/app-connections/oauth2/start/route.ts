import { NextResponse } from "next/server";
import {
  buildOAuth2AuthorizationUrl,
  generateOAuthState,
  generatePkceChallenge,
  generatePkceVerifier,
  getOAuth2AuthConfig,
} from "@/lib/app-connections/oauth2";
import { auth } from "@/lib/auth";
import { getPieceMetadataByName } from "@/lib/db/piece-metadata";

export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
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

    if (!(body.pieceName && body.clientId && body.redirectUrl)) {
      return NextResponse.json(
        { error: "pieceName, clientId, and redirectUrl are required" },
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

    const verifier = generatePkceVerifier();
    const challenge = generatePkceChallenge(verifier);
    const state = generateOAuthState();

    const authorizationUrl = buildOAuth2AuthorizationUrl({
      authUrl: oauthAuth.authUrl,
      clientId: body.clientId,
      redirectUrl: body.redirectUrl,
      scope: oauthAuth.scope ?? [],
      state,
      codeChallenge: challenge,
    });

    return NextResponse.json({
      authorizationUrl,
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
