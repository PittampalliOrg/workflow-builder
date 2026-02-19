/**
 * Create a Claude Opus 4.6 agent with all workspace tools.
 * Usage: pnpm tsx scripts/create-opus-agent.ts
 */

import { eq } from "drizzle-orm";
import { db } from "../lib/db";
import { agents, users, platforms } from "../lib/db/schema";

async function main() {
	// Find the first admin user
	const [platform] = await db
		.select({ ownerId: platforms.ownerId })
		.from(platforms)
		.limit(1);

	let userId = platform?.ownerId;
	if (!userId) {
		const [firstUser] = await db.select({ id: users.id }).from(users).limit(1);
		userId = firstUser?.id;
	}

	if (!userId) {
		console.error("No users found. Run the app and create a user first.");
		process.exit(1);
	}

	// Check if it already exists
	const [existing] = await db
		.select({ id: agents.id })
		.from(agents)
		.where(eq(agents.name, "Claude Opus 4.6"))
		.limit(1);

	if (existing) {
		console.log(`Agent "Claude Opus 4.6" already exists (id: ${existing.id})`);
		process.exit(0);
	}

	const [created] = await db
		.insert(agents)
		.values({
			name: "Claude Opus 4.6",
			description:
				"Full-featured agent powered by Claude Opus 4.6 with all workspace tools enabled.",
			agentType: "general",
			instructions: `You are a highly capable development assistant powered by Claude Opus 4.6.

You have access to all workspace tools. Use them to help users with any development task:
- Read, write, and edit files in the workspace
- Search and enumerate files using glob and grep
- Execute shell commands for builds, tests, and analysis

Be thorough, precise, and proactive. When given a task:
1. Explore the codebase first to understand context
2. Make targeted, well-reasoned changes
3. Verify your work by reading back files or running tests
4. Explain what you did and why`,
			model: { provider: "anthropic", name: "claude-opus-4-6" },
			tools: [
				{ type: "workspace", ref: "read" },
				{ type: "workspace", ref: "write" },
				{ type: "workspace", ref: "edit" },
				{ type: "workspace", ref: "glob" },
				{ type: "workspace", ref: "grep" },
				{ type: "workspace", ref: "bash" },
			],
			maxTurns: 50,
			timeoutMinutes: 30,
			isDefault: false,
			isEnabled: true,
			userId,
		})
		.returning();

	console.log(`Created agent "Claude Opus 4.6" (id: ${created.id})`);
	process.exit(0);
}

main().catch((err) => {
	console.error("Error:", err);
	process.exit(1);
});
