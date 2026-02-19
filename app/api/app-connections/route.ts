import { NextResponse } from "next/server";
import {
	exchangeOAuth2Code,
	exchangeOAuth2CodePlatform,
	getOAuth2AuthConfig,
	isOAuthConnectionType,
	resolveValueFromProps,
} from "@/lib/app-connections/oauth2";
import { getSession } from "@/lib/auth-helpers";
import {
	listAppConnections,
	removeSensitiveData,
	upsertAppConnection,
} from "@/lib/db/app-connections";
import { getPieceMetadataByName } from "@/lib/db/piece-metadata";
import { getOAuthAppByPieceName } from "@/lib/db/oauth-apps";
import {
	AppConnectionType,
	type ListAppConnectionsRequestQuery,
	type UpsertAppConnectionRequestBody,
} from "@/lib/types/app-connection";
import { ensurePieceMcpServer } from "@/lib/k8s/piece-mcp-provisioner";

const ENABLE_LEGACY_MCP_AUTO_PROVISION =
	process.env.MCP_AUTO_PROVISION_ON_CONNECTION_CREATE === "true";

function isUpsertBody(value: unknown): value is UpsertAppConnectionRequestBody {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const body = value as Record<string, unknown>;
	return Boolean(
		body.externalId &&
			body.displayName &&
			body.pieceName &&
			body.type &&
			body.value,
	);
}

export async function GET(request: Request) {
	try {
		const session = await getSession(request);

		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { searchParams } = new URL(request.url);
		const query: ListAppConnectionsRequestQuery = {
			projectId: searchParams.get("projectId") ?? "default",
			pieceName: searchParams.get("pieceName") ?? undefined,
			displayName: searchParams.get("displayName") ?? undefined,
			scope:
				(searchParams.get(
					"scope",
				) as ListAppConnectionsRequestQuery["scope"]) ?? undefined,
			limit: searchParams.get("limit")
				? Number(searchParams.get("limit"))
				: undefined,
		};

		const connections = await listAppConnections({
			ownerId: session.user.id,
			query,
		});

		return NextResponse.json({
			data: connections.map(removeSensitiveData),
			next: null,
			previous: null,
		});
	} catch (error) {
		return NextResponse.json(
			{
				error: "Failed to list app connections",
				details: error instanceof Error ? error.message : "Unknown error",
			},
			{ status: 500 },
		);
	}
}

