import { error } from "@sveltejs/kit";
import type { LayoutServerLoad } from "./$types";

/**
 * ADMIN gate for every page under `(admin)/`. Rendering these routes exposes
 * Dapr state stores, Kubernetes pod shapes, and orchestrator internals — they
 * must not be reachable for MEMBER users. `platformRole` flows from the root
 * `+layout.server.ts` via `parent()`.
 *
 * The sidebar also filters the Admin group when role !== 'ADMIN' (see
 * `src/lib/navigation/nav-config.ts`), but that's UX polish — this 403 is
 * the authoritative gate.
 */
export const load: LayoutServerLoad = async ({ parent }) => {
	const { platformRole } = await parent();
	if (platformRole !== "ADMIN") {
		throw error(403, "Admin access required");
	}
	return { isAdmin: true };
};
