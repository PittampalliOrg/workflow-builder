#!/usr/bin/env tsx
/**
 * Seed `piece_metadata` from the Activepieces cloud LIST endpoint.
 *
 * The list endpoint at `https://cloud.activepieces.com/api/v1/pieces?limit=N`
 * is fully public. The per-piece DETAIL endpoint requires an API key (returns
 * 403 anonymously), but list responses already contain everything the UI
 * picker needs: name, displayName, logoUrl, description, auth (with `type`),
 * categories, version, and action/trigger COUNTS as integers.
 *
 * The `piece_metadata.actions` JSONB column must have `Object.keys(...).length > 0`
 * — the `/api/mcp-connections/catalog` endpoint filters out pieces with zero
 * actions (see `actionCount` in `src/lib/server/mcp-catalog.ts`). The list
 * endpoint only gives us a count, so we synthesize placeholder keys
 * `action_0`..`action_<n-1>` (and same for triggers). The runtime path through
 * `fn-activepieces` uses the compiled-in piece-registry, NOT this column, so
 * placeholders are fine for the picker.
 *
 * Usage:
 *   DATABASE_URL=... pnpm tsx scripts/sync-activepieces-pieces.ts [--installed-only] [--dry-run]
 *
 * Flags:
 *   --installed-only    Only seed pieces present in
 *                       services/fn-activepieces/src/piece-registry.ts (45 + github).
 *                       Default: seed everything the cloud returns (~705 pieces).
 *   --dry-run           Print summary and skip the upsert.
 *   --base-url=URL      Override the Activepieces cloud base URL.
 *   --api-key=KEY       Optional Activepieces API key (not required for list).
 */

import postgres from "postgres";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://localhost:5432/workflow_builder";
const DEFAULT_BASE_URL =
  process.env.ACTIVEPIECES_API_BASE_URL ?? "https://cloud.activepieces.com/api/v1";
const ACTIVEPIECES_PACKAGE_PREFIX = "@activepieces/piece-";

// Pieces statically installed in services/fn-activepieces/src/piece-registry.ts.
// When --installed-only is passed we filter the cloud list to only these.
const INSTALLED_PIECES = new Set<string>([
  "airtable", "asana", "azure-blob-storage", "azure-openai", "bitly",
  "browse-ai", "browserless", "claude", "clickup", "contextual-ai",
  "discord", "dropbox", "gitea", "github", "gmail", "google-calendar",
  "google-docs", "google-drive", "google-sheets", "hubspot", "hugging-face",
  "jira-cloud", "linear", "linkedin", "mailchimp", "microsoft-excel-365",
  "microsoft-onedrive", "microsoft-onenote", "microsoft-outlook",
  "microsoft-teams", "microsoft-todo", "monday", "nocodb", "notion",
  "openai", "perplexity-ai", "postgres", "resend", "salesforce", "sendgrid",
  "shopify", "telegram-bot", "todoist", "trello", "youtube", "zendesk",
]);

type ActivepiecesPieceListEntry = {
  name?: string;
  authors?: unknown;
  displayName?: string;
  logoUrl?: string;
  description?: string | null;
  platformId?: string | null;
  version?: string;
  minimumSupportedRelease?: string;
  maximumSupportedRelease?: string;
  auth?: unknown;
  actions?: unknown;
  triggers?: unknown;
  pieceType?: string;
  categories?: unknown;
  packageType?: string;
};

type CliOptions = {
  baseUrl: string;
  apiKey?: string;
  installedOnly: boolean;
  dryRun: boolean;
  limit: number;
};

function normalizePieceName(name: string): string {
  return name.startsWith(ACTIVEPIECES_PACKAGE_PREFIX)
    ? name.slice(ACTIVEPIECES_PACKAGE_PREFIX.length)
    : name;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    baseUrl: DEFAULT_BASE_URL,
    apiKey: process.env.ACTIVEPIECES_API_KEY,
    installedOnly: false,
    dryRun: false,
    limit: 2000,
  };
  for (const arg of argv) {
    if (arg === "--installed-only") opts.installedOnly = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg.startsWith("--base-url=")) opts.baseUrl = arg.slice("--base-url=".length);
    else if (arg.startsWith("--api-key=")) opts.apiKey = arg.slice("--api-key=".length);
    else if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      if (Number.isFinite(n) && n > 0) opts.limit = n;
    }
  }
  return opts;
}

