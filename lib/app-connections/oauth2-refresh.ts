import "server-only";

import { resolveValueFromProps } from "@/lib/app-connections/oauth2";
import {
  type BaseOAuth2ConnectionValue,
  OAuth2AuthorizationMethod,
  type OAuth2ConnectionValueWithApp,
  OAuth2GrantType,
  type PlatformOAuth2ConnectionValue,
} from "@/lib/types/app-connection";

/**
 * Thrown when a refresh token is permanently invalid (revoked or expired).
 * Callers should mark the connection status as ERROR.
 */
export class InvalidGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGrantError";
  }
}

const TOKEN_EXPIRY_BUFFER_SECONDS = 15 * 60; // 15 minutes

/**
 * Check if an OAuth2 token needs refreshing.
 * Returns true if: now + 15min >= claimed_at + expires_in
 */
export function isOAuth2TokenExpired(
  connection: BaseOAuth2ConnectionValue
): boolean {
  const grantType = connection.grant_type ?? OAuth2GrantType.AUTHORIZATION_CODE;

  // If we can't refresh (no refresh_token), treat it as non-expiring for our purposes.
  if (
    grantType === OAuth2GrantType.AUTHORIZATION_CODE &&
    !connection.refresh_token
  ) {
    return false;
  }

  const expiresIn = connection.expires_in ?? 60 * 60;
  const claimedAt = connection.claimed_at ?? 0;
  const expiresAt = claimedAt + expiresIn;
  const nowSeconds = Math.floor(Date.now() / 1000);

  return nowSeconds + TOKEN_EXPIRY_BUFFER_SECONDS >= expiresAt;
}

/**
 * Refresh an OAuth2 access token.
 *
 * - authorization_code: refresh_token grant
 * - client_credentials: re-claim using client_credentials grant
 * Returns the updated connection value with new tokens.
 *
 * Reference: activepieces/packages/server/api/src/app/app-connection/app-connection-service/oauth2/oauth2-util.ts
 */
export async function refreshOAuth2Token(
  connection: OAuth2ConnectionValueWithApp | PlatformOAuth2ConnectionValue,
  clientSecretOverride?: string
): Promise<OAuth2ConnectionValueWithApp | PlatformOAuth2ConnectionValue> {
  const tokenUrl = connection.token_url;
  if (!tokenUrl) {
    throw new Error("No token URL configured for OAuth2 connection");
  }

  const grantType = connection.grant_type ?? OAuth2GrantType.AUTHORIZATION_CODE;
  if (
    grantType === OAuth2GrantType.AUTHORIZATION_CODE &&
    !connection.refresh_token
  ) {
    // Nothing to do; keep current value.
    return connection;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };

  const body = new URLSearchParams();
  switch (grantType) {
    case OAuth2GrantType.AUTHORIZATION_CODE:
      body.set("grant_type", "refresh_token");
      body.set("refresh_token", connection.refresh_token);
      break;
    case OAuth2GrantType.CLIENT_CREDENTIALS:
      body.set("grant_type", OAuth2GrantType.CLIENT_CREDENTIALS);
      if (connection.scope) {
        body.set(
          "scope",
          resolveValueFromProps(connection.scope, connection.props)
        );
      }
      if (connection.props) {
        for (const [key, value] of Object.entries(connection.props)) {
          if (value === undefined || value === null) {
            continue;
          }
          if (typeof value === "object") {
            continue;
          }
          body.set(key, String(value));
        }
      }
      break;
    default:
      throw new Error(`Unsupported OAuth2 grant type: ${grantType}`);
  }

  // Resolve client_secret: use override for PLATFORM_OAUTH2, otherwise from connection
  const clientSecret =
    clientSecretOverride ??
    ("client_secret" in connection ? connection.client_secret : "");

  // Apply authorization method
  const authMethod =
    connection.authorization_method ?? OAuth2AuthorizationMethod.BODY;

  if (authMethod === OAuth2AuthorizationMethod.HEADER) {
    const credentials = Buffer.from(
      `${connection.client_id}:${clientSecret}`
    ).toString("base64");
    headers.Authorization = `Basic ${credentials}`;
  } else {
    body.set("client_id", connection.client_id);
    body.set("client_secret", clientSecret);
  }

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers,
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    // Check for invalid_grant — token is permanently invalid
    let isInvalidGrant = false;
    try {
      const errorJson = JSON.parse(errorText);
      isInvalidGrant = errorJson?.error === "invalid_grant";
    } catch {
      isInvalidGrant = errorText.includes("invalid_grant");
    }
    if (isInvalidGrant) {
      throw new InvalidGrantError(
        "OAuth2 token refresh failed: invalid_grant. The refresh token is expired or revoked."
      );
    }
    throw new Error(
      `OAuth2 token refresh failed (${response.status}): ${errorText}`
    );
  }

  const tokenResponse = (await response.json()) as Record<string, unknown>;

  const STANDARD_KEYS = new Set([
    "access_token",
    "token_type",
    "refresh_token",
    "scope",
    "expires_in",
  ]);
  const extraData = Object.fromEntries(
    Object.entries(tokenResponse).filter(([key]) => !STANDARD_KEYS.has(key))
  );

  // Preserve the original connection type (OAUTH2 or PLATFORM_OAUTH2)
  return {
    ...connection,
    type: connection.type,
    access_token:
      (tokenResponse.access_token as string) ?? connection.access_token,
    refresh_token:
      (tokenResponse.refresh_token as string) ?? connection.refresh_token,
    token_type: (tokenResponse.token_type as string) ?? connection.token_type,
    expires_in: tokenResponse.expires_in as number | undefined,
    claimed_at: Math.round(Date.now() / 1000),
    scope: (tokenResponse.scope as string) ?? connection.scope,
    data: {
      ...connection.data,
      ...extraData,
    },
  } as OAuth2ConnectionValueWithApp | PlatformOAuth2ConnectionValue;
}
