import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;

type Args = {
	apply: boolean;
	executionPrefix: string | null;
	olderThanMinutes: number;
	limit: number;
};

type StaleRun = {
	id: string;
	workflow_execution_id: string;
	dapr_instance_id: string;
	status: string;
	execution_status: string;
	completed_at: Date | null;
};

function parseArgs(argv: string[]): Args {
	const args: Args = {
		apply: false,
		executionPrefix: null,
		olderThanMinutes: 5,
		limit: 100,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--apply") {
			args.apply = true;
		} else if (arg === "--dry-run") {
			args.apply = false;
		} else if (arg === "--execution-prefix") {
			args.executionPrefix = requiredArg(argv, ++i, arg);
		} else if (arg === "--older-than-minutes") {
			args.olderThanMinutes = positiveInteger(requiredArg(argv, ++i, arg), arg);
		} else if (arg === "--limit") {
			args.limit = positiveInteger(requiredArg(argv, ++i, arg), arg);
		} else if (arg === "--help" || arg === "-h") {
			printUsage();
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return args;
}

function printUsage() {
	console.log(
		[
			"Usage:",
			"  DATABASE_URL=... pnpm tsx scripts/reconcile-stale-workflow-agent-runs.ts --dry-run",
			"  DATABASE_URL=... pnpm tsx scripts/reconcile-stale-workflow-agent-runs.ts --execution-prefix sw-swebench-instance-exec- --apply",
			"",
			"Marks scheduled/running workflow_agent_runs as failed when their parent workflow_executions row is already terminal.",
			"",
			"Options:",
			"  --execution-prefix PREFIX    Restrict parent dapr_instance_id/id to this prefix.",
			"  --older-than-minutes N       Only touch parent executions completed at least N minutes ago. Default: 5.",
			"  --limit N                    Maximum stale child rows to reconcile. Default: 100.",
			"  --apply                      Write changes. Default is dry-run.",
			"  --dry-run                    Show selected rows without updating.",
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
	const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
	try {
		const prefixPattern = args.executionPrefix ? `${args.executionPrefix}%` : null;
		const rows = await sql<StaleRun[]>`
			select
				war.id,
				war.workflow_execution_id,
				war.dapr_instance_id,
				war.status,
				we.status as execution_status,
				we.completed_at
			from workflow_agent_runs war
			join workflow_executions we on we.id = war.workflow_execution_id
			where war.status in ('scheduled', 'running')
				and we.status in ('success', 'error', 'cancelled')
				and coalesce(we.completed_at, now()) <= now() - (${args.olderThanMinutes}::int * interval '1 minute')
				and (
					${prefixPattern}::text is null
					or we.dapr_instance_id like ${prefixPattern}
					or we.id like ${prefixPattern}
				)
			order by coalesce(we.completed_at, now()) asc, war.created_at asc
			limit ${args.limit}
		`;

		if (rows.length === 0) {
			console.log("No stale workflow_agent_runs rows matched.");
			return;
		}

		for (const row of rows) {
			console.log(
				[
					row.id,
					row.status,
					row.workflow_execution_id,
					row.dapr_instance_id,
					`parent=${row.execution_status}`,
					row.completed_at?.toISOString() ?? "no-parent-completed-at",
				].join("\t"),
			);
		}

		if (!args.apply) {
			console.log(`Dry-run: ${rows.length} row(s) would be marked failed.`);
			return;
		}

		await sql`
			update workflow_agent_runs
			set
				status = 'failed',
				error = 'Parent workflow execution is already terminal; reconciled stale child run.',
				completed_at = coalesce(completed_at, now()),
				updated_at = now()
			where id in ${sql(rows.map((row) => row.id))}
		`;
		console.log(`Reconciled ${rows.length} stale workflow_agent_runs row(s).`);
	} finally {
		await sql.end({ timeout: 5 });
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exitCode = 1;
});