async function fetchList(opts: CliOptions): Promise<ActivepiecesPieceListEntry[]> {
  const url = new URL(`${opts.baseUrl.replace(/\/$/, "")}/pieces`);
  url.searchParams.set("limit", String(opts.limit));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "workflow-builder-sync-activepieces-pieces/1.0",
  };
  if (opts.apiKey) headers["api-key"] = opts.apiKey;
  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    throw new Error(`Failed to fetch piece list (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as unknown;
  if (!Array.isArray(json)) throw new Error("piece list response was not an array");
  return json as ActivepiecesPieceListEntry[];
}

/**
 * Synthesize action/trigger object map with N placeholder keys. The catalog
 * endpoint only cares about `Object.keys(actions).length`; the placeholder
 * names never reach execution paths (those use the compiled-in piece-registry).
 */
function synthesizeKeyMap(prefix: string, count: number): Record<string, unknown> {
  if (!Number.isFinite(count) || count <= 0) return {};
  const out: Record<string, unknown> = {};
  for (let i = 0; i < count; i += 1) {
    out[`${prefix}_${i}`] = { name: `${prefix}_${i}` };
  }
  return out;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  console.log(`[sync-pieces] source: ${opts.baseUrl}`);
  console.log(`[sync-pieces] mode: ${opts.installedOnly ? "installed-only" : "all"}`);

  const pieces = await fetchList(opts);
  console.log(`[sync-pieces] fetched ${pieces.length} pieces`);

  let filtered = pieces;
  if (opts.installedOnly) {
    filtered = pieces.filter((p) =>
      INSTALLED_PIECES.has(normalizePieceName(String(p.name ?? ""))),
    );
    console.log(`[sync-pieces] installed-only filter -> ${filtered.length} pieces`);
  }

  // Skip pieces with no actions and no triggers — nothing the picker can do
  const before = filtered.length;
  filtered = filtered.filter((p) => {
    const a = typeof p.actions === "number" ? p.actions : 0;
    const t = typeof p.triggers === "number" ? p.triggers : 0;
    return a > 0 || t > 0;
  });
  if (before !== filtered.length) {
    console.log(
      `[sync-pieces] dropped ${before - filtered.length} pieces with 0 actions+triggers`,
    );
  }

  if (opts.dryRun) {
    console.log(`[sync-pieces] DRY RUN — would upsert ${filtered.length} pieces; sample:`);
    for (const p of filtered.slice(0, 5)) {
      const norm = normalizePieceName(String(p.name ?? ""));
      const actions = typeof p.actions === "number" ? p.actions : 0;
      console.log(`  - ${norm}@${p.version} (${actions} actions)`);
    }
    return;
  }

  const sql = postgres(DATABASE_URL, { max: 4 });
  try {
    const names = filtered
      .map((p) => normalizePieceName(String(p.name ?? "")))
      .filter(Boolean);
    if (names.length === 0) {
      console.log("[sync-pieces] nothing to upsert");
      return;
    }

    // Replace-set semantics: delete the pieces we're about to insert, then
    // bulk insert. Keeps the (name, version, platform_id) unique constraint
    // clean across re-runs.
    await sql.begin(async (tx) => {
      await tx`DELETE FROM piece_metadata WHERE name IN ${tx(names)}`;
      const rows = filtered.map((p) => {
        const norm = normalizePieceName(String(p.name ?? ""));
        const aCount = typeof p.actions === "number" ? p.actions : 0;
        const tCount = typeof p.triggers === "number" ? p.triggers : 0;
        return {
          name: norm,
          authors: toStringArray(p.authors),
          display_name: String(p.displayName ?? norm),
          logo_url: String(p.logoUrl ?? ""),
          description: p.description ?? null,
          // schema declares platform_id text-nullable but the live table is
          // NOT NULL DEFAULT 'OFFICIAL' — fill with the marker when null.
          platform_id: p.platformId ?? "OFFICIAL",
          version: String(p.version ?? "0.0.0"),
          minimum_supported_release: String(p.minimumSupportedRelease ?? "0.0.0"),
          maximum_supported_release: String(p.maximumSupportedRelease ?? "9999.9999.9999"),
          auth: p.auth ?? null,
          // Catalog requires Object.keys(actions).length > 0. The list endpoint
          // doesn't give us action defs (detail endpoint is 403 anonymous), so
          // we fabricate placeholder keys matching the count.
          actions: aCount > 0
            ? synthesizeKeyMap("action", aCount)
            : { action_0: { name: "action_0" } },
          triggers: synthesizeKeyMap("trigger", tCount),
          piece_type: String(p.pieceType ?? "OFFICIAL"),
          categories: toStringArray(p.categories),
          package_type: String(p.packageType ?? "REGISTRY"),
        };
      });
      await tx`INSERT INTO piece_metadata ${tx(rows)}`;
    });
    console.log(`[sync-pieces] upserted ${filtered.length} pieces`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("[sync-pieces] failed:", err);
  process.exit(1);
});
