/**
 * Planning Agent
 *
 * Uses AI SDK generateObject() to create structured execution plans.
 * Replaces the Mastra planner agent.
 */

import { generateObject, type LanguageModelV1 } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

const PlanStepSchema = z.object({
	step: z.number().describe("Step number (1-based)"),
	action: z.string().describe("What to do (e.g., 'Read the config file')"),
	tool: z
		.string()
		.describe(
			"Which workspace tool to use (e.g., 'read_file', 'execute_command')",
		),
	reasoning: z.string().describe("Why this step is needed"),
});

const PlanSchema = z.object({
	goal: z.string().describe("One-sentence summary of the overall goal"),
	steps: z
		.array(PlanStepSchema)
		.describe("Ordered list of steps to accomplish the goal"),
	estimated_tool_calls: z.number().describe("Expected number of tool calls"),
});

export type Plan = z.infer<typeof PlanSchema>;

const AVAILABLE_TOOLS = `Available workspace tools:
- read_file: Read a file from the workspace
- write_file: Create or overwrite a file
- edit_file: Find and replace text in a file
- list_files: List directory contents
- execute_command: Run a shell command
- delete_file: Delete a file or directory
- mkdir: Create a directory
- file_stat: Get file metadata`;

const SYSTEM_PROMPT = `You are a planning agent. Given a task, create a structured execution plan.

${AVAILABLE_TOOLS}

Rules:
- Break the task into concrete, sequential steps
- Each step should map to exactly one tool call
- Order steps logically (read before edit, mkdir before write, etc.)
- Be specific about file paths and commands
- Keep plans concise — avoid unnecessary steps`;

export async function generatePlan(prompt: string): Promise<Plan> {
	const result = await generateObject({
		model: openai(process.env.AI_MODEL ?? "gpt-4o") as unknown as LanguageModelV1,
		schema: PlanSchema,
		system: SYSTEM_PROMPT,
		prompt: `Create an execution plan for this task:\n\n${prompt}`,
	});
	return result.object;
}
