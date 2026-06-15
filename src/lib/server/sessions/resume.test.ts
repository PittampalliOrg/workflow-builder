import { describe, expect, it } from "vitest";
import {
	canResumeCliSession,
	isInteractiveCliRuntime,
	isNonGracefulExit,
} from "./resume";

const cliRuntime = {
	family: "interactive-cli" as const,
	capabilities: { interactiveTerminal: true },
};
const durableRuntime = {
	family: "durable-session" as const,
	capabilities: { interactiveTerminal: false },
};

describe("isInteractiveCliRuntime", () => {
	it("detects via family", () => {
		expect(isInteractiveCliRuntime(cliRuntime)).toBe(true);
	});
	it("detects via interactiveTerminal capability", () => {
		expect(
			isInteractiveCliRuntime({
				family: "durable-session",
				capabilities: { interactiveTerminal: true },
			}),
		).toBe(true);
	});
	it("rejects non-cli runtimes and null", () => {
		expect(isInteractiveCliRuntime(durableRuntime)).toBe(false);
		expect(isInteractiveCliRuntime(null)).toBe(false);
		expect(isInteractiveCliRuntime(undefined)).toBe(false);
	});
});

describe("isNonGracefulExit", () => {
	it("treats failed/error/crashed statuses as non-graceful", () => {
		expect(isNonGracefulExit({ status: "failed" })).toBe(true);
		expect(isNonGracefulExit({ status: "error" })).toBe(true);
		expect(isNonGracefulExit({ status: "crashed" })).toBe(true);
	});
	it("treats a non-end_turn stopReason as non-graceful", () => {
		expect(
			isNonGracefulExit({ status: "terminated", stopReason: { type: "interrupted" } }),
		).toBe(true);
		expect(
			isNonGracefulExit({ status: "terminated", stopReason: { type: "host_timeout" } }),
		).toBe(true);
	});
	it("treats a set errorMessage as non-graceful", () => {
		expect(
			isNonGracefulExit({ status: "terminated", errorMessage: "pod OOMKilled" }),
		).toBe(true);
	});
	it("treats a clean end_turn / completed as graceful", () => {
		expect(
			isNonGracefulExit({ status: "terminated", stopReason: { type: "end_turn" } }),
		).toBe(false);
		expect(
			isNonGracefulExit({ status: "terminated", stopReason: { type: "completed" } }),
		).toBe(false);
		expect(isNonGracefulExit({ status: "terminated" })).toBe(false);
	});
});

describe("canResumeCliSession", () => {
	it("RELAXATION: a crashed/failed (non-graceful) CLI session IS resumable", () => {
		// status 'failed' — the old `status === "terminated"` gate REJECTED this.
		const failed = canResumeCliSession({ runtime: cliRuntime, status: "failed" });
		expect(failed.allowed).toBe(true);
		expect(failed.nonGraceful).toBe(true);

		// terminated-but-crashed (non-end_turn stopReason) is resumable + flagged.
		const crashed = canResumeCliSession({
			runtime: cliRuntime,
			status: "terminated",
			stopReason: { type: "host_timeout" },
		});
		expect(crashed.allowed).toBe(true);
		expect(crashed.nonGraceful).toBe(true);
	});

	it("a gracefully terminated CLI session is resumable (nonGraceful=false)", () => {
		const d = canResumeCliSession({
			runtime: cliRuntime,
			status: "terminated",
			stopReason: { type: "end_turn" },
		});
		expect(d.allowed).toBe(true);
		expect(d.nonGraceful).toBe(false);
	});

	it("rejects a non-interactive-cli runtime (400-class)", () => {
		const d = canResumeCliSession({ runtime: durableRuntime, status: "terminated" });
		expect(d.allowed).toBe(false);
		expect(d.reason).toMatch(/interactive-cli/);
	});

	it("rejects a still-live (non-terminal) session unless runtimeGone is asserted", () => {
		const live = canResumeCliSession({ runtime: cliRuntime, status: "running" });
		expect(live.allowed).toBe(false);
		expect(live.reason).toMatch(/terminated or crashed/);

		// The auto-resume reconciler supplies positive liveness evidence.
		const goneButNotConverged = canResumeCliSession({
			runtime: cliRuntime,
			status: "running",
			runtimeGone: true,
		});
		expect(goneButNotConverged.allowed).toBe(true);
	});
});
