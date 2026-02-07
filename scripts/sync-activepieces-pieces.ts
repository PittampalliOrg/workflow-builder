#!/usr/bin/env tsx

import { upsertPieceMetadata } from "@/lib/db/piece-metadata";

const ACTIVEPIECES_PACKAGE_PREFIX = "@activepieces/piece-";
const DEFAULT_BASE_URL = "https://cloud.activepieces.com/api/v1";

type ActivepiecesPieceResponse = {
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
  i18n?: unknown;
  created?: string;
  updated?: string;
};

type CliOptions = {
  apiKey?: string;
  baseUrl: string;
  dryRun: boolean;
  limit: number;
  onlyNames: string[];
};

function normalizePieceName(name: string): string {
  if (name.startsWith(ACTIVEPIECES_PACKAGE_PREFIX)) {
    return name.slice(ACTIVEPIECES_PACKAGE_PREFIX.length);
  }
  return name;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    apiKey: process.env.ACTIVEPIECES_API_KEY,
    baseUrl: process.env.ACTIVEPIECES_API_BASE_URL ?? DEFAULT_BASE_URL,
    dryRun: false,
    limit: 1000,
    onlyNames: [],
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg.startsWith("--base-url=")) {
      options.baseUrl = arg.slice("--base-url=".length);
      continue;
    }

    if (arg.startsWith("--api-key=")) {
      options.apiKey = arg.slice("--api-key=".length);
      continue;
    }

    if (arg.startsWith("--limit=")) {
      const parsed = Number(arg.slice("--limit=".length));
      if (!Number.isNaN(parsed) && parsed > 0) {
        options.limit = parsed;
      }
      continue;
    }

    if (arg.startsWith("--only=")) {
      options.onlyNames = arg
        .slice("--only=".length)
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
        .map(normalizePieceName);
    }
  }

  return options;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function toObjectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

async function fetchPieces(
  options: CliOptions
): Promise<ActivepiecesPieceResponse[]> {
  const url = new URL(`${options.baseUrl.replace(/\/$/, "")}/pieces`);
  url.searchParams.set("limit", String(options.limit));

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (options.apiKey) {
    headers["api-key"] = options.apiKey;
  }

  const response = await fetch(url.toString(), { headers });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `Failed to fetch pieces from ${url.toString()} (${response.status}): ${message}`
    );
  }

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) {
    throw new Error("Unexpected /pieces response: expected an array");
  }

  return (payload as ActivepiecesPieceResponse[]).slice(0, options.limit);
}

/**
 * Fetch a single piece's full detail (with actions/triggers as objects, not counts).
 * The listing API returns actions as a count (number), but the detail API returns
 * the full action definitions with props.
 */
async function fetchPieceDetail(
  options: CliOptions,
  pieceName: string
): Promise<ActivepiecesPieceResponse | null> {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}/pieces/${encodeURIComponent(pieceName)}`;

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (options.apiKey) {
    headers["api-key"] = options.apiKey;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    console.warn(
      `[Sync Pieces] Failed to fetch detail for ${pieceName}: ${response.status}`
    );
    return null;
  }

  return (await response.json()) as ActivepiecesPieceResponse;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  console.log(`[Sync Pieces] Source: ${options.baseUrl}`);
  console.log(`[Sync Pieces] Dry run: ${options.dryRun ? "yes" : "no"}`);

  const pieces = await fetchPieces(options);
  const filteredPieces =
    options.onlyNames.length === 0
      ? pieces
      : pieces.filter((piece) => {
          const normalized = normalizePieceName(String(piece.name ?? ""));
          return options.onlyNames.includes(normalized);
        });

  if (filteredPieces.length === 0) {
    console.log("[Sync Pieces] No pieces matched filters. Nothing to sync.");
    return;
  }

  let syncedCount = 0;
  let skippedCount = 0;

  for (const piece of filteredPieces) {
    const rawName = String(piece.name ?? "").trim();
    if (!rawName) {
      skippedCount += 1;
      continue;
    }

    const normalizedName = normalizePieceName(rawName);

    // The listing API returns actions/triggers as counts (numbers), not objects.
    // Fetch full detail for each piece to get actual action definitions with props.
    const needsDetail =
      typeof piece.actions === "number" || typeof piece.triggers === "number";
    let detailPiece = piece;

    if (needsDetail) {
      console.log(
        `[Sync Pieces] Fetching detail for ${normalizedName} (listing had actions=${piece.actions})...`
      );
      const detail = await fetchPieceDetail(options, rawName);
      if (detail) {
        detailPiece = detail;
      } else {
        console.warn(
          `[Sync Pieces] Could not fetch detail for ${normalizedName}, using listing data`
        );
      }
    }

    const version = String(detailPiece.version ?? "0.0.0").trim();

    const record = {
      name: normalizedName,
      authors: toStringArray(detailPiece.authors),
      displayName: String(detailPiece.displayName ?? normalizedName),
      logoUrl: String(detailPiece.logoUrl ?? ""),
      description: detailPiece.description ?? null,
      platformId: detailPiece.platformId ?? null,
      version,
      minimumSupportedRelease: String(detailPiece.minimumSupportedRelease ?? "0.0.0"),
      maximumSupportedRelease: String(
        detailPiece.maximumSupportedRelease ?? "9999.9999.9999"
      ),
      auth: detailPiece.auth ?? null,
      actions: toObjectRecord(detailPiece.actions),
      triggers: toObjectRecord(detailPiece.triggers),
      pieceType: String(detailPiece.pieceType ?? "OFFICIAL"),
      categories: toStringArray(detailPiece.categories),
      packageType: String(detailPiece.packageType ?? "REGISTRY"),
      i18n: detailPiece.i18n ?? null,
      createdAt: detailPiece.created ? new Date(detailPiece.created) : new Date(),
      updatedAt: detailPiece.updated ? new Date(detailPiece.updated) : new Date(),
    };

    if (options.dryRun) {
      console.log(`[Sync Pieces] Would upsert ${normalizedName}@${version} (${Object.keys(record.actions).length} actions)`);
      syncedCount += 1;
      continue;
    }

    await upsertPieceMetadata(record);
    console.log(`[Sync Pieces] Synced ${normalizedName}@${version} (${Object.keys(record.actions).length} actions)`);
    syncedCount += 1;
  }

  console.log(
    `[Sync Pieces] Complete. Synced: ${syncedCount}, Skipped: ${skippedCount}`
  );
}

main().catch((error) => {
  console.error("[Sync Pieces] Failed:", error);
  process.exit(1);
});
