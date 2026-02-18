/**
 * Create a simple CEL-based while-loop workflow programmatically:
 * trigger -> while (CEL) -> set-state
 *            \_ durable/run (nested body)
 *
 * Usage:
 *   DATABASE_URL=... pnpm tsx scripts/create-cel-while-durable-workflow.ts
 *   DATABASE_URL=... pnpm tsx scripts/create-cel-while-durable-workflow.ts --user-email you@example.com
 *   DATABASE_URL=... pnpm tsx scripts/create-cel-while-durable-workflow.ts --expression "iteration < 2"
 *   DATABASE_URL=... pnpm tsx scripts/create-cel-while-durable-workflow.ts --prompt "Summarize the request in one sentence."
 */

import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { nanoid } from "nanoid";
import postgres from "postgres";
import { projectMembers, projects, users, workflows } from "../lib/db/schema";
import { generateId } from "../lib/utils/id";
import { normalizeWorkflowNodes } from "../lib/workflows/normalize-nodes";

const DATABASE_URL = process.env.DATABASE_URL;

type Args = {
	userEmail?: string;
	name: string;
	description: string;
	expression: string;
	prompt: string;
	model?: string;
};

function parseArgs(argv: string[]): Args {
	let userEmail: string | undefined;
	let name = "CEL While + Durable Agent Example";
	let description =
		"Programmatic example workflow: while(CEL) loop around a durable agent node.";
	let expression = "iteration < 3";
	let prompt =
		"You are in a loop iteration. Return one short sentence confirming completion.";
	let model: string | undefined;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--user-email") {
			userEmail = argv[i + 1];
			i++;
		} else if (arg === "--name") {
			name = argv[i + 1] || name;
			i++;
		} else if (arg === "--description") {
			description = argv[i + 1] || description;
			i++;
		} else if (arg === "--expression") {
			expression = argv[i + 1] || expression;
			i++;
		} else if (arg === "--prompt") {
			prompt = argv[i + 1] || prompt;
			i++;
		} else if (arg === "--model") {
			model = argv[i + 1] || model;
			i++;
		}
	}

	return {
		userEmail: userEmail?.trim(),
		name: name.trim(),
		description: description.trim(),
		expression: expression.trim() || "iteration < 3",
		prompt: prompt.trim(),
		model: model?.trim() || undefined,
	};
}

async function resolveUserId(
	db: ReturnType<typeof drizzle>,
	userEmail?: string,
): Promise<{ userId: string; email: string | null }> {
	if (userEmail) {
		const user = await db.query.users.findFirst({
			where: eq(users.email, userEmail),
		});
		if (!user) {
			throw new Error(`User not found for email: ${userEmail}`);
		}
		return { userId: user.id, email: user.email };
	}

	const [latestWorkflow] = await db
		.select({ userId: workflows.userId })
		.from(workflows)
		.orderBy(desc(workflows.updatedAt))
		.limit(1);
	if (latestWorkflow?.userId) {
		const user = await db.query.users.findFirst({
			where: eq(users.id, latestWorkflow.userId),
		});
		return {
			userId: latestWorkflow.userId,
			email: user?.email ?? null,
		};
	}

	const [fallbackUser] = await db
		.select({ id: users.id, email: users.email })
		.from(users)
		.orderBy(desc(users.updatedAt))
		.limit(1);

	if (!fallbackUser) {
		throw new Error("No users found in database");
	}

	return { userId: fallbackUser.id, email: fallbackUser.email };
}

async function resolveProjectId(
	db: ReturnType<typeof drizzle>,
	userId: string,
): Promise<string> {
	const ownedProject = await db.query.projects.findFirst({
		where: eq(projects.ownerId, userId),
		orderBy: [desc(projects.updatedAt)],
	});
	if (ownedProject) {
		return ownedProject.id;
	}

	const membership = await db.query.projectMembers.findFirst({
		where: eq(projectMembers.userId, userId),
		orderBy: [desc(projectMembers.updatedAt)],
	});
	if (membership) {
		return membership.projectId;
	}

	throw new Error(
		`No project found for user ${userId}. Create or join a project first.`,
	);
}

