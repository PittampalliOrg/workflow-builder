import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

// Unauthenticated, DB-free 200-only readiness probe. The GAN preview critic
// polls this after each /__sync (the dev server restarts on sync, so the URL
// flaps) to know the server is back before it grades a route. Deliberately
// trivial so it answers the instant SvelteKit is serving.
export const GET: RequestHandler = () =>
	json(
		{ ok: true, liveSyncProof: "ARCHAPP-0715E-HMR-1" },
		{ headers: { "cache-control": "no-store" } }
	);
