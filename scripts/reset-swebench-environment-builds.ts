import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
const WORKFLOW_BUILDER_URL =
	process.env.WORKFLOW_BUILDER_URL ?? "http://localhost:3000";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;

type Args = {
	envSpecHash: string | null;
	environmentKey: string | null;
	status: string | null;
	allFailed: boolean;
	manualReconciled: boolean;
	limit: number;
	dryRun: boolean;
	recreate: boolean;
};

type BuildRow = {
	id: string;
	dataset: string;
	suite: string | null;
	repo: string;
	base_commit: string | null;
	environment_key: string;
	env_spec_hash: string;
	status: string;
	metadata: Record<string, unknown> | null;
};

function parseArgs(argv: string[]): Args {
	const args: Args = {
		envSpecHash: null,
		environmentKey: null,
		status: null,
		allFailed: false,
		manualReconciled: false,
		limit: 100,
		dryRun: true,
		recreate: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--env-spec-hash") {
			args.envSpecHash = requiredArg(argv, ++i, arg);
		} else if (arg === "--environment-key") {
			args.environmentKey = requiredArg(argv, ++i, arg);
		} else if (arg === "--status") {
			args.status = requiredArg(argv, ++i, arg);
		} else if (arg === "--all-failed") {
			args.allFailed = true;
			args.status = "failed";
		} else if (arg === "--manual-reconciled") {
			args.manualReconciled = true;
		} else if (arg === "--limit") {
			args.limit = positiveInteger(requiredArg(argv, ++i, arg), arg);
		} else if (arg === "--recreate") {
			args.recreate = true;
		} else if (arg === "--dry-run") {
			args.dryRun = true;
		} else if (arg === "--apply") {
			args.dryRun = false;
		} else if (arg === "--help" || arg === "-h") {
			printUsage();
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (!args.envSpecHash && !args.environmentKey && !args.status && !args.manualReconciled) {
		throw new Error("Provide --env-spec-hash, --environment-key, --status, --all-failed, or --manual-reconciled");
	}
	return args;
}

function printUsage() {
	console.log(
		[
			"Usage:",
			"  DATABASE_URL=... pnpm tsx scripts/reset-swebench-environment-builds.ts --env-spec-hash HASH --apply --recreate",
			"  DATABASE_URL=... pnpm tsx scripts/reset-swebench-environment-builds.ts --environment-key sympy-1.7 --apply",
			"  DATABASE_URL=... pnpm tsx scripts/reset-swebench-environment-builds.ts --all-failed --limit 20 --apply --recreate",
			"  DATABASE_URL=... pnpm tsx scripts/reset-swebench-environment-builds.ts --manual-reconciled --apply --recreate",
			"",
			"Options:",
			"  --env-spec-hash HASH    Select one environment image build spec hash.",
			"  --environment-key KEY   Select builds for one environment key.",
			"  --status STATUS         Select builds by status.",
			"  --all-failed            Alias for --status failed.",
			"  --manual-reconciled     Select builds with manual_reconcile activity events.",
			"  --limit N               Maximum selected rows. Default: 100.",
			"  --recreate              Call the internal environment ensure endpoint after deletion.",
			"  --apply                 Delete selected rows. Default is dry-run.",
			"  --dry-run               Show selected rows without deleting.",
		].join("\n"),
	);
}

function requiredArg(argv: string[], index: number, flag: string): string {
	const value = argv[index];
	if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

function positiveInteger(value: string, flag: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${flag} must be a positive integer`);
	}
	return parsed;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
	if (args.recreate && !args.dryRun && !INTERNAL_API_TOKEN) {
		throw new Error("INTERNAL_API_TOKEN is required with --recreate --apply");
	}

	const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
	try {
		let where = sql`true`;
		if (args.envSpecHash) where = sql`${where} and env_spec_hash = ${args.envSpecHash}`;
		if (args.environmentKey) where = sql`${where} and environment_key = ${args.environmentKey}`;
		if (args.status) where = sql`${where} and status = ${args.status}`;
		if (args.manualReconciled) {
			where = sql`${where} and exists (
				select 1
				from environment_build_activity_events event
				where event.build_id = environment_image_builds.id
					and (
						event.reason = 'manual_reconcile'
						or event.raw_metadata->>'reason' = 'manual_reconcile'
						or event.raw_metadata->>'source' = 'manual_reconcile'
					)
			)`;
		}

		const rows = await sql<BuildRow[]>`
			select
				id,
				dataset,
				suite,
				repo,
				base_commit,
				environment_key,
				env_spec_hash,
				status,
				metadata
			from environment_image_builds
			where ${where}
			order by requested_at desc
			limit ${args.limit}
		`;

		if (rows.length === 0) {
			console.log("No environment image build rows matched.");
			return;
		}

		for (const row of rows) {
			console.log(
				[
					row.id,
					row.status,
					row.environment_key,
					row.env_spec_hash,
					row.repo,
					row.base_commit ?? "no-base-commit",
				].join("\t"),
			);
		}

		if (args.dryRun) {
			console.log(`Dry-run: ${rows.length} row(s) would be deleted.`);
			return;
		}

		await sql`
			delete from environment_image_builds
			where id in ${sql(rows.map((row) => row.id))}
		`;
		console.log(`Deleted ${rows.length} environment image build row(s).`);

		if (!args.recreate) return;
		for (const row of rows) {
			await recreateBuild(row);
		}
	} finally {
		await sql.end({ timeout: 5 });
	}
}

async function recreateBuild(row: BuildRow) {
	if (!row.base_commit) {
		console.log(`Skipping ${row.id}: base_commit is missing.`);
		return;
	}
	const metadata = isRecord(row.metadata) ? row.metadata : {};
	const testMetadata = isRecord(metadata.testMetadata) ? metadata.testMetadata : {};
	const instanceId = typeof metadata.instanceId === "string" ? metadata.instanceId : null;
	const url = new URL("/api/internal/environments/ensure", WORKFLOW_BUILDER_URL);
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Internal-Token": INTERNAL_API_TOKEN ?? "",
		},
		body: JSON.stringify({
			dataset: row.dataset,
			datasetName: row.dataset,
			suiteSlug: normalizeSuiteSlug(row.suite ?? row.dataset),
			instanceId,
			repo: row.repo,
			baseCommit: row.base_commit,
			testMetadata,
		}),
	});
	const body = (await res.text()).slice(0, 1000);
	if (!res.ok) {
		throw new Error(`Failed to recreate ${row.id}: ${res.status} ${body}`);
	}
	console.log(`Recreated ${row.environment_key}: ${body}`);
}

function normalizeSuiteSlug(value: string): "SWE-bench_Verified" | "SWE-bench_Lite" {
	return value.includes("Verified") ? "SWE-bench_Verified" : "SWE-bench_Lite";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exitCode = 1;
});
