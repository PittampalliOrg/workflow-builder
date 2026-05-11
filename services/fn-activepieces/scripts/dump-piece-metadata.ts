#!/usr/bin/env tsx
/**
 * Dump piece metadata from the locally-installed @activepieces/piece-* NPM
 * packages to stdout as JSON. No network calls — fully self-hosted.
 *
 * Usage (run from services/fn-activepieces so the @activepieces symlinks
 * resolve):
 *
 *   cd services/fn-activepieces
 *   pnpm tsx scripts/dump-piece-metadata.ts > /tmp/pieces.json
 *
 * Then feed the JSON to the workflow-builder seeder:
 *
 *   cd ../..
 *   DATABASE_URL=postgres://postgres:.../workflow_builder \\
 *     pnpm tsx scripts/sync-activepieces-pieces.ts --from-file /tmp/pieces.json
 */
import { PIECES } from "../src/piece-registry";

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

const out = [];
for (const [normalized, piece] of Object.entries(PIECES)) {
  try {
    const actions = (piece.actions?.() ?? {}) as Record<string, unknown>;
    const triggers = (piece.triggers?.() ?? {}) as Record<string, unknown>;
    let auth: unknown = (piece as any).auth;
    if (typeof auth === "function") {
      try { auth = (auth as () => unknown)(); } catch { auth = null; }
    }
    // Extract serializable fields from action/trigger objects
    const reduceActions = (m: Record<string, unknown>) => {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(m)) {
        const a = v as any;
        o[k] = {
          name: a?.name ?? k,
          displayName: a?.displayName ?? k,
          description: a?.description ?? null,
          requireAuth: a?.requireAuth ?? true,
        };
      }
      return o;
    };
    out.push({
      name: normalized,
      displayName: piece.displayName ?? normalized,
      description: (piece as any).description ?? null,
      version: piece.version ?? "0.0.0",
      logoUrl: (piece as any).logoUrl ?? null,
      authors: asStringArray((piece as any).authors),
      categories: asStringArray((piece as any).categories),
      minimumSupportedRelease: (piece as any).minimumSupportedRelease ?? "0.0.0",
      maximumSupportedRelease: (piece as any).maximumSupportedRelease ?? "9999.9999.9999",
      auth: auth ?? null,
      actions: reduceActions(actions),
      triggers: reduceActions(triggers),
    });
  } catch (err) {
    console.error(`[dump] ${normalized}:`, (err as Error).message);
  }
}
process.stdout.write(JSON.stringify(out));
