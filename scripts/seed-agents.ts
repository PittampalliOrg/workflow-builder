/**
 * Seed default agent templates into the agents table.
 *
 * Usage: pnpm seed-agents
 *
 * Creates 4 default agent templates owned by the first admin user.
 * Idempotent: skips if agents with the same name already exist.
 */

import { eq } from "drizzle-orm";
import { db } from "../lib/db";
import { agents, users, platforms } from "../lib/db/schema";

const DEFAULT_AGENTS = [
	{
		name: "General Purpose",
		description:
			"A versatile assistant that can read, write, and edit files, run commands, and help with general development tasks.",
		agentType: "general" as const,
		instructions: `You are a development assistant with access to workspace tools.

Use workspace tools to help users with file operations and command execution:
- Read, write, and edit files in the workspace
- Search and enumerate files with glob and grep
- Execute shell commands

Be concise and direct. Use the appropriate tool for each task.`,
		model: { provider: "openai", name: "gpt-4o" },
		tools: [
			{ type: "workspace" as const, ref: "read" },
			{ type: "workspace" as const, ref: "write" },
			{ type: "workspace" as const, ref: "edit" },
			{ type: "workspace" as const, ref: "glob" },
			{ type: "workspace" as const, ref: "grep" },
			{ type: "workspace" as const, ref: "bash" },
		],
		maxTurns: 50,
		timeoutMinutes: 30,
		isDefault: true,
	},
	{
		name: "Code Assistant",
		description:
			"Specialized for code review, refactoring, bug fixes, and implementing features.",
		agentType: "code-assistant" as const,
		instructions: `You are an expert code assistant. You help users write, review, refactor, and debug code.

Guidelines:
- Always read existing code before making changes
- Follow existing code style and patterns
- Write clean, well-structured code
- Explain your changes when asked
- Run tests after making changes when possible
- Use edit for targeted changes, write for new files`,
		model: { provider: "openai", name: "gpt-4o" },
		tools: [
			{ type: "workspace" as const, ref: "read" },
			{ type: "workspace" as const, ref: "write" },
			{ type: "workspace" as const, ref: "edit" },
			{ type: "workspace" as const, ref: "glob" },
			{ type: "workspace" as const, ref: "grep" },
			{ type: "workspace" as const, ref: "bash" },
		],
		maxTurns: 50,
		timeoutMinutes: 30,
		isDefault: false,
	},
	{
		name: "Research Agent",
		description:
			"Reads and analyzes code, explores directory structures, and generates reports.",
		agentType: "research" as const,
		instructions: `You are a research agent that analyzes codebases and generates insights.

Guidelines:
- Thoroughly explore the codebase before drawing conclusions
- Read multiple files to understand architecture and patterns
- Use bash to run analysis tools (grep, find, wc, etc.)
- Provide structured, actionable findings
- Do NOT modify any files — you are read-only`,
		model: { provider: "openai", name: "gpt-4o" },
		tools: [
			{ type: "workspace" as const, ref: "read" },
			{ type: "workspace" as const, ref: "glob" },
			{ type: "workspace" as const, ref: "grep" },
			{ type: "workspace" as const, ref: "bash" },
		],
		maxTurns: 30,
		timeoutMinutes: 20,
		isDefault: false,
	},
	{
		name: "Planning Agent",
		description:
			"Generates structured execution plans without making changes. Prompt-only, no tools.",
		agentType: "planning" as const,
		instructions: `You are a planning agent. Given a task description, generate a structured execution plan.

Your plan should include:
1. A clear goal statement
2. Ordered steps with specific actions
3. Expected outcomes for each step
4. Potential risks or considerations

You do NOT execute the plan — you only produce it. Be specific and actionable.`,
		model: { provider: "openai", name: "gpt-4o" },
		tools: [],
		maxTurns: 5,
		timeoutMinutes: 10,
		isDefault: false,
	},
];

async function main() {
	console.log("[seed-agents] Starting agent seed...");

	// Find the first admin user (platform owner)
	const [platform] = await db
		.select({ ownerId: platforms.ownerId })
		.from(platforms)
		.limit(1);

	let userId: string | undefined;

	if (platform?.ownerId) {
		userId = platform.ownerId;
	} else {
		// Fallback: find any user
		const [firstUser] = await db.select({ id: users.id }).from(users).limit(1);
		userId = firstUser?.id;
	}

	if (!userId) {
		console.log("[seed-agents] No users found. Run the app and create a user first.");
		process.exit(0);
	}

	console.log(`[seed-agents] Using user: ${userId}`);

	let created = 0;
	let skipped = 0;

	for (const agentDef of DEFAULT_AGENTS) {
		// Check if agent with same name already exists for this user
		const [existing] = await db
			.select({ id: agents.id })
			.from(agents)
			.where(eq(agents.name, agentDef.name))
			.limit(1);

		if (existing) {
			console.log(`[seed-agents] Skipping "${agentDef.name}" (already exists)`);
			skipped++;
			continue;
		}

		await db.insert(agents).values({
			...agentDef,
			userId,
			isEnabled: true,
		});

		console.log(`[seed-agents] Created "${agentDef.name}"`);
		created++;
	}

	console.log(
		`[seed-agents] Done. Created: ${created}, Skipped: ${skipped}`,
	);
	process.exit(0);
}

main().catch((err) => {
	console.error("[seed-agents] Error:", err);
	process.exit(1);
});
