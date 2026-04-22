/**
 * Piece extensions registry.
 *
 * A tiny layer that augments vendored AP pieces with supplementary actions
 * without forking the upstream npm package. Each entry maps a piece name
 * (AP convention — lowercase-dashed, e.g. "microsoft-onedrive") to an array
 * of extra `Action` objects that get registered as MCP tools alongside the
 * vendored piece's actions.
 *
 * Extensions live next to this file. To add new extensions:
 *   1. Create src/extensions/<piece-name>.ts exporting an Action array
 *      (use createAction + pieces-framework, reuse the vendored piece's
 *      auth where possible for free token resolution).
 *   2. Add an entry below.
 *
 * Upstream piece version bumps don't touch this file unless the piece
 * renames the exports we import — a one-line fix in that case.
 */

import type { Action } from "@activepieces/pieces-framework";
import { microsoftOneDriveExtensions } from "./microsoft-onedrive.js";

// biome-ignore lint/suspicious/noExplicitAny: Action is generic over auth + props; we erase for the registry
const registry: Record<string, Action<any, any>[]> = {
	"microsoft-onedrive": microsoftOneDriveExtensions,
};

/**
 * Look up extension actions for a given piece name. Piece name should match
 * the AP convention used by piece-registry.ts (lowercase-dashed, no
 * `@activepieces/piece-` prefix). Returns [] when no extensions are defined.
 */
// biome-ignore lint/suspicious/noExplicitAny: intentionally loose for consumer
export function extensionsFor(pieceName: string): Action<any, any>[] {
	const key = pieceName
		.trim()
		.toLowerCase()
		.replace(/^@activepieces\/piece-/, "");
	return registry[key] ?? [];
}
