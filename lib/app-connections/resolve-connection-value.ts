import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { appConnections } from "@/lib/db/schema";
import { encryptObject } from "@/lib/security/encryption";
import {
  AppConnectionType,
  type AppConnectionValue,
  type OAuth2ConnectionValueWithApp,
} from "@/lib/types/app-connection";
import type { DecryptedAppConnection } from "@/lib/db/app-connections";
import { isOAuth2TokenExpired, refreshOAuth2Token } from "./oauth2-refresh";

/**
 * Resolve a connection's decrypted value for runtime use.
 *
 * For OAuth2 connections, this will refresh the token when needed and persist
 * the refreshed encrypted value back to the database.
 */
export async function resolveConnectionValueForUse(
  connection: DecryptedAppConnection
): Promise<AppConnectionValue> {
  let value: AppConnectionValue = connection.value;

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
      } catch {
        // Use existing (possibly expired) value and let caller handle downstream failure.
      }
    }
  }

  return value;
}

