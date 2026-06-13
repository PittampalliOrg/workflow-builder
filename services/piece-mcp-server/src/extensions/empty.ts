/**
 * Empty extensions registry for per-piece / base image builds.
 *
 * build.mjs (BUILD_VARIANT=single) resolves ./extensions/index.js to this module so the
 * bespoke in-repo extensions (which statically import specific bundled pieces, e.g.
 * @activepieces/piece-microsoft-onedrive) don't drag those pieces into a per-piece image
 * that doesn't have them installed. A per-piece image serves exactly its one piece's
 * native actions; bespoke extensions remain a bundle-mode feature. See
 * docs/per-piece-runtime-images.md.
 */
import type { Action } from "@activepieces/pieces-framework";

// biome-ignore lint/suspicious/noExplicitAny: matches extensions/index.ts signature
export function extensionsFor(_pieceName: string): Action<any, any>[] {
	return [];
}