function buildWorkflowGraph(input: {
	expression: string;
	prompt: string;
	model?: string;
}) {
	const triggerId = nanoid();
	const whileId = nanoid();
	const durableAgentId = nanoid();
	const afterLoopId = nanoid();

	const durableConfig: Record<string, string> = {
		actionType: "durable/run",
		mode: "execute_direct",
		prompt: input.prompt,
		maxTurns: "4",
	};
	if (input.model) {
		durableConfig.model = input.model;
	}

	const nodes = normalizeWorkflowNodes([
		{
			id: triggerId,
			type: "trigger",
			position: { x: -420, y: 40 },
			data: {
				label: "Manual Trigger",
				description: "",
				type: "trigger",
				config: { triggerType: "Manual" },
				status: "idle",
			},
		},
		{
			id: whileId,
			type: "while",
			position: { x: -110, y: -40 },
			data: {
				label: "While",
				description: "Loop while condition is true",
				type: "while",
				config: {
					expression: input.expression,
					maxIterations: "10",
					delaySeconds: "0",
					onMaxIterations: "continue",
				},
				status: "idle",
			},
		},
		{
			id: durableAgentId,
			type: "action",
			parentId: whileId,
			extent: "parent",
			position: { x: 112, y: 88 },
			data: {
				label: "Durable Agent",
				description: "Loop body",
				type: "action",
				config: durableConfig,
				status: "idle",
			},
		},
		{
			id: afterLoopId,
			type: "set-state",
			position: { x: 360, y: 40 },
			data: {
				label: "Mark Completed",
				description: "Set a state value after loop exits",
				type: "set-state",
				config: {
					entries: [{ key: "loopComplete", value: "true" }],
				},
				status: "idle",
			},
		},
	]);

	const edges = [
		{
			id: nanoid(),
			type: "animated",
			source: triggerId,
			target: whileId,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: nanoid(),
			type: "animated",
			source: whileId,
			target: afterLoopId,
			sourceHandle: null,
			targetHandle: null,
		},
	];

	return { nodes, edges };
}

async function main() {
	if (!DATABASE_URL) {
		throw new Error(
			"DATABASE_URL is required. Provide a valid connection string.",
		);
	}

	const args = parseArgs(process.argv.slice(2));
	const client = postgres(DATABASE_URL, { max: 1 });
	const db = drizzle(client, {
		schema: { users, projects, projectMembers, workflows },
	});

	try {
		const { userId, email } = await resolveUserId(db, args.userEmail);
		const projectId = await resolveProjectId(db, userId);
		const { nodes, edges } = buildWorkflowGraph({
			expression: args.expression,
			prompt: args.prompt,
			model: args.model,
		});

		const workflowId = generateId();
		const [created] = await db
			.insert(workflows)
			.values({
				id: workflowId,
				name: args.name,
				description: args.description,
				userId,
				projectId,
				nodes,
				edges,
				visibility: "private",
				engineType: "dapr",
			})
			.returning({
				id: workflows.id,
				name: workflows.name,
				userId: workflows.userId,
				projectId: workflows.projectId,
				updatedAt: workflows.updatedAt,
			});

		console.log("Workflow created");
		console.log(`  id: ${created.id}`);
		console.log(`  name: ${created.name}`);
		console.log(`  userId: ${created.userId}`);
		console.log(`  userEmail: ${email ?? "unknown"}`);
		console.log(`  projectId: ${created.projectId}`);
		console.log(`  whileExpression: ${args.expression}`);
		console.log(`  prompt: ${args.prompt}`);
		console.log(`  updatedAt: ${created.updatedAt.toISOString()}`);
		console.log(`  open: /workflows/${created.id}`);
	} finally {
		await client.end();
	}
}

main().catch((error) => {
	console.error("Failed to create CEL while durable-agent workflow:", error);
	process.exit(1);
});
