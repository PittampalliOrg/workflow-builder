#!/usr/bin/env tsx

import { db } from "@/lib/db";
import { pieceMetadata } from "@/lib/db/schema";
import {
  type OAuth2AuthConfig,
  PieceAuthType,
  parsePieceAuthAll,
} from "@/lib/types/piece-auth";

type Counts = Record<string, number>;

function bump(map: Counts, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main() {
  const rows = await db
    .select({
      name: pieceMetadata.name,
      version: pieceMetadata.version,
      auth: pieceMetadata.auth,
    })
    .from(pieceMetadata);

  const authShapeCounts: Counts = {};
  const rawAuthTypeCounts: Counts = {};
  const parsedAuthTypeCounts: Counts = {};
  let unknownAuthTypeCount = 0;

  const oauth2GrantTypeCounts: Counts = {};
  const oauth2AuthorizationMethodCounts: Counts = {};
  let oauth2WithProps = 0;
  let oauth2WithExtra = 0;
  let oauth2PkceTrue = 0;
  let oauth2PkceFalse = 0;

  for (const row of rows) {
    const auth = row.auth as unknown;

    if (auth == null) {
      bump(authShapeCounts, "null");
      continue;
    }

    if (Array.isArray(auth)) {
      bump(authShapeCounts, "array");
      for (const entry of auth) {
        if (isRecord(entry) && typeof entry.type === "string") {
          bump(rawAuthTypeCounts, entry.type);
        }
      }
    } else if (isRecord(auth)) {
      bump(authShapeCounts, "object");
      if (typeof auth.type === "string") {
        bump(rawAuthTypeCounts, auth.type);
      }
    } else {
      bump(authShapeCounts, typeof auth);
    }

    const parsed = parsePieceAuthAll(auth);
    for (const cfg of parsed) {
      bump(parsedAuthTypeCounts, cfg.type);

      if (cfg.type === PieceAuthType.OAUTH2) {
        const oauth = cfg as OAuth2AuthConfig;
        bump(oauth2GrantTypeCounts, String(oauth.grantType ?? "undefined"));
        bump(
          oauth2AuthorizationMethodCounts,
          String(oauth.authorizationMethod ?? "undefined")
        );
        if (oauth.props && Object.keys(oauth.props).length > 0) {
          oauth2WithProps += 1;
        }
        if (oauth.extra && Object.keys(oauth.extra).length > 0) {
          oauth2WithExtra += 1;
        }
        if (oauth.pkce === false) {
          oauth2PkceFalse += 1;
        } else {
          oauth2PkceTrue += 1;
        }
      }
    }

    // Unknown type detection: raw has type(s) but parsePieceAuthAll dropped them all.
    const hadRawType =
      (Array.isArray(auth) &&
        auth.some((e) => isRecord(e) && typeof e.type === "string")) ||
      (isRecord(auth) && typeof auth.type === "string");
    if (hadRawType && parsed.length === 0) {
      unknownAuthTypeCount += 1;
      // Include a small sample in logs.
      if (unknownAuthTypeCount <= 10) {
        console.warn(
          `[Auth Analyze] Unknown/unparsed auth for ${row.name}@${row.version}:`,
          JSON.stringify(auth)
        );
      }
    }
  }

  console.log(`[Auth Analyze] piece_metadata rows: ${rows.length}`);
  console.log(
    `[Auth Analyze] auth shapes: ${JSON.stringify(authShapeCounts, null, 2)}`
  );
  console.log(
    `[Auth Analyze] raw auth types: ${JSON.stringify(rawAuthTypeCounts, null, 2)}`
  );
  console.log(
    `[Auth Analyze] parsed auth types: ${JSON.stringify(parsedAuthTypeCounts, null, 2)}`
  );
  console.log(
    `[Auth Analyze] oauth2 grantType: ${JSON.stringify(oauth2GrantTypeCounts, null, 2)}`
  );
  console.log(
    `[Auth Analyze] oauth2 authorizationMethod: ${JSON.stringify(
      oauth2AuthorizationMethodCounts,
      null,
      2
    )}`
  );
  console.log(`[Auth Analyze] oauth2 with props: ${oauth2WithProps}`);
  console.log(`[Auth Analyze] oauth2 with extra: ${oauth2WithExtra}`);
  console.log(`[Auth Analyze] oauth2 pkce true/undefined: ${oauth2PkceTrue}`);
  console.log(`[Auth Analyze] oauth2 pkce false: ${oauth2PkceFalse}`);

  if (unknownAuthTypeCount > 0) {
    console.error(
      `[Auth Analyze] Found ${unknownAuthTypeCount} pieces with unknown/unparsed auth configs.`
    );
    process.exit(1);
  }
}

main().catch((err) => {
  const looksLikeConnRefused =
    (err instanceof Error && err.message.includes("ECONNREFUSED")) ||
    // drizzle-postgres-js often nests ECONNREFUSED in AggregateError.errors
    (typeof err === "object" &&
      err !== null &&
      "cause" in err &&
      typeof (err as any).cause === "object" &&
      (err as any).cause !== null &&
      ((err as any).cause.code === "ECONNREFUSED" ||
        ((err as any).cause.errors &&
          Array.isArray((err as any).cause.errors) &&
          (err as any).cause.errors.some(
            (e: any) => e?.code === "ECONNREFUSED"
          ))));

  if (looksLikeConnRefused) {
    console.error(
      "[Auth Analyze] Failed: database connection refused. Set DATABASE_URL and ensure Postgres is running (or run this in the same environment as your app DB)."
    );
    process.exit(2);
  }

  console.error("[Auth Analyze] Failed:", err);
  process.exit(1);
});
