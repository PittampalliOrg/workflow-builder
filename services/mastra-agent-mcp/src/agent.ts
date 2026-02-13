/**
 * Mastra Agent Definition
 *
 * Stub agent with 2 tools (greet, current_time).
 * Emits lifecycle events to the event bus.
 */

import { Agent, createTool } from "@mastra/core";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { nanoid } from "nanoid";
import { eventBus } from "./event-bus.js";

const greetTool = createTool({
	id: "greet",
	description: "Greet a person by name",
	inputSchema: z.object({
		name: z.string().describe("The person's name"),
	}),
	outputSchema: z.object({
		greeting: z.string(),
	}),
	execute: async ({ context }) => {
		return { greeting: `Hello, ${context.name}! Welcome to the Mastra Agent.` };
	},
});

const currentTimeTool = createTool({
	id: "current_time",
	description: "Get the current date and time in a specified timezone",
	inputSchema: z.object({
		timezone: z
			.string()
			.default("UTC")
			.describe("IANA timezone (e.g. America/New_York, UTC)"),
	}),
	outputSchema: z.object({
		time: z.string(),
		timezone: z.string(),
	}),
	execute: async ({ context }) => {
		const tz = context.timezone || "UTC";
		const now = new Date();
		let formatted: string;
		try {
			formatted = now.toLocaleString("en-US", { timeZone: tz });
		} catch {
			formatted = now.toISOString();
		}
		return { time: formatted, timezone: tz };
	},
});

const mastraAgent = new Agent({
	name: "mastra-agent",
	instructions:
		"You are a helpful assistant. Use the greet tool to greet people and the current_time tool to tell the time. Be concise.",
	model: openai("gpt-4o-mini"),
	tools: { greet: greetTool, current_time: currentTimeTool },
});

export const TOOL_NAMES = ["greet", "current_time"];

export type RunResult = {
	text: string;
	toolCalls: Array<{ name: string; args: unknown; result: unknown }>;
	usage: { promptTokens: number; completionTokens: number; totalTokens: number };
};

export async function runAgent(prompt: string): Promise<RunResult> {
	const runId = nanoid();
	const toolCalls: RunResult["toolCalls"] = [];
	let totalPromptTokens = 0;
	let totalCompletionTokens = 0;

	eventBus.setState({
		status: "running",
		currentActivity: `Processing: "${prompt.slice(0, 60)}"`,
		runId,
		startedAt: new Date().toISOString(),
	});
	eventBus.emitEvent("agent_started", { prompt });

	try {
		const result = await mastraAgent.generate(prompt, {
			maxSteps: 5,
			onStepFinish: (step: any) => {
				if (step.toolCalls && step.toolCalls.length > 0) {
					for (const tc of step.toolCalls) {
						const callId = nanoid(8);
						eventBus.emitEvent(
							"tool_call",
							{ toolName: tc.toolName, args: tc.args },
							callId,
						);
						toolCalls.push({
							name: tc.toolName,
							args: tc.args,
							result: tc.result,
						});
						eventBus.emitEvent(
							"tool_result",
							{ toolName: tc.toolName, result: tc.result },
							callId,
						);
					}
				}
				if (step.usage) {
					totalPromptTokens += step.usage.promptTokens ?? 0;
					totalCompletionTokens += step.usage.completionTokens ?? 0;
					eventBus.emitEvent("llm_end", {
						promptTokens: step.usage.promptTokens,
						completionTokens: step.usage.completionTokens,
					});
				}
			},
		});

		const totalTokens = totalPromptTokens + totalCompletionTokens;
		eventBus.setState({
			status: "idle",
			currentActivity: null,
			totalRuns: eventBus.getState().totalRuns + 1,
			totalTokens: eventBus.getState().totalTokens + totalTokens,
			lastError: null,
		});
		eventBus.emitEvent("agent_completed", {
			success: true,
			text: result.text?.slice(0, 200),
			toolCallCount: toolCalls.length,
			totalTokens,
		});

		return {
			text: result.text ?? "",
			toolCalls,
			usage: {
				promptTokens: totalPromptTokens,
				completionTokens: totalCompletionTokens,
				totalTokens,
			},
		};
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		eventBus.setState({
			status: "error",
			currentActivity: null,
			lastError: errorMsg,
			totalRuns: eventBus.getState().totalRuns + 1,
		});
		eventBus.emitEvent("agent_completed", {
			success: false,
			error: errorMsg,
		});
		throw error;
	}
}
