import { describe, expect, it, vi } from "vitest";
import {
	InProcessEventBus,
	LiteStubWorkflowScheduler,
} from "$lib/server/application/adapters/in-process";
import { isLiteWorkflowInstanceId } from "$lib/server/application/lite-profile";
import type { WorkflowStartRequest } from "$lib/server/application/ports";

describe("InProcessEventBus", () => {
	it("publishes without throwing and records events in the ring buffer", async () => {
		const bus = new InProcessEventBus();
		await bus.publish("workflow.trigger", { a: 1 });
		await bus.publish("workflow.trigger", { a: 2 });
		const recent = bus.recent();
		expect(recent).toHaveLength(2);
		expect(recent[0]).toMatchObject({ topic: "workflow.trigger", payload: { a: 2 } });
	});

	it("bounds the ring buffer to its size", async () => {
		const bus = new InProcessEventBus(3);
		for (let i = 0; i < 10; i++) await bus.publish("t", i);
		const recent = bus.recent();
		expect(recent).toHaveLength(3);
		expect(recent.map((e) => e.payload)).toEqual([9, 8, 7]);
	});

	it("delivers to in-process subscribers", async () => {
		const bus = new InProcessEventBus();
		const seen: unknown[] = [];
		const off = bus.subscribe("topic", (p) => seen.push(p));
		await bus.publish("topic", "hello");
		off();
		await bus.publish("topic", "after-unsubscribe");
		expect(seen).toEqual(["hello"]);
	});
});

describe("LiteStubWorkflowScheduler", () => {
	const request: WorkflowStartRequest = {
		orchestratorUrl: "http://unused",
		workflow: {},
		workflowId: "wf-1",
		triggerData: {},
		dbExecutionId: "exec-1",
		headers: {},
	};

	it("returns a lite-prefixed instance id and does not throw", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const scheduler = new LiteStubWorkflowScheduler();
		const { instanceId } = await scheduler.startSwWorkflow(request);
		expect(instanceId).toBeDefined();
		expect(isLiteWorkflowInstanceId(instanceId)).toBe(true);
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
	});

	it("does not fake activity execution (distinct id per call)", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const scheduler = new LiteStubWorkflowScheduler();
		const a = await scheduler.startSwWorkflow(request);
		const b = await scheduler.startSwWorkflow(request);
		expect(a.instanceId).not.toBe(b.instanceId);
		vi.restoreAllMocks();
	});
});
