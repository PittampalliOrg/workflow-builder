/**
 * #41 (route-registration-safe sync): detection of NEWLY ADDED files under
 * `src/routes/` in an incoming `/__sync` tar.
 *
 * Why: a sync that ADDS a route file while the Vite dev server is mid-restart
 * lands on disk but never registers the route — the replaced watcher misses the
 * `add` event and SvelteKit's route manifest is never regenerated (verified
 * live 2026-07-05: file present, `touch` produced no watcher event, requests
 * 302'd via the error-page layout). Edits to EXISTING files are safe (the next
 * watcher sees the mtime change); only additions need a full dev-server
 * restart, which the callers trigger via Vite's own `server.restart()`.
 *
 * Consumers:
 *  - the BFF's in-process Vite `/__sync` plugin (vite.config.ts) — restarts
 *    in-process when this returns entries;
 *  - the dev-sync-sidecar keeps an equivalent inline copy (it is a plain-node
 *    zero-dependency file that cannot import TS) and instead writes the
 *    RESTART SIGNAL file below, which the Vite plugin polls.
 *
 * Keep this helper pure (no node imports) so it is trivially unit-testable and
 * safe to import from vite.config.ts (no `$lib`/`$env` aliases at config time).
 */

/**
 * The restart-signal file the sidecar writes into the synced workdir when a
 * sync added new route files (sidecar transport = the apply happens in a
 * separate process, so it cannot call `server.restart()` itself). The Vite
 * plugin polls for this file (see `WFB_DEV_SYNC_RESTART_SIGNAL`), deletes it
 * (consume-before-restart, so a restart can never loop), then restarts.
 */
export const DEV_SYNC_RESTART_SIGNAL_FILE = ".dev-sync-restart-request.json";

/**
 * Given the member list of an incoming sync tar (as `tar -tzf` prints it) and
 * an existence predicate for the destination workdir, return the entries under
 * `routesPrefix` that do NOT yet exist on disk — i.e. the files whose creation
 * requires a dev-server restart to register.
 *
 * Call BEFORE extracting the tar (afterwards everything exists). Directory
 * members (trailing `/`) are ignored: a new route dir always comes with its
 * `+page/+server` file, which is what SvelteKit keys the manifest on.
 */
export function detectAddedRouteFiles(
	entries: readonly string[],
	exists: (relPath: string) => boolean,
	routesPrefix = "src/routes/",
): string[] {
	const added: string[] = [];
	const seen = new Set<string>();
	for (const raw of entries) {
		// busybox/GNU tar both list relative members; normalize a leading "./".
		const entry = raw.trim().replace(/^\.\//, "");
		if (!entry.startsWith(routesPrefix)) continue;
		if (entry.endsWith("/")) continue; // directory member
		if (seen.has(entry)) continue;
		seen.add(entry);
		if (!exists(entry)) added.push(entry);
	}
	return added;
}
