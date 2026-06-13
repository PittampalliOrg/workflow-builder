/**
 * Empty stand-in for piece-registry.static.ts in per-piece / base image builds.
 *
 * build.mjs (BUILD_VARIANT=single) resolves `./piece-registry.static.js` to THIS module,
 * so the 48 eager `require("@activepieces/piece-*")` calls never reach dist — the per-piece
 * image only loads its one piece dynamically (dynamic-registry.ts). See
 * docs/per-piece-runtime-images.md.
 */
import type { Piece } from "@activepieces/pieces-framework";

export const PIECES: Record<string, Piece> = {};
