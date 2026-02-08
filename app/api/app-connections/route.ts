import { NextResponse } from "next/server";
import {
  exchangeOAuth2Code,
  getOAuth2AuthConfig,
  isOAuthConnectionType,
  resolveValueFromProps,
} from "@/lib/app-connections/oauth2";
import { auth } from "@/lib/auth";
import {
  listAppConnections,
  removeSensitiveData,
  upsertAppConnection,
} from "@/lib/db/app-connections";
import { getPieceMetadataByName } from "@/lib/db/piece-metadata";
import {
  AppConnectionType,
  OAuth2GrantType,
  type ListAppConnectionsRequestQuery,
  type UpsertAppConnectionRequestBody,
} from "@/lib/types/app-connection";

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
      body.value
  );
}

export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

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
          "scope"
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
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rawBody = await request.json();
    if (!isUpsertBody(rawBody)) {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 }
      );
    }

    const body = rawBody;
    const piece = await getPieceMetadataByName(
      body.pieceName,
      body.pieceVersion
    );

    let upsertPayload: UpsertAppConnectionRequestBody = {
      ...body,
      pieceVersion: body.pieceVersion ?? piece?.version ?? "0.0.0",
    };

    if (isOAuthConnectionType(body.type)) {
      if (body.type !== AppConnectionType.OAUTH2) {
        return NextResponse.json(
          {
            error:
              "Only direct OAuth2 app credentials are supported in this deployment",
          },
          { status: 400 }
        );
      }

      const oauthRequest = body as Extract<
        UpsertAppConnectionRequestBody,
        { type: AppConnectionType.OAUTH2 }
      >;

      const value = oauthRequest.value as Record<string, unknown>;
      const alreadyClaimed =
        typeof value.access_token === "string" && value.access_token.length > 0;
      const hasCode = typeof value.code === "string" && value.code.length > 0;
      const grantType =
        (value.grant_type as OAuth2GrantType | undefined) ??
        OAuth2GrantType.AUTHORIZATION_CODE;

      // If caller already has tokens (e.g., imported connection), store as-is.
      if (!alreadyClaimed) {
        // Otherwise we need to claim from the token URL.
        if (!hasCode && grantType !== OAuth2GrantType.CLIENT_CREDENTIALS) {
          return NextResponse.json(
            { error: "Missing OAuth2 authorization code" },
            { status: 400 }
          );
        }

        if (!piece) {
          return NextResponse.json(
            { error: "Piece metadata not found" },
            { status: 404 }
          );
        }

        const oauthAuth = getOAuth2AuthConfig(piece);
        if (!oauthAuth?.tokenUrl) {
          return NextResponse.json(
            { error: "Piece does not define an OAuth2 token URL" },
            { status: 400 }
          );
        }

        const props = (value.props as Record<string, unknown> | undefined) ?? undefined;
        const tokenUrl = resolveValueFromProps(oauthAuth.tokenUrl, props);
        const resolvedScope =
          (value.scope as string | undefined) ??
          (oauthAuth.scope?.join(" ") ?? "");

        const claimed = await exchangeOAuth2Code({
          code: hasCode ? (value.code as string) : "",
          tokenUrl,
          clientId: String(value.client_id ?? ""),
          clientSecret: String(value.client_secret ?? ""),
          redirectUrl: String(value.redirect_url ?? ""),
          scope: resolvedScope,
          props,
          authorizationMethod:
            (value.authorization_method as any) ?? oauthAuth.authorizationMethod,
          codeVerifier: (value.code_verifier as string | undefined) ?? undefined,
          grantType: grantType,
        });

        upsertPayload = {
          ...oauthRequest,
          pieceVersion: oauthRequest.pieceVersion ?? piece.version,
          value: claimed,
        };
      }
    }

    const connection = await upsertAppConnection(
      session.user.id,
      upsertPayload
    );
    return NextResponse.json(removeSensitiveData(connection), { status: 201 });
  } catch (error) {
    console.error("[app-connections POST] Error:", error);
    return NextResponse.json(
      {
        error: "Failed to upsert app connection",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
