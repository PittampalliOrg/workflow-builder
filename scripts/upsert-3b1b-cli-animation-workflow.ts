/**
 * Upsert a CLI-agent variant of the "3Blue1Brown-style Animation" workflow.
 *
 * The regular workflow has a single static durable/run agentRef. This variant
 * exposes runtime selection with one durable/run node whose agentRef.slug is
 * resolved from the validated `cliRuntime` trigger input before dispatch.
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm exec tsx scripts/upsert-3b1b-cli-animation-workflow.ts
 *   DATABASE_URL=postgres://... pnpm exec tsx scripts/upsert-3b1b-cli-animation-workflow.ts \
 *     --workflow-id three-b-one-b-skill-animation-cli \
 *     --default-runtime codex-cli
 */

import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;

type JsonRecord = Record<string, unknown>;
type CliRuntime = "codex-cli" | "claude-code-cli" | "agy-cli";

interface CliRuntimeDescriptor {
	runtime: CliRuntime;
	canonicalSlug: string;
	label: string;
}

interface AgentRef {
	id: string;
	version: number;
	name: string;
	slug: string;
	runtime: CliRuntime;
}

interface ParsedArgs {
	sourceWorkflowId: string;
	workflowId: string;
	workflowName: string;
	workflowDescription: string;
	userEmail: string;
	defaultRuntime: CliRuntime;
	agentOverrides: Partial<Record<CliRuntime, { id: string; version?: number }>>;
}

const SOURCE_WORKFLOW_ID = "three-b-one-b-skill-animation";
const TARGET_WORKFLOW_ID = "three-b-one-b-skill-animation-cli";
const TARGET_WORKFLOW_NAME = "3Blue1Brown-style Animation (CLI agents)";
const TARGET_WORKFLOW_DESCRIPTION =
	"Generate a self-contained browser animation in the 3Blue1Brown style using a runtime-selected CLI agent, then verify, capture, and preview the copied app files from the retained workspace.";
const APP_DIR = "/sandbox/3b1b-style-animation-example";

const CLI_RUNTIMES: readonly CliRuntimeDescriptor[] = [
	{
		runtime: "codex-cli",
		canonicalSlug: "codex-cli",
		label: "Codex CLI",
	},
	{
		runtime: "claude-code-cli",
		canonicalSlug: "claude-code-cli",
		label: "Claude Code CLI",
	},
	{
		runtime: "agy-cli",
		canonicalSlug: "agy-cli",
		label: "Antigravity CLI",
	},
];

const CLI_RUNTIME_OPTIONS = CLI_RUNTIMES.map((item) => ({
	label: item.label,
	value: item.runtime,
}));

const SELECTED_BUILD_OUTPUT = "${ .build_3b1b_animation }";
const SELECTED_BUILD_RUNTIME_SANDBOX_NAME =
	"${ .build_3b1b_animation.runtimeSandboxName // null }";
const SELECTED_BUILD_WORKSPACE_REF =
	"${ .build_3b1b_animation.workspaceRef // .workspace_profile.workspaceRef // null }";

const WORKSPACE_SANDBOX_NAME = '${ .workspace_profile.sandboxName // "" }';
const WORKSPACE_REF = "${ .workspace_profile.workspaceRef }";

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function cliRuntime(value: string): CliRuntime {
	if (value === "codex-cli" || value === "claude-code-cli" || value === "agy-cli") {
		return value;
	}
	throw new Error(
		`Invalid CLI runtime "${value}". Expected codex-cli, claude-code-cli, or agy-cli.`,
	);
}

