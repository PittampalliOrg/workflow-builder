import postgres from "postgres";

type Args = {
	suite: string;
	limit: number;
	targetValidated: number | null;
	forceRefreshLegacyStatic: boolean;
	apply: boolean;
	apiUrl: string;
	instanceIds: string[];
};

const DATABASE_URL = process.env.DATABASE_URL;
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;

function usage(): never {
	console.error([
		"Queue SWE-bench inference environment validation builds.",
		"",
		"Usage:",
		"  DATABASE_URL=... INTERNAL_API_TOKEN=... pnpm tsx scripts/queue-swebench-environment-validation.ts --suite SWE-bench_Verified --limit 80 --apply",
		"  node scripts/queue-swebench-environment-validation.bundle.js --suite SWE-bench_Verified --limit 80 --apply",
		"",
		"Options:",
		"  --suite SLUG              SWE-bench suite slug. Default: SWE-bench_Verified",
		"  --limit N                 Max instances to inspect/submit. Default: 10",
		"  --target-validated N      Stop once validated+building reaches N in this pass.",
		"  --force-refresh-legacy-static  Build exact dynamic images instead of counting legacy static mappings as ready.",
		"  --exact-for-random-runs   Alias for --force-refresh-legacy-static; use this before high-concurrency random runs.",
		"  --instance-id ID          Specific instance id. Repeatable.",
		"  --api-url URL             Workflow-builder base URL. Default: WORKFLOW_BUILDER_URL or http://127.0.0.1:3000",
		"  --apply                   Actually submit builds. Omit for dry run.",
	].join("\n"));
	process.exit(2);
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		suite: "SWE-bench_Verified",
		limit: 10,
		targetValidated: null,
		forceRefreshLegacyStatic: false,
		apply: false,
		apiUrl: process.env.WORKFLOW_BUILDER_URL || "http://127.0.0.1:3000",
		instanceIds: [],
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (!value) usage();
			return value;
		};
		if (arg === "--suite") args.suite = next();
		else if (arg === "--limit") args.limit = positiveInt(next(), "--limit");
		else if (arg === "--target-validated") {
			args.targetValidated = positiveInt(next(), "--target-validated");
		} else if (arg === "--instance-id") {
			args.instanceIds.push(next());
		} else if (arg === "--force-refresh-legacy-static") {
			args.forceRefreshLegacyStatic = true;
		} else if (arg === "--exact-for-random-runs") {
			args.forceRefreshLegacyStatic = true;
		} else if (arg === "--api-url") {
			args.apiUrl = next().replace(/\/+$/, "");
		} else if (arg === "--apply") {
			args.apply = true;
		} else if (arg === "-h" || arg === "--help") {
			usage();
		} else {
			console.error(`Unknown option: ${arg}`);
			usage();
		}
	}
	return args;
}

function positiveInt(value: string, name: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return parsed;
}

async function main() {
	if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
	if (!INTERNAL_API_TOKEN) throw new Error("INTERNAL_API_TOKEN is required");
	const args = parseArgs(process.argv.slice(2));
	const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
	try {
		const [suite] = await sql<{
			id: string;
			slug: string;
			dataset_name: string;
		}[]>`
			select id, slug, dataset_name
			from benchmark_suites
			where slug = ${args.suite}
			limit 1
		`;
		if (!suite) throw new Error(`Suite not found: ${args.suite}`);
		const rows = args.instanceIds.length
			? await sql<InstanceRow[]>`
				select instance_id, repo, base_commit, test_metadata
				from benchmark_instances
				where suite_id = ${suite.id}
				  and instance_id in ${sql(args.instanceIds)}
				order by instance_id asc
			`
			: await sql<InstanceRow[]>`
				select instance_id, repo, base_commit, test_metadata
				from benchmark_instances
				where suite_id = ${suite.id}
				order by instance_id asc
				limit ${args.limit}
			`;
		if (rows.length === 0) {
			console.log("No benchmark instances matched.");
			return;
		}
		console.log(
			`${args.apply ? "Submitting" : "Dry run"} ${rows.length} ${suite.slug} environment validation request(s) via ${args.apiUrl}`,
		);
		if (!args.forceRefreshLegacyStatic) {
			console.log(
				"Note: legacy static mappings may report validated here but are not necessarily exact launch-ready env-spec hashes. Use --exact-for-random-runs before high-concurrency random benchmark runs.",
			);
		}

		let submitted = 0;
		let readyOrBuilding = 0;
		for (const row of rows) {
			if (!row.repo || !row.base_commit) {
				console.log(`${row.instance_id}\tmissing_metadata`);
				continue;
			}
			if (!args.apply) {
				console.log(`${row.instance_id}\twould_request\t${row.repo}@${row.base_commit.slice(0, 12)}`);
				continue;
			}
			const result = await ensureEnvironment(args.apiUrl, {
				datasetName: suite.dataset_name,
				suiteSlug: suite.slug,
				instanceId: row.instance_id,
				repo: row.repo,
				baseCommit: row.base_commit,
				testMetadata: row.test_metadata ?? {},
				allowBuild: true,
				forceRefreshLegacyStatic: args.forceRefreshLegacyStatic,
			});
			const state = result.environmentStatus || result.status || "unknown";
			if (state === "building" || state === "validated") readyOrBuilding += 1;
			if (result.pipelineRunName || state === "building") submitted += 1;
			console.log([
				row.instance_id,
				state,
				result.environmentKey ?? "",
				result.pipelineRunName ?? "",
				result.reason ?? result.error ?? "",
			].join("\t"));
			if (args.targetValidated && readyOrBuilding >= args.targetValidated) break;
		}
		console.log(`submitted_or_existing_building=${submitted} ready_or_building=${readyOrBuilding}`);
	} finally {
		await sql.end();
	}
}

type InstanceRow = {
	instance_id: string;
	repo: string | null;
	base_commit: string | null;
	test_metadata: Record<string, unknown> | null;
};

type EnsureResult = {
	status?: string;
	environmentStatus?: string;
	environmentKey?: string;
	pipelineRunName?: string;
	reason?: string;
	error?: string;
};

async function ensureEnvironment(
	apiUrl: string,
	body: Record<string, unknown>,
): Promise<EnsureResult> {
	const res = await fetch(`${apiUrl}/api/internal/environments/ensure`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${INTERNAL_API_TOKEN}`,
		},
		body: JSON.stringify(body),
	});
	const payload = (await res.json().catch(() => ({}))) as EnsureResult & {
		message?: string;
	};
	if (!res.ok) {
		throw new Error(payload.message || payload.error || `ensure failed with HTTP ${res.status}`);
	}
	return payload;
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
