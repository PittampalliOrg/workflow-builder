import { NextResponse } from "next/server";
import {
	buildOAuth2AuthorizationUrl,
	generateOAuthState,
	generatePkceChallenge,
	generatePkceVerifier,
	getOAuth2AuthConfig,
	resolveValueFromProps,
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
				{ status: 400 },
			);
		}

		const piece = await getPieceMetadataByName(
			body.pieceName,
			body.pieceVersion,
		);
		if (!piece) {
			return NextResponse.json({ error: "Piece not found" }, { status: 404 });
		}

		const oauthAuth = getOAuth2AuthConfig(piece);
		if (!oauthAuth?.authUrl) {
			return NextResponse.json(
				{ error: "Piece does not define OAuth2 auth URL" },
				{ status: 400 },
			);
		}

		// Resolve clientId: from request body or from platform_oauth_apps table
		let clientId = body.clientId;
		if (!clientId) {
			const oauthApp = await getOAuthAppByPieceName(body.pieceName);
			if (!oauthApp) {
				return NextResponse.json(
					{
						error:
							"No OAuth app configured for this piece. Configure it in Settings > OAuth Apps.",
					},
					{ status: 400 },
				);
			}
			clientId = oauthApp.clientId;
		}

		// Resolve redirectUrl: from request body or derive from request origin
		const redirectUrl =
			body.redirectUrl || `${new URL(request.url).origin}/redirect`;

		const verifier = generatePkceVerifier();
		const pkceEnabled = oauthAuth.pkce ?? false;
		const pkceMethod = oauthAuth.pkceMethod ?? "plain";
		const challenge = pkceEnabled
			? pkceMethod === "S256"
				? generatePkceChallenge(verifier)
				: verifier
			: "";
		const state = generateOAuthState();

		const authUrl = resolveValueFromProps(oauthAuth.authUrl, body.props);
		const scope = (oauthAuth.scope ?? []).map((s) =>
			resolveValueFromProps(s, body.props),
		);
		const extraParams = oauthAuth.extra
			? Object.fromEntries(
					Object.entries(oauthAuth.extra).map(([k, v]) => [
						k,
						resolveValueFromProps(v, body.props),
					]),
				)
			: undefined;

		const scopeString = scope.join(" ");
		const authorizationUrl = buildOAuth2AuthorizationUrl({
			authUrl,
			clientId,
			redirectUrl,
			scope,
			state,
			codeChallenge: pkceEnabled ? challenge : undefined,
			codeChallengeMethod: pkceMethod,
			prompt: oauthAuth.prompt,
			extraParams,
		});

		return NextResponse.json({
			authorizationUrl,
			clientId,
			state,
			codeVerifier: pkceEnabled ? verifier : "",
			codeChallenge: pkceEnabled ? challenge : "",
			redirectUrl,
			scope: scopeString,
		});
	} catch (error) {
		return NextResponse.json(
			{
				error: "Failed to start OAuth2 flow",
				details: error instanceof Error ? error.message : "Unknown error",
			},
			{ status: 500 },
		);
	}
}