export async function POST(request: Request) {
	try {
		const session = await getSession(request);

		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const rawBody = await request.json();
		if (!isUpsertBody(rawBody)) {
			return NextResponse.json(
				{ error: "Invalid request body" },
				{ status: 400 },
			);
		}

		const body = rawBody;
		const piece = await getPieceMetadataByName(
			body.pieceName,
			body.pieceVersion,
		);

		let upsertPayload: UpsertAppConnectionRequestBody = {
			...body,
			pieceVersion: body.pieceVersion ?? piece?.version ?? "0.0.0",
		};

		if (isOAuthConnectionType(body.type)) {
			switch (body.type) {
				case AppConnectionType.OAUTH2: {
					const oauthRequest = body as Extract<
						UpsertAppConnectionRequestBody,
						{ type: AppConnectionType.OAUTH2 }
					>;

					if (!("code" in oauthRequest.value)) {
						const connection = await upsertAppConnection(
							session.user.id,
							upsertPayload,
						);
						return NextResponse.json(removeSensitiveData(connection), {
							status: 201,
						});
					}

					if (!piece) {
						return NextResponse.json(
							{ error: "Piece metadata not found" },
							{ status: 404 },
						);
					}

					const oauthAuth = getOAuth2AuthConfig(piece);
					if (!oauthAuth?.tokenUrl) {
						return NextResponse.json(
							{ error: "Piece does not define an OAuth2 token URL" },
							{ status: 400 },
						);
					}

					const tokenUrl = resolveValueFromProps(
						oauthAuth.tokenUrl,
						oauthRequest.value.props,
					);

					const claimed = await exchangeOAuth2Code({
						code: oauthRequest.value.code,
						tokenUrl,
						clientId: oauthRequest.value.client_id,
						clientSecret: oauthRequest.value.client_secret,
						redirectUrl: oauthRequest.value.redirect_url,
						scope: oauthRequest.value.scope,
						props: oauthRequest.value.props,
						authorizationMethod:
							oauthRequest.value.authorization_method ??
							oauthAuth.authorizationMethod,
						codeVerifier: oauthRequest.value.code_verifier,
						grantType: oauthRequest.value.grant_type,
					});

					upsertPayload = {
						...oauthRequest,
						pieceVersion: oauthRequest.pieceVersion ?? piece.version,
						value: claimed,
					};
					break;
				}
				case AppConnectionType.PLATFORM_OAUTH2: {
					const oauthRequest = body as Extract<
						UpsertAppConnectionRequestBody,
						{ type: AppConnectionType.PLATFORM_OAUTH2 }
					>;

					if (!("code" in oauthRequest.value)) {
						const connection = await upsertAppConnection(
							session.user.id,
							upsertPayload,
						);
						return NextResponse.json(removeSensitiveData(connection), {
							status: 201,
						});
					}

					if (!piece) {
						return NextResponse.json(
							{ error: "Piece metadata not found" },
							{ status: 404 },
						);
					}

					const oauthAuth = getOAuth2AuthConfig(piece);
					if (!oauthAuth?.tokenUrl) {
						return NextResponse.json(
							{ error: "Piece does not define an OAuth2 token URL" },
							{ status: 400 },
						);
					}

					const oauthApp = await getOAuthAppByPieceName(oauthRequest.pieceName);
					if (!oauthApp) {
						return NextResponse.json(
							{
								error:
									"No OAuth app configured for this piece. Configure it in Settings > OAuth Apps.",
							},
							{ status: 400 },
						);
					}

					const tokenUrl = resolveValueFromProps(
						oauthAuth.tokenUrl,
						oauthRequest.value.props,
					);

					const claimed = await exchangeOAuth2CodePlatform({
						code: oauthRequest.value.code,
						tokenUrl,
						clientId: oauthRequest.value.client_id,
						clientSecret: oauthApp.clientSecret,
						redirectUrl: oauthRequest.value.redirect_url,
						scope: oauthRequest.value.scope,
						props: oauthRequest.value.props,
						authorizationMethod:
							oauthRequest.value.authorization_method ??
							oauthAuth.authorizationMethod,
						codeVerifier: oauthRequest.value.code_verifier,
					});

					upsertPayload = {
						...oauthRequest,
						pieceVersion: oauthRequest.pieceVersion ?? piece.version,
						value: claimed,
					};
					break;
				}
				default:
					return NextResponse.json(
						{
							error: "Unsupported OAuth2 connection type in this deployment",
						},
						{ status: 400 },
					);
			}
		}

		const connection = await upsertAppConnection(
			session.user.id,
			upsertPayload,
		);

		// Legacy-only behavior: keep disabled by default to avoid mixing
		// workflow app connections with project-managed MCP connection lifecycle.
		if (ENABLE_LEGACY_MCP_AUTO_PROVISION) {
			ensurePieceMcpServer(
				upsertPayload.pieceName,
				upsertPayload.externalId,
			).catch((err) => {
				console.error(
					`[auto-provision] Failed for ${upsertPayload.pieceName}:`,
					err.message,
				);
			});
		}

		return NextResponse.json(removeSensitiveData(connection), { status: 201 });
	} catch (error) {
		console.error("[app-connections POST] Error:", error);
		return NextResponse.json(
			{
				error: "Failed to upsert app connection",
				details: error instanceof Error ? error.message : "Unknown error",
			},
			{ status: 500 },
		);
	}
}
