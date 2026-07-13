import { describe, expect, it } from "vitest";

import { deriveDevExecutionLifecycle } from "./dev-execution-lifecycle";

describe("dev execution lifecycle", () => {
	it("reports only the facts available while services are provisioning", () => {
		const lifecycle = deriveDevExecutionLifecycle({
			executionId: "execution-123456",
			runStatus: "running",
			sessionId: null,
			services: [
				{ ready: true, syncUrl: "http://sync-one" },
				{ ready: false, syncUrl: null },
			],
		});

		expect(lifecycle.summary).toBe("Provisioning services: 1 of 2 ready.");
		expect(lifecycle.stages).toMatchObject([
			{ label: "Requested", state: "complete" },
			{ label: "Services", detail: "1/2 ready", state: "active" },
			{ label: "Live-sync endpoint", detail: "1/2 endpoint available", state: "pending" },
			{ label: "Agent session", state: "pending" },
		]);
	});

	it("marks resources ready without claiming that an HMR update occurred", () => {
		const lifecycle = deriveDevExecutionLifecycle({
			executionId: "execution-123456",
			runStatus: "running",
			sessionId: "session-1",
			services: [{ ready: true, syncUrl: "http://sync-one" }],
		});

		expect(lifecycle.effectiveStatus).toBe("ready");
		expect(lifecycle.summary).toContain("live-sync endpoints are ready");
		expect(lifecycle.stages[2]).toEqual({
			label: "Live-sync endpoint",
			detail: "1/1 endpoint available",
			state: "complete",
		});
		expect(lifecycle.stages[3]).toMatchObject({ detail: "Attached", state: "complete" });
	});

	it("keeps live sync active until every selected service reports an endpoint", () => {
		const lifecycle = deriveDevExecutionLifecycle({
			executionId: "execution-123456",
			runStatus: "running",
			sessionId: "session-1",
			services: [
				{ ready: true, syncUrl: "http://sync-one" },
				{ ready: true, syncUrl: null },
			],
		});

		expect(lifecycle.summary).toBe("Live-sync endpoints: 1 of 2 available.");
		expect(lifecycle.stages[2]).toMatchObject({
			detail: "1/2 endpoint available",
			state: "active",
		});
	});

	it("does not leave active spinners after a terminal run", () => {
		const lifecycle = deriveDevExecutionLifecycle({
			executionId: "execution-123456",
			runStatus: "success",
			sessionId: null,
			services: [{ ready: false, syncUrl: null }],
		});

		expect(lifecycle.runTerminal).toBe(true);
		expect(lifecycle.summary).toBe("Run success; 0 of 1 services reported ready.");
		expect(lifecycle.stages.every((stage) => stage.state !== "active")).toBe(true);
	});

	it("surfaces workflow failure across unavailable stages", () => {
		const lifecycle = deriveDevExecutionLifecycle({
			executionId: "execution-123456",
			runStatus: "error",
			sessionId: null,
			services: [{ ready: false, syncUrl: null }],
		});

		expect(lifecycle.effectiveStatus).toBe("error");
		expect(lifecycle.summary).toBe("Environment workflow failed with status error.");
		expect(lifecycle.stages.slice(1).every((stage) => stage.state === "failed")).toBe(true);
	});
});
