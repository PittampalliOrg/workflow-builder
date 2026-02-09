/**
 * Sync OAuth Apps from Environment Variables
 *
 * Reads OAUTH_APP_*_CLIENT_ID / OAUTH_APP_*_CLIENT_SECRET env vars and upserts
 * them into the platform_oauth_apps table with encrypted clientSecret.
 *
 * Usage:
 *   pnpm sync-oauth-apps
 *
 * Env vars consumed:
 *   OAUTH_APP_GOOGLE_CLIENT_ID + OAUTH_APP_GOOGLE_CLIENT_SECRET
 *   OAUTH_APP_MICROSOFT_CLIENT_ID + OAUTH_APP_MICROSOFT_CLIENT_SECRET
 *   OAUTH_APP_LINKEDIN_CLIENT_ID + OAUTH_APP_LINKEDIN_CLIENT_SECRET
 *   ... (any OAUTH_APP_<SUFFIX>_CLIENT_ID pattern)
 *
 * Requires:
 *   DATABASE_URL - PostgreSQL connection string
 *   AP_ENCRYPTION_KEY - AES-256-CBC encryption key
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, and } from "drizzle-orm";
import postgres from "postgres";
import { platforms, platformOauthApps } from "../lib/db/schema";
import { encryptString } from "../lib/security/encryption";
import { generateId } from "../lib/utils/id";
import {
  envSuffixToPieceNames,
  pieceNameToFullName,
} from "../lib/oauth-app-env-mapping";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://localhost:5432/workflow";

/** Extract OAUTH_APP_<SUFFIX>_CLIENT_ID entries from process.env */
function discoverOAuthApps(): { suffix: string; clientId: string; clientSecret: string }[] {
  const pattern = /^OAUTH_APP_(.+)_CLIENT_ID$/;
  const results: { suffix: string; clientId: string; clientSecret: string }[] = [];

  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(pattern);
    if (!match || !value) continue;

    const suffix = match[1];
    const secretKey = `OAUTH_APP_${suffix}_CLIENT_SECRET`;
    const clientSecret = process.env[secretKey];

    if (!clientSecret) {
      console.warn(
        `  WARN: Found ${key} but missing ${secretKey}, skipping ${suffix}`
      );
      continue;
    }

    results.push({ suffix, clientId: value, clientSecret });
  }

  return results;
}

async function syncOAuthApps() {
  console.log("Syncing OAuth apps from environment variables...\n");

  const queryClient = postgres(DATABASE_URL, { max: 1 });
  const db = drizzle(queryClient);

  try {
    // Get default platform
    const allPlatforms = await db.select().from(platforms).limit(1);
    if (allPlatforms.length === 0) {
      console.error("ERROR: No platform found. Run seed-dev-user first.");
      process.exit(1);
    }
    const platformId = allPlatforms[0].id;
    console.log(`Using platform: ${allPlatforms[0].name} (${platformId})\n`);

    // Discover OAuth apps from env
    const apps = discoverOAuthApps();
    if (apps.length === 0) {
      console.log("No OAUTH_APP_*_CLIENT_ID env vars found. Nothing to sync.");
      return;
    }

    console.log(`Found ${apps.length} OAuth app config(s):\n`);

    let upserted = 0;
    const now = new Date();

    for (const { suffix, clientId, clientSecret } of apps) {
      const pieceNames = envSuffixToPieceNames(suffix);
      const encryptedSecret = encryptString(clientSecret);

      console.log(
        `  ${suffix} -> ${pieceNames.length} piece(s): ${pieceNames.join(", ")}`
      );

      for (const shortName of pieceNames) {
        const fullName = pieceNameToFullName(shortName);

        // Check if record exists
        const existing = await db
          .select()
          .from(platformOauthApps)
          .where(
            and(
              eq(platformOauthApps.platformId, platformId),
              eq(platformOauthApps.pieceName, fullName)
            )
          )
          .limit(1);

        if (existing.length > 0) {
          // Update existing record
          await db
            .update(platformOauthApps)
            .set({
              clientId,
              clientSecret: encryptedSecret,
              updatedAt: now,
            })
            .where(eq(platformOauthApps.id, existing[0].id));
          console.log(`    Updated: ${fullName}`);
        } else {
          // Insert new record
          await db.insert(platformOauthApps).values({
            id: generateId(),
            platformId,
            pieceName: fullName,
            clientId,
            clientSecret: encryptedSecret,
            createdAt: now,
            updatedAt: now,
          });
          console.log(`    Created: ${fullName}`);
        }

        upserted++;
      }
    }

    console.log(`\nDone. Upserted ${upserted} OAuth app record(s).`);
  } catch (error) {
    console.error("Failed to sync OAuth apps:", error);
    process.exit(1);
  } finally {
    await queryClient.end();
  }
}

syncOAuthApps();