function parseOptionalVersion(value: string, flag: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${flag} must be a positive integer; got ${value}`);
	}
	return parsed;
}

function parseArgs(argv: string[]): ParsedArgs {
	const args: ParsedArgs = {
		sourceWorkflowId: process.env.SOURCE_WORKFLOW_ID || SOURCE_WORKFLOW_ID,
		workflowId: process.env.WORKFLOW_ID || TARGET_WORKFLOW_ID,
		workflowName: process.env.WORKFLOW_NAME || TARGET_WORKFLOW_NAME,
		workflowDescription:
			process.env.WORKFLOW_DESCRIPTION || TARGET_WORKFLOW_DESCRIPTION,
		userEmail: process.env.USER_EMAIL || "",
		defaultRuntime: cliRuntime(process.env.DEFAULT_CLI_RUNTIME || "codex-cli"),
		agentOverrides: {},
	};

	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		const next = () => {
			const value = argv[i + 1];
			if (!value) throw new Error(`${flag} requires a value`);
			i += 1;
			return value.trim();
		};

		switch (flag) {
			case "--source-workflow-id":
				args.sourceWorkflowId = next();
				break;
			case "--workflow-id":
				args.workflowId = next();
				break;
			case "--workflow-name":
				args.workflowName = next();
				break;
			case "--workflow-description":
				args.workflowDescription = next();
				break;
			case "--user-email":
				args.userEmail = next();
				break;
			case "--default-runtime":
				args.defaultRuntime = cliRuntime(next());
				break;
			case "--codex-agent-id":
				args.agentOverrides["codex-cli"] = {
					...(args.agentOverrides["codex-cli"] ?? {}),
					id: next(),
				};
				break;
			case "--codex-agent-version":
				args.agentOverrides["codex-cli"] = {
					...(args.agentOverrides["codex-cli"] ?? { id: "" }),
					version: parseOptionalVersion(next(), flag),
				};
				break;
			case "--claude-agent-id":
				args.agentOverrides["claude-code-cli"] = {
					...(args.agentOverrides["claude-code-cli"] ?? {}),
					id: next(),
				};
				break;
			case "--claude-agent-version":
				args.agentOverrides["claude-code-cli"] = {
					...(args.agentOverrides["claude-code-cli"] ?? { id: "" }),
					version: parseOptionalVersion(next(), flag),
				};
				break;
			case "--agy-agent-id":
				args.agentOverrides["agy-cli"] = {
					...(args.agentOverrides["agy-cli"] ?? {}),
					id: next(),
				};
				break;
			case "--agy-agent-version":
				args.agentOverrides["agy-cli"] = {
					...(args.agentOverrides["agy-cli"] ?? { id: "" }),
					version: parseOptionalVersion(next(), flag),
				};
				break;
			default:
				throw new Error(`Unknown argument: ${flag}`);
		}
	}

	for (const [runtime, override] of Object.entries(args.agentOverrides)) {
		if (override.version !== undefined && !override.id) {
			throw new Error(`--${runtime}-agent-version requires the matching --agent-id flag`);
		}
	}

	return args;
}

function ensureRecord(parent: JsonRecord, key: string): JsonRecord {
	const current = parent[key];
	if (isRecord(current)) return current;
	const next: JsonRecord = {};
	parent[key] = next;
	return next;
}

function normalizeSandboxTemplateDefaults(value: unknown): unknown {
	if (typeof value === "string") {
		return /^\$\{\s*\.trigger\.sandboxTemplate\s*\/\/\s*"dapr-agent"\s*\}$/.test(
			value,
		)
			? "dapr-agent"
			: value;
	}
	if (Array.isArray(value)) {
		return value.map((item) => normalizeSandboxTemplateDefaults(item));
	}
	if (isRecord(value)) {
		for (const [key, child] of Object.entries(value)) {
			value[key] = normalizeSandboxTemplateDefaults(child);
		}
	}
	return value;
}

async function resolveOwner(
	sql: postgres.Sql,
	existingTarget: postgres.Row | undefined,
	sourceWorkflow: postgres.Row,
	userEmail: string,
): Promise<{ userId: string; projectId: string | null }> {
	if (existingTarget?.user_id) {
		return {
			userId: String(existingTarget.user_id),
			projectId: existingTarget.project_id ? String(existingTarget.project_id) : null,
		};
	}
	if (userEmail) {
		const rows = await sql`
			select u.id as user_id, pm.project_id
			from users u
			left join project_members pm on pm.user_id = u.id
			where lower(u.email) = lower(${userEmail})
			order by pm.created_at asc nulls last
			limit 1
		`;
		if (rows[0]?.user_id) {
			return {
				userId: String(rows[0].user_id),
				projectId: rows[0].project_id ? String(rows[0].project_id) : null,
			};
		}
	}
	if (sourceWorkflow.user_id) {
		return {
			userId: String(sourceWorkflow.user_id),
			projectId: sourceWorkflow.project_id ? String(sourceWorkflow.project_id) : null,
		};
	}

	const memberRows = await sql`
		select pm.user_id, pm.project_id
		from project_members pm
		order by pm.created_at asc
		limit 1
	`;
	if (memberRows[0]?.user_id) {
		return {
			userId: String(memberRows[0].user_id),
			projectId: memberRows[0].project_id ? String(memberRows[0].project_id) : null,
		};
	}
	throw new Error("Could not resolve a workflow owner.");
}

async function resolveCliAgent(
	sql: postgres.Sql,
	descriptor: CliRuntimeDescriptor,
	override?: { id: string; version?: number },
): Promise<AgentRef> {
	if (override?.id) {
		const rows =
			override.version !== undefined
				? await sql`
					select a.id, a.slug, a.name, a.runtime, av.version
					from agents a
					join agent_versions av on av.agent_id = a.id and av.version = ${override.version}
					where a.id = ${override.id}
					limit 1
				`
				: await sql`
					select a.id, a.slug, a.name, a.runtime, av.version
					from agents a
					join agent_versions av on av.id = a.current_version_id
					where a.id = ${override.id}
					limit 1
				`;
		const row = rows[0];
		if (!row) {
			throw new Error(`Could not resolve override agent ${override.id}`);
		}
		if (row.runtime !== descriptor.runtime) {
			throw new Error(
				`Agent ${override.id} has runtime ${row.runtime}; expected ${descriptor.runtime}`,
			);
		}
		return {
			id: String(row.id),
			slug: String(row.slug),
			name: String(row.name),
			runtime: descriptor.runtime,
			version: Number(row.version),
		};
	}

	const rows = await sql`
		select a.id, a.slug, a.name, a.runtime, av.version
		from agents a
		join agent_versions av on av.id = a.current_version_id
		where a.runtime = ${descriptor.runtime}
			and a.is_archived = false
			and a.is_enabled = true
			and a.current_version_id is not null
		order by
			case when a.slug = ${descriptor.canonicalSlug} then 0 else 1 end,
			a.updated_at desc
		limit 1
	`;
	const row = rows[0];
	if (!row) {
		throw new Error(
			`No enabled, unarchived CLI agent found for runtime ${descriptor.runtime}`,
		);
	}
	return {
		id: String(row.id),
		slug: String(row.slug),
		name: String(row.name),
		runtime: descriptor.runtime,
		version: Number(row.version),
	};
}

function makeParameterizedBuildTask(
	baseTask: JsonRecord,
): JsonRecord {
	const task = cloneJson(baseTask);
	delete task.if;

	const withBlock = ensureRecord(task, "with");
	withBlock.outputSync = {
		workspaceRef: WORKSPACE_REF,
		paths: [
			{
				source: APP_DIR,
				target: APP_DIR,
			},
		],
		timeoutSeconds: 120,
	};
	const body = ensureRecord(withBlock, "body");
	body.agentRef = {
		slug: "${ .trigger.cliRuntime }",
	};

	return task;
}

function makeWorkspaceVerifyTask(): JsonRecord {
	return {
		call: "workspace/command",
		with: {
			workspaceRef: WORKSPACE_REF,
			cwd: "/sandbox",
			timeoutMs: 120000,
			command: [
				"set -eu",
				`app=${JSON.stringify(APP_DIR)}`,
				'test -f "$app/index.html"',
				'test -f "$app/styles.css"',
				'test -f "$app/script.js"',
				'test -f "$app/README.md"',
				'node --check "$app/script.js"',
				'grep -q "id=\\"canvas\\"" "$app/index.html"',
				'grep -q "id=\\"btn-play\\"" "$app/index.html"',
				'grep -q "id=\\"btn-restart\\"" "$app/index.html"',
				'find "$app" -maxdepth 1 -type f -printf "%f %s bytes\\n" | sort',
			].join("\n"),
		},
	};
}

function makeBrowserValidateTask(): JsonRecord {
	return {
		call: "browser/validate",
		with: {
			workspaceRef: WORKSPACE_REF,
			sandboxName: WORKSPACE_SANDBOX_NAME,
			repoPath: APP_DIR,
			rootPath: "/sandbox",
			workingDir: "/sandbox",
			installCommand: "",
			baseUrl: "http://127.0.0.1:0",
			steps: [
				{
					id: "initial",
					label: "Animation loaded",
					action: "visit",
					path: "/",
					goal: "Initial render of the canvas before any interaction.",
					waitForSelector: "canvas#canvas",
					pauseMs: 1500,
					fullPage: true,
				},
				{
					id: "after-play",
					label: "After play",
					action: "click",
					selector: "button#btn-play",
					goal: "Trigger the play control once.",
					waitForSelector: "canvas#canvas",
					pauseMs: 2000,
					fullPage: true,
				},
				{
					id: "after-second-play",
					label: "After second play",
					action: "click",
					selector: "button#btn-play",
					goal: "Trigger the play control again to capture mid-animation state.",
					waitForSelector: "canvas#canvas",
					pauseMs: 1500,
					fullPage: true,
				},
				{
					id: "after-restart",
					label: "After restart",
					action: "click",
					selector: "button#btn-restart",
					goal: "Restart the animation and capture the reset state.",
					waitForSelector: "canvas#canvas",
					pauseMs: 1500,
					fullPage: true,
				},
			],
			captureVideo: true,
			captureTrace: true,
			viewportPreset: "desktop",
			captureMode: "demo",
			demoTitle:
				'${ "3Blue1Brown-style animation: " + .trigger.animationDescription }',
			demoSummary:
				"Generated 3Blue1Brown-style browser animation from a CLI-agent run; browser/validate captured initial / play / second play / restart states from the retained workspace.",
			metadata: {
				appPath: APP_DIR,
				workflowStage: "post-cli-3b1b-animation",
				runtimeSandboxName: SELECTED_BUILD_RUNTIME_SANDBOX_NAME,
				selectedCliRuntime: "${ .trigger.cliRuntime }",
			},
			timeoutMs: 900000,
		},
	};
}

function makeStartPreviewTask(): JsonRecord {
	return {
		call: "browser/start-preview",
		with: {
			body: {
				input: {
					previewId:
						'${ "3b1b-cli-animation-preview-" + (.runtime.dbExecutionId // .workspace_profile.workspaceRef) }',
					repoPath: APP_DIR,
					rootPath: "/sandbox",
					workingDir: "/sandbox",
					baseUrl: "http://127.0.0.1:0",
					keepAlive: true,
					timeoutSeconds: 7200,
					timeoutMs: 7200000,
					sandboxName: WORKSPACE_SANDBOX_NAME,
					workspaceRef: WORKSPACE_REF,
					installCommand: "",
					devServerCommand: "",
				},
			},
		},
	};
}

function addRuntimeInput(spec: JsonRecord, defaultRuntime: CliRuntime): void {
	const document = ensureRecord(spec, "document");
	document.name = TARGET_WORKFLOW_ID;
	document.title = TARGET_WORKFLOW_NAME;
	document.summary = TARGET_WORKFLOW_DESCRIPTION;

	const wb = ensureRecord(document, "x-workflow-builder");
	wb.architecture =
		"per-agent-runtime+cli-runtime-selector+session-workflow-bridge+browser-validate-capture+live-preview";
	const previousNotes = typeof wb.notes === "string" ? wb.notes : "";
	wb.notes = [
		previousNotes,
		"CLI variant: exposes cliRuntime at launch time and resolves one durable/run agentRef.slug from the validated trigger input before dispatch.",
	]
		.filter(Boolean)
		.join(" ");

	const triggerInputs = ensureRecord(wb, "triggerInputs");
	triggerInputs.cliRuntime =
		"Optional. Selects the CLI agent runtime: codex-cli, claude-code-cli, or agy-cli.";
	delete triggerInputs.sandboxTemplate;

	const inputConfig = ensureRecord(wb, "input");
	const fields = ensureRecord(inputConfig, "fields");
	delete fields.sandboxTemplate;
	inputConfig.fields = {
		cliRuntime: {
			type: "select",
			label: "CLI agent",
			description: "Choose which CLI agent builds the animation.",
			defaultValue: defaultRuntime,
			options: CLI_RUNTIME_OPTIONS,
		},
		...fields,
	};

	const input = ensureRecord(spec, "input");
	const schema = ensureRecord(input, "schema");
	const schemaDocument = ensureRecord(schema, "document");
	const properties = isRecord(schemaDocument.properties)
		? schemaDocument.properties
		: {};
	schemaDocument.properties = {
		cliRuntime: {
			type: "string",
			title: "CLI agent",
			description: "Selects the CLI agent runtime for the build step.",
			enum: CLI_RUNTIMES.map((item) => item.runtime),
			default: defaultRuntime,
		},
		...properties,
	};
	if (isRecord(schemaDocument.properties)) {
		delete schemaDocument.properties.sandboxTemplate;
	}
	if (Array.isArray(schemaDocument.required)) {
		schemaDocument.required = schemaDocument.required.filter(
			(item) => item !== "cliRuntime" && item !== "sandboxTemplate",
		);
	}
}

function replaceBuildTasks(
	spec: JsonRecord,
): void {
	if (!Array.isArray(spec.do)) {
		throw new Error("Source workflow spec.do must be an array");
	}
	const doArray = spec.do as unknown[];
	const buildIndex = doArray.findIndex(
		(entry) => isRecord(entry) && isRecord(entry.build_3b1b_animation),
	);
	if (buildIndex < 0) {
		throw new Error("Source workflow has no build_3b1b_animation task");
	}
	const baseTask = (doArray[buildIndex] as JsonRecord)
		.build_3b1b_animation as JsonRecord;
	const buildTask = makeParameterizedBuildTask(baseTask);
	doArray.splice(buildIndex, 1, { build_3b1b_animation: buildTask });

	for (let index = doArray.length - 1; index >= 0; index -= 1) {
		const entry = doArray[index];
		if (
			isRecord(entry) &&
			(isRecord(entry.browser_validate_capture) || isRecord(entry.start_preview))
		) {
			doArray.splice(index, 1);
		}
	}
	doArray.splice(
		buildIndex + 1,
		0,
		{ verify_copied_animation: makeWorkspaceVerifyTask() },
		{ browser_validate_capture: makeBrowserValidateTask() },
		{ start_preview: makeStartPreviewTask() },
	);

	const output = ensureRecord(spec, "output");
	const outputAs = ensureRecord(output, "as");
	outputAs.workspaceRef = WORKSPACE_REF;
	outputAs.sandboxName = WORKSPACE_SANDBOX_NAME;
	outputAs.runtimeSandboxName = SELECTED_BUILD_RUNTIME_SANDBOX_NAME;
	outputAs.selectedCliRuntime = "${ .trigger.cliRuntime }";
	outputAs.animation = SELECTED_BUILD_OUTPUT;
	outputAs.verification = "${ .verify_copied_animation }";
	outputAs.screenshots = "${ .browser_validate_capture }";
	outputAs.preview = "${ .start_preview }";
}

function buildNodes(): JsonRecord[] {
	return [
		{
			id: "trigger",
			type: "trigger",
			position: { x: 80, y: 60 },
			data: {
				label: "Animation request trigger",
				description:
					"Receives animationDescription and cliRuntime for the 3Blue1Brown-style animation.",
			},
		},
		{
			id: "workspace_profile",
			type: "action",
			position: { x: 80, y: 200 },
			data: {
				label: "Provision retained sandbox",
				actionType: "workspace/profile",
				description:
					"Stand up a per-run sandbox with file/exec tools; keepAfterRun=true so the live preview can attach after the run.",
			},
		},
		{
			id: "build_3b1b_animation",
			type: "action",
			position: { x: 80, y: 340 },
			data: {
				label: "Build with selected CLI",
				actionType: "durable/run",
				description:
					"Resolve cliRuntime to a managed CLI agent and generate the browser animation.",
			},
		},
		{
			id: "verify_copied_animation",
			type: "action",
			position: { x: 80, y: 480 },
			data: {
				label: "Verify copied animation",
				actionType: "workspace/command",
				description:
					"Run file and syntax checks against the retained workspace after CLI output sync.",
			},
		},
		{
			id: "browser_validate_capture",
			type: "action",
			position: { x: 80, y: 620 },
			data: {
				label: "Capture animation walkthrough",
				actionType: "browser/validate",
				description:
					"Boot a static server against the copied files and capture initial / play / second play / restart screenshots.",
			},
		},
		{
			id: "start_preview",
			type: "action",
			position: { x: 80, y: 760 },
			data: {
				label: "Start live preview",
				actionType: "browser/start-preview",
				description:
					"Start a keep-alive preview proxy for the retained workspace so the run page can open the generated animation.",
			},
		},
	];
}

function buildEdges(): JsonRecord[] {
	const ordered = [
		"trigger",
		"workspace_profile",
		"build_3b1b_animation",
		"verify_copied_animation",
		"browser_validate_capture",
		"start_preview",
	];
	return ordered.slice(0, -1).map((source, index) => ({
		id: `e_cli_3b1b_${index + 1}`,
		source,
		target: ordered[index + 1],
		type: "default",
	}));
}

function buildCliWorkflowSpec(
	sourceSpec: unknown,
	args: ParsedArgs,
): JsonRecord {
	if (!isRecord(sourceSpec)) {
		throw new Error("Source workflow spec must be a JSON object");
	}
	const spec = cloneJson(sourceSpec);
	normalizeSandboxTemplateDefaults(spec);
	addRuntimeInput(spec, args.defaultRuntime);
	replaceBuildTasks(spec);

	const document = ensureRecord(spec, "document");
	document.name = args.workflowId;
	document.title = args.workflowName;
	document.summary = args.workflowDescription;
	return spec;
}

async function main() {
	if (!DATABASE_URL) {
		throw new Error("DATABASE_URL is required");
	}

	const args = parseArgs(process.argv.slice(2));
	const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
	try {
		const sourceRows = await sql`
			select id, user_id, project_id, spec
			from workflows
			where id = ${args.sourceWorkflowId}
			limit 1
		`;
		const sourceWorkflow = sourceRows[0];
		if (!sourceWorkflow) {
			throw new Error(`Source workflow ${args.sourceWorkflowId} was not found`);
		}

		const existingRows = await sql`
			select user_id, project_id
			from workflows
			where id = ${args.workflowId}
			limit 1
		`;
		const owner = await resolveOwner(
			sql,
			existingRows[0],
			sourceWorkflow,
			args.userEmail,
		);

		const resolvedAgents = Object.fromEntries(
			await Promise.all(
				CLI_RUNTIMES.map(async (descriptor) => [
					descriptor.runtime,
					await resolveCliAgent(
						sql,
						descriptor,
						args.agentOverrides[descriptor.runtime],
					),
				]),
			),
		) as Record<CliRuntime, AgentRef>;

		const spec = buildCliWorkflowSpec(sourceWorkflow.spec, args);
		const nodes = buildNodes();
		const edges = buildEdges();
		const now = new Date().toISOString();

		await sql`
			insert into workflows (
				id,
				name,
				description,
				user_id,
				project_id,
				nodes,
				edges,
				visibility,
				engine_type,
				spec_version,
				spec,
				created_at,
				updated_at
			)
			values (
				${args.workflowId},
				${args.workflowName},
				${args.workflowDescription},
				${owner.userId},
				${owner.projectId},
				${sql.json(nodes as postgres.JSONValue)},
				${sql.json(edges as postgres.JSONValue)},
				${"public"},
				${"dapr"},
				${"1.0.0"},
				${sql.json(spec as postgres.JSONValue)},
				${now},
				${now}
			)
			on conflict (id) do update
			set
				name = excluded.name,
				description = excluded.description,
				nodes = excluded.nodes,
				edges = excluded.edges,
				visibility = excluded.visibility,
				engine_type = excluded.engine_type,
				spec_version = excluded.spec_version,
				spec = excluded.spec,
				updated_at = excluded.updated_at
		`;

		console.log(`Upserted workflow ${args.workflowId}`);
		console.log(`  source          = ${args.sourceWorkflowId}`);
		console.log(`  defaultRuntime  = ${args.defaultRuntime}`);
		for (const descriptor of CLI_RUNTIMES) {
			const agent = resolvedAgents[descriptor.runtime];
			console.log(
				`  ${descriptor.runtime.padEnd(16)} = ${agent.id} v${agent.version} (${agent.slug})`,
			);
		}
		console.log(`  owner.userId    = ${owner.userId}`);
		console.log(`  owner.projectId = ${owner.projectId ?? "(none)"}`);
		console.log(`  visibility      = public`);
		console.log(`  UI route        : /workflows/${args.workflowId}`);
	} finally {
		await sql.end({ timeout: 5 });
	}
}

main().catch((error) => {
	console.error("[upsert-3b1b-cli-animation-workflow] Error:", error);
	process.exitCode = 1;
});
