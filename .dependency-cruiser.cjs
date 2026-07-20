/**
 * Structural import-boundary guard for the hexagonal architecture.
 *
 * Enforced invariants (see docs/hexagonal-architecture.md):
 *   1. Drizzle / $lib/server/db stay inside application/adapters (types included).
 *   2. Routes are inbound adapters: they use application services, never
 *      concrete adapters.
 *   3. The application core (everything under application/ except adapters/)
 *      depends outward only on types.
 *   4. Ratchet: the pre-existing compat shims that still reach into
 *      application/adapters are frozen; the allowlist below only shrinks.
 *      (Burn-down list for the quarantine-adapter decomposition.)
 *
 * Run: pnpm check:boundaries
 */

/**
 * Request-scoped server helpers a route may still import directly (they are
 * inbound-adapter concerns — auth gates, cookie/URL helpers, embedded-app and
 * Headlamp reverse proxies — not domain services, so they don't belong behind
 * an application port). Everything else under $lib/server must be reached
 * through getApplicationAdapters(). Shrink only if one of these later moves
 * behind a port; never grow it for new domain reach-ins.
 */
const ROUTE_SERVER_GUARD_ALLOWLIST = [
	"^src/lib/server/internal-auth\\.ts$",
	"^src/lib/server/platform-admin\\.ts$",
	"^src/lib/server/auth-cookies\\.ts$",
	"^src/lib/server/app-url\\.ts$",
	"^src/lib/server/embedded-app-proxy\\.ts$",
	"^src/lib/server/headlamp-proxy\\.ts$",
];

/** Legacy compat shims allowed to import application/adapters (ratchet — remove entries as slices land, never add). */
const ADAPTER_IMPORT_ALLOWLIST = [
	"^src/lib/server/agents/registry-sync\\.ts$",
	"^src/lib/server/agents/registry\\.ts$",
	"^src/lib/server/auth\\.ts$",
	"^src/lib/server/benchmarks/capacity-diagnostics\\.ts$",
	"^src/lib/server/benchmarks/resource-leases\\.ts$",
	"^src/lib/server/benchmarks/score-runner\\.ts$",
	"^src/lib/server/benchmarks/service\\.ts$",
	"^src/lib/server/benchmarks/trace-bundle\\.ts$",
	"^src/lib/server/code-functions/index\\.ts$",
	"^src/lib/server/environments/environment-image-builds\\.ts$",
	"^src/lib/server/environments/registry\\.ts$",
	"^src/lib/server/environments/swebench-environment-ensure\\.ts$",
	"^src/lib/server/evaluations/service\\.ts$",
	"^src/lib/server/goals/goal-loop\\.ts$",
	"^src/lib/server/lifecycle/cascade\\.ts$",
	"^src/lib/server/lifecycle/index\\.ts$",
	"^src/lib/server/lifecycle/pause\\.ts$",
	"^src/lib/server/lifecycle/resolvers\\.ts$",
	"^src/lib/server/observability/investigation\\.ts$",
	"^src/lib/server/observability/mlflow-lifecycle\\.ts$",
	"^src/lib/server/openshell-sessions\\.ts$",
	"^src/lib/server/skill-ingest\\.ts$",
	"^src/lib/server/startup\\.ts$",
];

module.exports = {
	forbidden: [
		{
			name: "db-only-in-adapters",
			severity: "error",
			comment:
				"Persistence (drizzle + $lib/server/db, runtime AND type imports) is only reachable from application/adapters, the db package itself, and startup bootstrap.",
			from: {
				pathNot: [
					"^src/lib/server/application/adapters",
					"^src/lib/server/db",
					"^src/lib/server/startup\\.ts$",
					"\\.test\\.ts$",
				],
			},
			to: {
				path: ["^src/lib/server/db", "(^|/)drizzle-orm(/|$)"],
			},
		},
		{
			name: "routes-no-adapters",
			severity: "error",
			comment:
				"Routes are inbound adapters: depend on application services (getApplicationAdapters()), never on concrete adapter classes.",
			from: { path: "^src/routes" },
			to: { path: "^src/lib/server/application/adapters" },
		},
		{
			name: "application-core-pure",
			severity: "warn",
			comment:
				"The application core may only depend outward on TYPES; runtime dependencies on non-application $lib/server modules belong behind ports. Promote to error once stable.",
			from: {
				path: "^src/lib/server/application",
				pathNot: ["^src/lib/server/application/adapters", "\\.test\\.ts$"],
			},
			to: {
				path: "^src/lib/server",
				pathNot: ["^src/lib/server/application"],
				dependencyTypesNot: ["type-only"],
			},
		},
		{
			name: "routes-through-application",
			severity: "warn",
			comment:
				"Routes are inbound adapters: reach server-side state through application services (getApplicationAdapters()), not $lib/server domain modules directly. " +
				"Burn-down ledger of the current runtime violator categories (drive each behind a port, then this rule flips to error): " +
				"otel/observability tracing helpers; sessions provisioning + native-session plumbing; workflow helpers (workflow-data, run wrappers, spec/registry); " +
				"kube/sandbox clients; scm/git + MCP gateways; files/registry + image-build helpers; dapr clients. " +
				"TODO: promote severity to error once the ledger reaches zero.",
			from: { path: "^src/routes" },
			to: {
				path: "^src/lib/server",
				pathNot: [
					"^src/lib/server/application",
					...ROUTE_SERVER_GUARD_ALLOWLIST,
				],
				dependencyTypesNot: ["type-only"],
			},
		},
		{
			name: "adapters-importers-ratchet",
			severity: "error",
			comment:
				"Only the frozen legacy compat shims may import application/adapters from outside application/. Shrink the allowlist as quarantine slices land; never grow it — new code goes through getApplicationAdapters().",
			from: {
				path: "^src/lib/server",
				pathNot: [
					"^src/lib/server/application",
					"\\.test\\.ts$",
					...ADAPTER_IMPORT_ALLOWLIST,
				],
			},
			to: { path: "^src/lib/server/application/adapters" },
		},
	],
	options: {
		doNotFollow: { path: "node_modules" },
		exclude: { path: ["\\.svelte$"] },
		// Resolution-only tsconfig with the $lib aliases declared flat —
		// dep-cruiser doesn't reliably pick paths up through the root
		// tsconfig's extends chain into .svelte-kit/tsconfig.json.
		tsConfig: { fileName: "tsconfig.depcruise.json" },
		tsPreCompilationDeps: true,
	},
};
