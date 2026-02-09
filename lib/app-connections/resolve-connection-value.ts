import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import type { DecryptedAppConnection } from "@/lib/db/app-connections";
import { getOAuthAppByPieceName } from "@/lib/db/oauth-apps";
import { appConnections } from "@/lib/db/schema";
import { encryptObject } from "@/lib/security/encryption";
import {
  AppConnectionType,
  type AppConnectionValue,
  type OAuth2ConnectionValueWithApp,
  type PlatformOAuth2ConnectionValue,
} from "@/lib/types/app-connection";
import { isOAuth2TokenExpired, refreshOAuth2Token } from "./oauth2-refresh";

/**
 * Resolve a connection's decrypted value for runtime use.
 *
 * For OAuth2 connections, this will refresh the token when needed and persist
 * the refreshed encrypted value back to the database.
 *
 * For PLATFORM_OAUTH2, the client_secret is fetched from the oauth_apps table
 * (never stored on the connection itself).
 */
export async function resolveConnectionValueForUse(
  connection: DecryptedAppConnection
): Promise<AppConnectionValue> {
  let value: AppConnectionValue = connection.value;

  // Handle standard OAUTH2
  if (
    connection.type === AppConnectionType.OAUTH2 &&
    value.type === AppConnectionType.OAUTH2
  ) {
    const oauth2Value = value as OAuth2ConnectionValueWithApp;
    if (isOAuth2TokenExpired(oauth2Value)) {
      try {
        const refreshedValue = await refreshOAuth2Token(oauth2Value);

        await db
          .update(appConnections)
          .set({
            value: encryptObject(refreshedValue),
            updatedAt: new Date(),
          })
          .where(eq(appConnections.id, connection.id));

        value = refreshedValue;
      } catch (err) {
        console.warn(
          `[resolve-connection] OAuth2 token refresh failed for connection ${connection.id}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  // Handle PLATFORM_OAUTH2 — fetch client_secret from oauth_apps table
  if (
    connection.type === AppConnectionType.PLATFORM_OAUTH2 &&
    value.type === AppConnectionType.PLATFORM_OAUTH2
  ) {
    const platformValue = value as PlatformOAuth2ConnectionValue;
    if (isOAuth2TokenExpired(platformValue)) {
      try {
        const oauthApp = await getOAuthAppByPieceName(connection.pieceName);
        if (!oauthApp) {
          console.warn(
            `[resolve-connection] No OAuth app configured for piece ${connection.pieceName}, cannot refresh token`
          );
          return value;
        }

        const refreshedValue = await refreshOAuth2Token(
          platformValue,
          oauthApp.clientSecret
        );

        await db
          .update(appConnections)
          .set({
            value: encryptObject(refreshedValue),
            updatedAt: new Date(),
          })
          .where(eq(appConnections.id, connection.id));

        value = refreshedValue;
      } catch (err) {
        console.warn(
          `[resolve-connection] PLATFORM_OAUTH2 token refresh failed for connection ${connection.id}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  return value;
}
