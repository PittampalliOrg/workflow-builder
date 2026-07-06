import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/private", () => ({ env: process.env }));

// The SUM query reads session_events joined to sessions. Mock the drizzle chain
// db.select({data}).from(sessionEvents).innerJoin(sessions, …).where(…) → rows.
const dbMock = vi.hoisted(() => {
	let rows: Array<{ data: Record<string, unknown> }> = [];
	const where = vi.fn(async () => rows);
	const innerJoin = vi.fn(() => ({ where }));
	const from = vi.fn(() => ({ innerJoin }));
	const select = vi.fn(() => ({ from }));
	return {
		setRows: (r: Array<{ data: Record<string, unknown> }>) => {
			rows = r;
		},
		where,
		innerJoin,
		from,
		select,
	};
});

vi.mock("$lib/server/db", () => ({ db: { select: dbMock.select } }));

import { sumExecutionLlmUsage } from "./script-calls-store";

beforeEach(() => {
	dbMock.setRows([]);
	dbMock.select.mockClear();
});

describe("sumExecutionLlmUsage", () => {
	it("sums input + output + cache_creation over agent.llm_usage events (goal-loop formula)", async () => {
		dbMock.setRows([
			{
				data: {
					input_tokens: 100,
					output_tokens: 50,
					cache_creation_input_tokens: 20,
					// cache READS are excluded by the goal-loop formula.
					cache_read_input_tokens: 9999,
				},
			},
			{ data: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0 } },
		]);
		const { totalTokens } = await sumExecutionLlmUsage("exec-1");
		// (100 + 50 + 20) + (10 + 5 + 0) = 185 — cache reads NOT counted.
		expect(totalTokens).toBe(185);
	});

	it("returns 0 when there are no usage events", async () => {
		dbMock.setRows([]);
		const { totalTokens } = await sumExecutionLlmUsage("exec-empty");
		expect(totalTokens).toBe(0);
	});

	it("ignores non-numeric / negative token fields", async () => {
		dbMock.setRows([
			{ data: { input_tokens: "junk", output_tokens: -5, cache_creation_input_tokens: 7 } },
		]);
		const { totalTokens } = await sumExecutionLlmUsage("exec-2");
		expect(totalTokens).toBe(7);
	});
});
