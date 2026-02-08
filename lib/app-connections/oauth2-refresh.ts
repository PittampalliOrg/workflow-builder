import "server-only";

import {
  AppConnectionType,
  type BaseOAuth2ConnectionValue,
  type OAuth2ConnectionValueWithApp,
  OAuth2AuthorizationMethod,
} from "@/lib/types/app-connection";

const TOKEN_EXPIRY_BUFFER_SECONDS = 15 * 60; // 15 minutes

/**
 * Check if an OAuth2 token needs refreshing.
 * Returns true if: now + 15min >= claimed_at + expires_in
 */
export function isOAuth2TokenExpired(
  connection: BaseOAuth2ConnectionValue
): boolean {
  if (!connection.expires_in || !connection.claimed_at) {
    return false;
  }

  const expiresAt = connection.claimed_at + connection.expires_in;
  const nowSeconds = Math.floor(Date.now() / 1000);

  return nowSeconds + TOKEN_EXPIRY_BUFFER_SECONDS >= expiresAt;
}

/**
 * Refresh an OAuth2 access token using the refresh_token grant.
 * Returns the updated connection value with new tokens.
 *
 * Reference: activepieces/packages/server/api/src/app/app-connection/app-connection-service/oauth2/oauth2-util.ts
 */
export async function refreshOAuth2Token(
  connection: OAuth2ConnectionValueWithApp
): Promise<OAuth2ConnectionValueWithApp> {
  if (!connection.refresh_token) {
    throw new Error("No refresh token available for OAuth2 connection");
  }

  const tokenUrl = connection.token_url;
  if (!tokenUrl) {
    throw new Error("No token URL configured for OAuth2 connection");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: connection.refresh_token,
  });

  // Apply authorization method
  const authMethod =
    connection.authorization_method ?? OAuth2AuthorizationMethod.BODY;

  if (authMethod === OAuth2AuthorizationMethod.HEADER) {
    const credentials = Buffer.from(
      `${connection.client_id}:${connection.client_secret}`
    ).toString("base64");
    headers.Authorization = `Basic ${credentials}`;
  } else {
    body.set("client_id", connection.client_id);
    body.set("client_secret", connection.client_secret);
  }

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers,
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `OAuth2 token refresh failed (${response.status}): ${errorText}`
    );
  }

  const tokenResponse = (await response.json()) as Record<string, unknown>;

  return {
    ...connection,
    type: AppConnectionType.OAUTH2,
    access_token: (tokenResponse.access_token as string) ?? connection.access_token,
    refresh_token:
      (tokenResponse.refresh_token as string) ?? connection.refresh_token,
    token_type:
      (tokenResponse.token_type as string) ?? connection.token_type,
    expires_in: tokenResponse.expires_in as number | undefined,
    claimed_at: Math.floor(Date.now() / 1000),
    scope:
      (tokenResponse.scope as string) ?? connection.scope,
    data: {
      ...connection.data,
      ...((tokenResponse.data as Record<string, unknown>) ?? {}),
    },
  };
}
