import { createHash, randomBytes } from "node:crypto";
import {
  AppConnectionType,
  OAuth2AuthorizationMethod,
  type OAuth2ConnectionValueWithApp,
  OAuth2GrantType,
} from "@/lib/types/app-connection";

type PieceAuth = {
  type?: string;
  authUrl?: string;
  tokenUrl?: string;
  scope?: string[];
  authorizationMethod?: OAuth2AuthorizationMethod;
  prompt?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toPieceAuth(value: unknown): PieceAuth | null {
  if (!isRecord(value)) {
    return null;
  }

  const scope = Array.isArray(value.scope)
    ? value.scope.filter((entry): entry is string => typeof entry === "string")
    : undefined;

  const authorizationMethodRaw = value.authorizationMethod;
  const authorizationMethod =
    authorizationMethodRaw === OAuth2AuthorizationMethod.HEADER ||
    authorizationMethodRaw === OAuth2AuthorizationMethod.BODY
      ? authorizationMethodRaw
      : undefined;

  return {
    type: typeof value.type === "string" ? value.type : undefined,
    authUrl: typeof value.authUrl === "string" ? value.authUrl : undefined,
    tokenUrl: typeof value.tokenUrl === "string" ? value.tokenUrl : undefined,
    scope,
    authorizationMethod,
    prompt: typeof value.prompt === "string" ? value.prompt : undefined,
  };
}

export function resolveValueFromProps(
  value: string,
  props?: Record<string, unknown>
): string {
  let resolved = value;

  if (!props) {
    return resolved;
  }

  for (const [key, replacement] of Object.entries(props)) {
    resolved = resolved.replace(`{${key}}`, String(replacement));
  }

  return resolved;
}

export function getOAuth2AuthConfig(
  piece: { auth?: unknown } | null | undefined
): PieceAuth | null {
  if (!piece || piece.auth === undefined || piece.auth === null) {
    return null;
  }

  const authValue = piece.auth;

  if (Array.isArray(authValue)) {
    for (const auth of authValue) {
      const parsed = toPieceAuth(auth);
      if (parsed?.type === "OAUTH2") {
        return parsed;
      }
    }
    return null;
  }

  const parsed = toPieceAuth(authValue);
  return parsed?.type === "OAUTH2" ? parsed : null;
}

export function generatePkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function generatePkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function generateOAuthState(): string {
  return randomBytes(24).toString("hex");
}

export function buildOAuth2AuthorizationUrl(params: {
  authUrl: string;
  clientId: string;
  redirectUrl: string;
  scope: string[];
  state: string;
  codeChallenge?: string;
  prompt?: string;
  extraParams?: Record<string, string>;
}): string {
  const url = new URL(params.authUrl);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("scope", params.scope.join(" "));
  url.searchParams.set("state", params.state);

  // AP uses prompt=consent by default; 'omit' means don't set it
  if (params.prompt && params.prompt !== "omit") {
    url.searchParams.set("prompt", params.prompt);
  } else if (!params.prompt) {
    url.searchParams.set("prompt", "consent");
  }

  if (params.codeChallenge) {
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }

  if (params.extraParams) {
    for (const [key, value] of Object.entries(params.extraParams)) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

export async function exchangeOAuth2Code(params: {
  code: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  scope: string;
  props?: Record<string, unknown>;
  authorizationMethod?: OAuth2AuthorizationMethod;
  codeVerifier?: string;
  grantType?: OAuth2GrantType;
}): Promise<OAuth2ConnectionValueWithApp> {
  const grantType = params.grantType ?? OAuth2GrantType.AUTHORIZATION_CODE;
  const body: Record<string, string> = {
    grant_type: grantType,
  };

  switch (grantType) {
    case OAuth2GrantType.AUTHORIZATION_CODE:
      body.code = params.code;
      body.redirect_uri = params.redirectUrl;
      break;
    case OAuth2GrantType.CLIENT_CREDENTIALS:
      body.scope = resolveValueFromProps(params.scope, params.props);
      break;
  }

  if (params.codeVerifier) {
    body.code_verifier = params.codeVerifier;
  }

  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };

  const authorizationMethod =
    params.authorizationMethod ?? OAuth2AuthorizationMethod.BODY;

  switch (authorizationMethod) {
    case OAuth2AuthorizationMethod.BODY:
      body.client_id = params.clientId;
      body.client_secret = params.clientSecret;
      break;
    case OAuth2AuthorizationMethod.HEADER:
      headers.authorization = `Basic ${Buffer.from(
        `${params.clientId}:${params.clientSecret}`
      ).toString("base64")}`;
      break;
  }

  const response = await fetch(params.tokenUrl, {
    method: "POST",
    headers,
    body: new URLSearchParams(body).toString(),
  });

  if (!response.ok) {
    let message = `OAuth2 token exchange failed with ${response.status}`;
    try {
      const errorBody = (await response.json()) as Record<string, unknown>;
      if (typeof errorBody.error_description === "string") {
        message = errorBody.error_description;
      }
    } catch {
      // no-op
    }
    throw new Error(message);
  }

  const tokenPayload = (await response.json()) as Record<string, unknown>;

  const claimedAt = Math.round(Date.now() / 1000);
  return {
    type: AppConnectionType.OAUTH2,
    access_token: String(tokenPayload.access_token ?? ""),
    token_type: String(tokenPayload.token_type ?? "bearer"),
    refresh_token: String(tokenPayload.refresh_token ?? ""),
    scope: String(tokenPayload.scope ?? params.scope ?? ""),
    expires_in: Number(tokenPayload.expires_in ?? 3600),
    claimed_at: claimedAt,
    token_url: params.tokenUrl,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_url: params.redirectUrl,
    authorization_method: authorizationMethod,
    grant_type: grantType,
    props: params.props,
    data: Object.fromEntries(
      Object.entries(tokenPayload).filter(
        ([key]) =>
          ![
            "access_token",
            "token_type",
            "refresh_token",
            "scope",
            "expires_in",
          ].includes(key)
      )
    ),
  };
}

export function isOAuthConnectionType(type: AppConnectionType): boolean {
  return (
    type === AppConnectionType.OAUTH2 ||
    type === AppConnectionType.CLOUD_OAUTH2 ||
    type === AppConnectionType.PLATFORM_OAUTH2
  );
}
