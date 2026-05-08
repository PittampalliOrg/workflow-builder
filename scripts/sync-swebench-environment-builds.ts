import postgres from "postgres";

type Args = {
	suite: string | null;
	statuses: string[];
	limit: number;
	apiUrl: string;
};

type BuildRow = {
	id: string;
	suite: string | null;
	environment_key: string;
	env_spec_hash: string;
	pipeline_run_name: string | null;
	status: string;
	validation_status: string | null;
};

type StatusResult = {
	status?: string;
	environmentStatus?: string;
	validationStatus?: string;
	environmentKey?: string;
	pipelineRunName?: string;
	error?: string;
	reason?: string;
};

const DATABASE_URL = process.env.DATABASE_URL;
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;

function usage(exitCode = 2): never {
	console.error([
		"Sync SWE-bench environment image build status from the internal API.",
		"",
		"Usage:",
		"  DATABASE_URL=... INTERNAL_API_TOKEN=... pnpm tsx scripts/sync-swebench-environment-builds.ts --suite SWE-bench_Verified --status building --limit 200",
		"",
		"Options:",
		"  --suite SLUG      Restrict to a suite. Default: SWE-bench_Verified",
		"  --status STATUS   Build status to sync. Repeatable. Default: queued,building",
		"  --limit N         Maximum rows to sync. Default: 200",
		"  --api-url URL     Workflow-builder base URL. Default: WORKFLOW_BUILDER_URL or http://127.0.0.1:3000",
	].join("\n"));
	process.exit(exitCode);
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		suite: "SWE-bench_Verified",
		statuses: [],
		limit: 200,
		apiUrl: process.env.WORKFLOW_BUILDER_URL || "http://127.0.0.1:3000",
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (!value || value.startsWith("--")) usage();
			return value;
		};
		if (arg === "--suite") args.suite = next();
		else if (arg === "--status") args.statuses.push(next());
		else if (arg === "--limit") args.limit = positiveInt(next(), "--limit");
		else if (arg === "--api-url") args.apiUrl = next().replace(/\/+$/, "");
		else if (arg === "--help" || arg === "-h") usage(0);
		else {
			console.error(`Unknown option: ${arg}`);
			usage();
		}
	}
	if (args.statuses.length === 0) args.statuses = ["queued", "building"];
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
		const where = args.suite
			? sql`suite = ${args.suite} and status in ${sql(args.statuses)}`
			: sql`status in ${sql(args.statuses)}`;
		const rows = await sql<BuildRow[]>`
			select
				id,
				suite,
				environment_key,
				env_spec_hash,
				pipeline_run_name,
				status,
				validation_status
			from environment_image_builds
			where ${where}
			order by requested_at asc
			limit ${args.limit}
		`;
		if (rows.length === 0) {
			console.log("No environment image build rows matched.");
			return;
		}
		const counts = new Map<string, number>();
		for (const row of rows) {
			const result = await syncBuild(args.apiUrl, row.id);
			const state = result.environmentStatus || result.status || "unknown";
			counts.set(state, (counts.get(state) ?? 0) + 1);
			console.log([
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
		console.log(`synced=${rows.length} ${summary}`);
	} finally {
		await sql.end();
	}
}

async function syncBuild(apiUrl: string, buildId: string): Promise<StatusResult> {
	const res = await fetch(`${apiUrl}/api/internal/environments/status`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${INTERNAL_API_TOKEN}`,
		},
		body: JSON.stringify({ buildId }),
	});
	const payload = (await res.json().catch(() => ({}))) as StatusResult & {
		message?: string;
	};
	if (!res.ok) {
		throw new Error(payload.message || payload.error || `status failed with HTTP ${res.status}`);
	}
	return payload;
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
