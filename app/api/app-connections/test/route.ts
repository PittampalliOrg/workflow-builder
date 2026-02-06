import { NextResponse } from "next/server";
import {
  exchangeOAuth2Code,
  getOAuth2AuthConfig,
  resolveValueFromProps,
} from "@/lib/app-connections/oauth2";
import { auth } from "@/lib/auth";
import { getPieceMetadataByName } from "@/lib/db/piece-metadata";
import {
  AppConnectionType,
  OAuth2AuthorizationMethod,
  OAuth2GrantType,
  type UpsertAppConnectionRequestBody,
} from "@/lib/types/app-connection";

type TestResult = {
  status: "success" | "error";
  message: string;
};

type OAuthTestValue = {
  client_id?: string;
  client_secret?: string;
  redirect_url?: string;
  code?: string;
  scope?: string;
  props?: Record<string, unknown>;
  authorization_method?: string;
  code_challenge?: string;
  grant_type?: string;
};

function parseOAuthTestValue(value: unknown): OAuthTestValue {
  if (!value || typeof value !== "object") {
    return {};
  }

  const candidate = value as Record<string, unknown>;
  return {
    client_id:
      typeof candidate.client_id === "string" ? candidate.client_id : undefined,
    client_secret:
      typeof candidate.client_secret === "string"
        ? candidate.client_secret
        : undefined,
    redirect_url:
      typeof candidate.redirect_url === "string"
        ? candidate.redirect_url
        : undefined,
    code: typeof candidate.code === "string" ? candidate.code : undefined,
    scope: typeof candidate.scope === "string" ? candidate.scope : undefined,
    props:
      candidate.props && typeof candidate.props === "object"
        ? (candidate.props as Record<string, unknown>)
        : undefined,
    authorization_method:
      typeof candidate.authorization_method === "string"
        ? candidate.authorization_method
        : undefined,
    code_challenge:
      typeof candidate.code_challenge === "string"
        ? candidate.code_challenge
        : undefined,
    grant_type:
      typeof candidate.grant_type === "string"
        ? candidate.grant_type
        : undefined,
  };
}

function toAuthorizationMethod(
  value: string | undefined
): OAuth2AuthorizationMethod | undefined {
  if (value === OAuth2AuthorizationMethod.HEADER) {
    return OAuth2AuthorizationMethod.HEADER;
  }

  if (value === OAuth2AuthorizationMethod.BODY) {
    return OAuth2AuthorizationMethod.BODY;
  }

  return;
}

function toGrantType(value: string | undefined): OAuth2GrantType | undefined {
  if (value === OAuth2GrantType.AUTHORIZATION_CODE) {
    return OAuth2GrantType.AUTHORIZATION_CODE;
  }

  if (value === OAuth2GrantType.CLIENT_CREDENTIALS) {
    return OAuth2GrantType.CLIENT_CREDENTIALS;
  }

  return;
}

export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body =
      (await request.json()) as Partial<UpsertAppConnectionRequestBody>;

    if (!(body.type && body.pieceName && body.value)) {
      return NextResponse.json(
        { error: "type, pieceName and value are required" },
        { status: 400 }
      );
    }

    if (body.type !== AppConnectionType.OAUTH2) {
      return NextResponse.json({
        status: "success",
        message: "Credential format looks valid",
      } satisfies TestResult);
    }

    const oauthValue = parseOAuthTestValue(body.value);

    if (
      !(
        oauthValue.client_id &&
        oauthValue.client_secret &&
        oauthValue.redirect_url &&
        oauthValue.code
      )
    ) {
      return NextResponse.json(
        {
          status: "error",
          message: "Missing OAuth2 required fields",
        } satisfies TestResult,
        { status: 400 }
      );
    }

    const piece = await getPieceMetadataByName(
      body.pieceName,
      body.pieceVersion
    );
    if (!piece) {
      return NextResponse.json(
        {
          status: "error",
          message: "Piece metadata not found",
        } satisfies TestResult,
        { status: 404 }
      );
    }

    const oauthAuth = getOAuth2AuthConfig(piece);
    if (!oauthAuth?.tokenUrl) {
      return NextResponse.json(
        {
          status: "error",
          message: "Piece does not define OAuth2 token URL",
        } satisfies TestResult,
        { status: 400 }
      );
    }

    const tokenUrl = resolveValueFromProps(
      oauthAuth.tokenUrl,
      oauthValue.props
    );

    await exchangeOAuth2Code({
      code: oauthValue.code,
      tokenUrl,
      clientId: oauthValue.client_id,
      clientSecret: oauthValue.client_secret,
      redirectUrl: oauthValue.redirect_url,
      scope: oauthValue.scope ?? "",
      props: oauthValue.props,
      authorizationMethod: toAuthorizationMethod(
        oauthValue.authorization_method
      ),
      codeVerifier: oauthValue.code_challenge,
      grantType: toGrantType(oauthValue.grant_type),
    });

    return NextResponse.json({
      status: "success",
      message: "Connection successful",
    } satisfies TestResult);
  } catch (error) {
    return NextResponse.json(
      {
        status: "error",
        message: error instanceof Error ? error.message : "Connection failed",
      } satisfies TestResult,
      { status: 400 }
    );
  }
}
