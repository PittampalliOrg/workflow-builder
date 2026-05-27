import postgres from "postgres";

type Args = {
	suite: string;
	limit: number;
	targetValidated: number | null;
	maxSubmissionsPerPass: number | null;
	forceRefreshLegacyStatic: boolean;
	apply: boolean;
	apiUrl: string;
	instanceIds: string[];
	loop: boolean;
	pollSeconds: number;
	maxPasses: number | null;
	syncActiveBeforePass: boolean;
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
		"  --max-submissions-per-pass N  Submit at most N new/active builds per pass.",
		"  --loop                  Keep syncing/submitting until target is reached.",
		"  --poll-seconds N        Sleep between loop passes. Default: 300",
		"  --max-passes N          Stop after N loop passes.",
		"  --no-sync-active-before-pass  Do not sync queued/building rows before each loop pass.",
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
		maxSubmissionsPerPass: null,
		forceRefreshLegacyStatic: false,
		apply: false,
		apiUrl: process.env.WORKFLOW_BUILDER_URL || "http://127.0.0.1:3000",
		instanceIds: [],
		loop: false,
		pollSeconds: 300,
		maxPasses: null,
		syncActiveBeforePass: true,
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
		} else if (arg === "--max-submissions-per-pass") {
			args.maxSubmissionsPerPass = positiveInt(next(), "--max-submissions-per-pass");
		} else if (arg === "--instance-id") {
			args.instanceIds.push(next());
		} else if (arg === "--loop") {
			args.loop = true;
		} else if (arg === "--poll-seconds") {
			args.pollSeconds = positiveInt(next(), "--poll-seconds");
		} else if (arg === "--max-passes") {
			args.maxPasses = positiveInt(next(), "--max-passes");
		} else if (arg === "--no-sync-active-before-pass") {
			args.syncActiveBeforePass = false;
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
		let pass = 0;
		for (;;) {
			pass += 1;
			if (args.apply && args.syncActiveBeforePass) {
				await syncActiveBuilds(sql, args);
			}
			const result = await runPass(sql, args, suite, pass);
			if (!args.loop || !args.apply) break;
			if (args.targetValidated && result.readyOrBuilding >= args.targetValidated) break;
			if (args.maxPasses && pass >= args.maxPasses) {
				console.log(`max_passes_reached=${args.maxPasses}`);
				break;
			}
			console.log(`sleeping_seconds=${args.pollSeconds}`);
			await sleep(args.pollSeconds * 1000);
		}
	} finally {
		await sql.end();
	}
}

async function runPass(
	sql: postgres.Sql,
	args: Args,
	suite: { id: string; slug: string; dataset_name: string },
	pass: number,
) {
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
		return { submitted: 0, readyOrBuilding: 0 };
	}
	console.log(
		`${args.apply ? "Submitting" : "Dry run"} pass=${pass} ${rows.length} ${suite.slug} environment validation request(s) via ${args.apiUrl}`,
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
		if (
			args.maxSubmissionsPerPass &&
			submitted >= args.maxSubmissionsPerPass
		) {
			console.log(`max_submissions_per_pass_reached=${args.maxSubmissionsPerPass}`);
			break;
		}
		if (isCapacityExhausted(result)) {
			console.log("capacity_exhausted=true");
			break;
		}
	}
	console.log(`submitted_or_existing_building=${submitted} ready_or_building=${readyOrBuilding}`);
	return { submitted, readyOrBuilding };
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

type ActiveBuildRow = {
	id: string;
	environment_key: string;
	status: string;
	pipeline_run_name: string | null;
};

async function syncActiveBuilds(sql: postgres.Sql, args: Args) {
	const rows = await sql<ActiveBuildRow[]>`
		select id, environment_key, status, pipeline_run_name
		from environment_image_builds
		where suite = ${args.suite}
		  and status in ('queued', 'building')
		order by requested_at asc
		limit 200
	`;
	if (rows.length === 0) return;
	const counts = new Map<string, number>();
	for (const row of rows) {
		const result = await syncBuild(args.apiUrl, row.id);
		const state = result.environmentStatus || result.status || "unknown";
		counts.set(state, (counts.get(state) ?? 0) + 1);
		console.log([
			"sync",
			row.id,
			row.environment_key,
			row.status,
			"->",
			state,
			result.pipelineRunName ?? row.pipeline_run_name ?? "",
			result.reason ?? result.error ?? "",
		].join("\t"));
	}
	const summary = Array.from(counts.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([status, count]) => `${status}=${count}`)
		.join(" ");
	console.log(`synced_active=${rows.length} ${summary}`);
}

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

async function syncBuild(apiUrl: string, buildId: string): Promise<EnsureResult> {
	const res = await fetch(`${apiUrl}/api/internal/environments/status`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${INTERNAL_API_TOKEN}`,
		},
		body: JSON.stringify({ buildId }),
	});
	const payload = (await res.json().catch(() => ({}))) as EnsureResult & {
		message?: string;
	};
	if (!res.ok) {
		throw new Error(payload.message || payload.error || `status failed with HTTP ${res.status}`);
	}
	return payload;
}

function isCapacityExhausted(result: EnsureResult): boolean {
	const text = [result.reason, result.error, result.status, result.environmentStatus]
		.filter(Boolean)
		.join(" ");
	return /dynamic_build_capacity_exhausted|capacity_exhausted|capacity/i.test(text);
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
