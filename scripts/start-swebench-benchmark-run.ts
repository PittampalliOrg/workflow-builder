import { readFileSync } from "node:fs";
import postgres from "postgres";

type Args = {
	suite: string;
	limit: number;
	projectId: string | null;
	userId: string | null;
	userEmail: string | null;
	agentId: string | null;
	agentSlug: string | null;
	agentQuery: string;
	concurrency: number;
	evaluationConcurrency: number;
	timeoutSeconds: number;
	maxTurns: number | null;
	evaluatorResourceClass: string;
	executionBackend: string | null;
	executionClass: string | null;
	tags: string[];
	apiUrl: string;
	apply: boolean;
	prepareEnvironments: boolean;
	targetValidatedCount: number | null;
	validationLimit: number | null;
	waitForValidation: boolean;
	validationTimeoutSeconds: number;
	validationPollSeconds: number;
	strictSelectedCount: boolean;
	instanceIds: string[];
};

const DATABASE_URL = process.env.DATABASE_URL;
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;

function usage(): never {
	console.error([
		"Start an operator SWE-bench benchmark run through the internal benchmark API.",
		"",
		"Usage:",
		"  node scripts/start-swebench-benchmark-run.bundle.js --suite SWE-bench_Verified --limit 24 --concurrency 24 --agent-query kimi --apply",
		"",
		"Options:",
		"  --suite SLUG                 SWE-bench suite slug. Default: SWE-bench_Verified",
		"  --limit N                    Number of exact prevalidated instances to select. Default: 1",
		"  --project-id ID              Project id. Defaults to the selected user's first owned project.",
		"  --user-id ID                 User id. Defaults to project owner.",
		"  --user-email EMAIL           Resolve the project owner by email.",
		"  --agent-id ID                Agent id to run.",
		"  --agent-slug SLUG            Agent slug to run.",
		"  --agent-query TEXT           Pick first registered agent whose slug/name/model contains this text. Default: kimi",
		"  --concurrency N              Inference concurrency request. Default: 1",
		"  --evaluation-concurrency N   Evaluator parallelism request. Default: 24",
		"  --timeout-seconds N          Per-instance timeout. Default: 7200",
		"  --max-turns N                Maximum agent turns per instance. Omit for agent default.",
		"  --evaluator-resource-class C Evaluator resource class. Default: standard",
		"  --execution-backend NAME     host-execution. Legacy values are accepted only for rollback tests.",
		"  --execution-class NAME       benchmark-fast or secure-gvisor.",
		"  --tag TAG                    Extra run tag. Repeatable.",
		"  --instance-id ID             Explicit instance id. Repeatable.",
		"  --instance-ids IDS           Comma/newline/space-separated explicit ids.",
		"  --instance-ids-file PATH     File containing comma/newline/space-separated explicit ids.",
		"  --prepare-environments       Submit exact environment validation builds before launch.",
		"  --target-validated-count N   Exact-ready target for preparation. Defaults to --limit.",
		"  --validation-limit N         Max instances to inspect/submit during preparation. Defaults to target/limit.",
		"  --wait-for-validation        Poll until target exact-ready count is reached or timeout.",
		"  --validation-timeout-seconds N  Validation wait timeout. Default: 3600",
		"  --validation-poll-seconds N  Validation wait poll interval. Default: 30",
		"  --strict-selected-count      Refuse --apply if selectedCount is below --limit. Default for --apply.",
		"  --allow-partial-selection    Permit creating a smaller run than --limit.",
		"  --api-url URL                Workflow-builder base URL. Default: WORKFLOW_BUILDER_URL or http://127.0.0.1:3000",
		"  --apply                      Actually create the run. Omit to preview exact selected instances.",
	].join("\n"));
	process.exit(2);
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		suite: "SWE-bench_Verified",
		limit: 1,
		projectId: null,
		userId: null,
		userEmail: null,
		agentId: null,
		agentSlug: null,
		agentQuery: "kimi",
		concurrency: 1,
		evaluationConcurrency: 24,
		timeoutSeconds: 7200,
		maxTurns: null,
		evaluatorResourceClass: "standard",
		executionBackend: "host-execution",
		executionClass: null,
		tags: ["operator-concurrency"],
		apiUrl: process.env.WORKFLOW_BUILDER_URL || "http://127.0.0.1:3000",
		apply: false,
		prepareEnvironments: false,
		targetValidatedCount: null,
		validationLimit: null,
		waitForValidation: false,
		validationTimeoutSeconds: 3600,
		validationPollSeconds: 30,
		strictSelectedCount: true,
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
		else if (arg === "--project-id") args.projectId = next();
		else if (arg === "--user-id") args.userId = next();
		else if (arg === "--user-email") args.userEmail = next();
		else if (arg === "--agent-id") args.agentId = next();
		else if (arg === "--agent-slug") args.agentSlug = next();
		else if (arg === "--agent-query") args.agentQuery = next();
		else if (arg === "--concurrency") {
			args.concurrency = positiveInt(next(), "--concurrency");
		} else if (arg === "--evaluation-concurrency") {
			args.evaluationConcurrency = positiveInt(next(), "--evaluation-concurrency");
		} else if (arg === "--timeout-seconds") {
			args.timeoutSeconds = positiveInt(next(), "--timeout-seconds");
		} else if (arg === "--max-turns") {
			args.maxTurns = positiveInt(next(), "--max-turns");
		} else if (arg === "--evaluator-resource-class") {
			args.evaluatorResourceClass = next();
		} else if (arg === "--execution-backend") {
			args.executionBackend = next();
		} else if (arg === "--execution-class") {
			args.executionClass = next();
		} else if (arg === "--tag") {
			args.tags.push(next());
		} else if (arg === "--instance-id") {
			args.instanceIds.push(next());
		} else if (arg === "--instance-ids") {
			args.instanceIds.push(...parseInstanceIds(next()));
		} else if (arg === "--instance-ids-file") {
			args.instanceIds.push(...parseInstanceIds(readFileSync(next(), "utf8")));
		} else if (arg === "--prepare-environments") {
			args.prepareEnvironments = true;
		} else if (arg === "--target-validated-count") {
			args.targetValidatedCount = positiveInt(next(), "--target-validated-count");
		} else if (arg === "--validation-limit") {
			args.validationLimit = positiveInt(next(), "--validation-limit");
		} else if (arg === "--wait-for-validation") {
			args.waitForValidation = true;
		} else if (arg === "--validation-timeout-seconds") {
			args.validationTimeoutSeconds = positiveInt(next(), "--validation-timeout-seconds");
		} else if (arg === "--validation-poll-seconds") {
			args.validationPollSeconds = positiveInt(next(), "--validation-poll-seconds");
		} else if (arg === "--strict-selected-count") {
			args.strictSelectedCount = true;
		} else if (arg === "--allow-partial-selection" || arg === "--no-strict-selected-count") {
			args.strictSelectedCount = false;
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

function parseInstanceIds(value: string): string[] {
	return Array.from(
		new Set(
			value
				.split(/[\n,\s]+/g)
				.map((item) => item.trim().replace(/^["']|["']$/g, ""))
				.filter(Boolean),
		),
	);
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
		const project = await resolveProject(sql, args);
		const agent = await resolveAgent(sql, args, project.project_id);
		const body = {
			projectId: project.project_id,
			userId: args.userId ?? project.user_id,
			suiteSlug: args.suite,
			agentId: args.agentId ?? agent.id,
			agentSlug: args.agentSlug,
			limit: args.limit,
			concurrency: args.concurrency,
			evaluationConcurrency: args.evaluationConcurrency,
			timeoutSeconds: args.timeoutSeconds,
			maxTurns: args.maxTurns,
			evaluatorResourceClass: args.evaluatorResourceClass,
			executionBackend: args.executionBackend ?? "host-execution",
			executionClass: args.executionClass,
			tags: args.tags,
			instanceIds: args.instanceIds,
			allowPartialSelection: !args.strictSelectedCount,
		};
		console.log(
			`${args.apply ? "Creating" : "Previewing"} SWE-bench run: project=${body.projectId} user=${body.userId} agent=${body.agentId} limit=${args.limit} concurrency=${args.concurrency} maxTurns=${args.maxTurns ?? "default"} backend=${args.executionBackend ?? "default"}`,
		);
		let preview = await submitRun(args.apiUrl, {
			...body,
			previewOnly: true,
		});
		console.log(JSON.stringify(preview, null, 2));
		if (args.prepareEnvironments) {
			const target = args.targetValidatedCount ?? args.limit;
			const validationLimit = args.validationLimit ?? Math.max(target, args.limit);
			console.log(
				`Preparing exact SWE-bench environments: target=${target} validationLimit=${validationLimit}`,
			);
			const prepared = await submitEnvironmentValidation(args.apiUrl, {
				suiteSlug: args.suite,
				targetValidatedCount: target,
				limit: validationLimit,
				instanceIds: args.instanceIds,
				allowBuild: true,
			});
			console.log(JSON.stringify(prepared, null, 2));
			if (args.waitForValidation) {
				await waitForValidation(args.apiUrl, {
					suiteSlug: args.suite,
					targetValidatedCount: target,
					limit: validationLimit,
					instanceIds: args.instanceIds,
					timeoutSeconds: args.validationTimeoutSeconds,
					pollSeconds: args.validationPollSeconds,
				});
			}
			preview = await submitRun(args.apiUrl, {
				...body,
				previewOnly: true,
			});
			console.log(JSON.stringify(preview, null, 2));
		}
		const selectedCount = readNumber(preview.selectedCount);
		const requestedLimit = readNumber(preview.requestedLimit) ?? args.limit;
		if (
			args.apply &&
			args.strictSelectedCount &&
			selectedCount != null &&
			selectedCount < requestedLimit
		) {
			throw new Error(
				`Refusing to create partial run: selectedCount=${selectedCount} requestedLimit=${requestedLimit}`,
			);
		}
		if (!args.apply) return;
		const result = await submitRun(args.apiUrl, {
			...body,
			previewOnly: false,
		});
		console.log(JSON.stringify(result, null, 2));
	} finally {
		await sql.end();
	}
}

type Sql = postgres.Sql<Record<string, postgres.PostgresType>>;

async function resolveProject(sql: Sql, args: Args) {
	if (args.projectId) {
		const [row] = await sql<ProjectRow[]>`
			select p.id as project_id, p.owner_id as user_id
			from projects p
			where p.id = ${args.projectId}
			limit 1
		`;
		if (!row) throw new Error(`Project not found: ${args.projectId}`);
		return row;
	}
	const rows = args.userEmail
		? await sql<ProjectRow[]>`
			select p.id as project_id, p.owner_id as user_id
			from projects p
			join users u on u.id = p.owner_id
			where lower(u.email) = lower(${args.userEmail})
			order by p.created_at asc
			limit 1
		`
		: await sql<ProjectRow[]>`
			select p.id as project_id, p.owner_id as user_id
			from projects p
			order by p.created_at asc
			limit 1
		`;
	const [row] = rows;
	if (!row) throw new Error("No project found");
	return row;
}

async function resolveAgent(sql: Sql, args: Args, projectId: string) {
	if (args.agentId) {
		const [row] = await sql<AgentRow[]>`
			select id, slug, name
			from agents
			where id = ${args.agentId}
			limit 1
		`;
		if (!row) throw new Error(`Agent not found: ${args.agentId}`);
		return row;
	}
	if (args.agentSlug) {
		const [row] = await sql<AgentRow[]>`
			select id, slug, name
			from agents
			where project_id = ${projectId}
			  and slug = ${args.agentSlug}
			  and runtime in ('dapr-agent-py', 'adk-agent-py', 'claude-agent-py')
			  and registry_status = 'registered'
			  and is_archived = false
			limit 1
		`;
		if (!row) throw new Error(`Agent not found: ${args.agentSlug}`);
		return row;
	}
	const query = `%${args.agentQuery.toLowerCase()}%`;
	const [row] = await sql<AgentRow[]>`
		select a.id, a.slug, a.name
		from agents a
		left join agent_versions av on av.id = a.current_version_id
			where a.project_id = ${projectId}
			  and a.runtime in ('dapr-agent-py', 'adk-agent-py', 'claude-agent-py')
		  and a.registry_status = 'registered'
		  and a.is_archived = false
		  and not (a.tags @> '["workflow-ephemeral"]'::jsonb)
		  and (
			lower(a.slug) like ${query}
			or lower(a.name) like ${query}
			or lower(coalesce(av.config::text, '')) like ${query}
		  )
		order by a.updated_at desc
		limit 1
	`;
	if (!row) throw new Error(`No registered benchmark agent matched query: ${args.agentQuery}`);
	return row;
}

type ProjectRow = {
	project_id: string;
	user_id: string;
};

type AgentRow = {
	id: string;
	slug: string;
	name: string;
};

async function submitRun(
	apiUrl: string,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const res = await fetch(`${apiUrl}/api/internal/benchmarks/runs`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${INTERNAL_API_TOKEN}`,
		},
		body: JSON.stringify(body),
	});
	const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok) {
		throw new Error(
			typeof payload.message === "string"
				? payload.message
				: typeof payload.error === "string"
					? payload.error
					: `create run failed with HTTP ${res.status}`,
		);
	}
	return payload;
}

type ValidationRequest = {
	suiteSlug: string;
	targetValidatedCount: number;
	limit: number;
	instanceIds: string[];
	allowBuild: boolean;
};

async function submitEnvironmentValidation(
	apiUrl: string,
	body: ValidationRequest,
): Promise<Record<string, unknown>> {
	const res = await fetch(`${apiUrl}/api/internal/benchmarks/environments/validate`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${INTERNAL_API_TOKEN}`,
		},
		body: JSON.stringify(body),
	});
	const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok) {
		throw new Error(
			typeof payload.message === "string"
				? payload.message
				: typeof payload.error === "string"
					? payload.error
					: `environment validation failed with HTTP ${res.status}`,
		);
	}
	return payload;
}

async function waitForValidation(
	apiUrl: string,
	input: {
		suiteSlug: string;
		targetValidatedCount: number;
		limit: number;
		instanceIds: string[];
		timeoutSeconds: number;
		pollSeconds: number;
	},
) {
	const deadline = Date.now() + input.timeoutSeconds * 1000;
	while (true) {
		const status = await submitEnvironmentValidation(apiUrl, {
			suiteSlug: input.suiteSlug,
			targetValidatedCount: input.targetValidatedCount,
			limit: input.limit,
			instanceIds: input.instanceIds,
			allowBuild: true,
		});
		const coverage = isRecord(status.coverage) ? status.coverage : {};
		const validated = Array.isArray(status.nextExactReadyInstanceIds)
			? status.nextExactReadyInstanceIds.length
			: readNumber(coverage.validated) ?? 0;
		console.log(
			`validation_ready=${validated}/${input.targetValidatedCount} building=${readNumber(coverage.building) ?? 0} submitted=${readNumber(status.submitted) ?? 0}`,
		);
		if (validated >= input.targetValidatedCount) return;
		if (Date.now() >= deadline) {
			throw new Error(
				`Timed out waiting for ${input.targetValidatedCount} exact validated environments; ready=${validated}`,
			);
		}
		await sleep(input.pollSeconds * 1000);
	}
}

function readNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
