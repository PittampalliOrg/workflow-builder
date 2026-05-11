#!/usr/bin/env tsx
/**
 * Seed `piece_metadata` from a self-hosted JSON dump of the locally-installed
 * @activepieces/piece-* NPM packages. NO NETWORK CALLS.
 *
 * The companion dumper lives at:
 *   services/fn-activepieces/scripts/dump-piece-metadata.ts
 *
 * Usage:
 *   # 1. Dump the metadata from the locally-installed pieces:
 *   cd services/fn-activepieces && pnpm tsx scripts/dump-piece-metadata.ts > /tmp/pieces.json
 *
 *   # 2. Seed it into the workflow-builder DB (run from repo root):
 *   DATABASE_URL=postgres://... pnpm tsx scripts/sync-activepieces-pieces.ts --from-file /tmp/pieces.json
 *
 * The dump captures everything piece_metadata needs (auth shape, action +
 * trigger names + display names, logoUrl, categories, etc.) by introspecting
 * the Piece objects in services/fn-activepieces/src/piece-registry.ts. The
 * runtime execution path through fn-activepieces uses the same in-process
 * piece-registry, so this seed stays in lockstep with what fn-activepieces
 * can actually execute.
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://localhost:5432/workflow_builder";

type DumpedPiece = {
  name: string;
  displayName: string;
  description: string | null;
  version: string;
  logoUrl: string | null;
  authors: string[];
  categories: string[];
  minimumSupportedRelease: string;
  maximumSupportedRelease: string;
  auth: unknown;
  actions: Record<string, unknown>;
  triggers: Record<string, unknown>;
};

type CliOptions = {
  fromFile: string;
  dryRun: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { fromFile: "", dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--from-file") {
      opts.fromFile = argv[i + 1] ?? "";
      i += 1;
    } else if (arg.startsWith("--from-file=")) {
      opts.fromFile = arg.slice("--from-file=".length);
    }
  }
  if (!opts.fromFile) {
    console.error(
      "[sync-pieces] --from-file <path-to-pieces.json> is required.\n" +
        "Produce the file first:\n" +
        "  cd services/fn-activepieces && pnpm tsx scripts/dump-piece-metadata.ts > /tmp/pieces.json",
    );
    process.exit(2);
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`[sync-pieces] loading ${opts.fromFile}`);
  const raw = readFileSync(opts.fromFile, "utf8");
  const pieces = JSON.parse(raw) as DumpedPiece[];
  if (!Array.isArray(pieces)) throw new Error("piece dump was not an array");
  console.log(`[sync-pieces] loaded ${pieces.length} pieces from dump`);

  if (opts.dryRun) {
    console.log("[sync-pieces] DRY RUN — would upsert:");
    for (const p of pieces.slice(0, 5)) {
      const authType = (p.auth && typeof p.auth === "object")
        ? (p.auth as { type?: string }).type ?? "(no type)"
        : "(none)";
      console.log(
        `  - ${p.name}@${p.version} auth=${authType} actions=${Object.keys(p.actions).length} triggers=${Object.keys(p.triggers).length}`,
      );
    }
    console.log(`  ... and ${Math.max(0, pieces.length - 5)} more`);
    return;
  }

  const sql = postgres(DATABASE_URL, { max: 4 });
  try {
    const names = pieces.map((p) => p.name).filter(Boolean);
    if (names.length === 0) {
      console.log("[sync-pieces] nothing to upsert");
      return;
    }
    // Replace-set semantics: delete the pieces we're about to insert, then
    // bulk insert. Keeps the (name, version, platform_id) unique constraint
    // clean across re-runs.
    await sql.begin(async (tx) => {
      await tx`DELETE FROM piece_metadata WHERE name IN ${tx(names)}`;
      const rows = pieces.map((p) => ({
        // schema declares id with a $defaultFn(generateId), but the postgres
        // package's raw INSERT doesn't know about Drizzle defaults — supply
        // an explicit UUID so the NOT NULL constraint is satisfied.
        id: randomUUID(),
        name: p.name,
        authors: p.authors,
        display_name: p.displayName,
        logo_url: p.logoUrl ?? "",
        description: p.description ?? null,
        // schema declares platform_id text-nullable but the live table is
        // NOT NULL DEFAULT 'OFFICIAL' — fill with the marker when null.
        platform_id: "OFFICIAL",
        version: p.version,
        minimum_supported_release: p.minimumSupportedRelease,
        maximum_supported_release: p.maximumSupportedRelease,
        auth: p.auth ?? null,
        actions: p.actions,
        triggers: p.triggers,
        piece_type: "OFFICIAL",
        categories: p.categories,
        package_type: "REGISTRY",
      }));
      await tx`INSERT INTO piece_metadata ${tx(rows)}`;
    });
    console.log(`[sync-pieces] upserted ${pieces.length} pieces`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("[sync-pieces] failed:", err);
  process.exit(1);
});
