import { describe, expect, it, vi } from "vitest";
import {
	archiveObjectKey,
	assembleRunArchiveBundle,
	runRunArchiveSweep,
	serializeRunArchiveBundle,
	type ArchiveArtifact,
	type ArchiveExecutionRow,
	type RunArchiveSweepDeps,
} from "./run-archive";

function execution(overrides: Partial<ArchiveExecutionRow> = {}): ArchiveExecutionRow {
	return {
		id: "exec-1",
		workflowId: "wf-1",
		status: "success",
		startedAt: "2026-07-20T10:00:00.000Z",
		completedAt: "2026-07-20T10:05:00.000Z",
		primaryTraceId: "trace-abc",
		output: {},
		...overrides,
	};
}

function artifact(overrides: Partial<ArchiveArtifact> = {}): ArchiveArtifact {
	return {
		id: "art-1",
		kind: "markdown",
		title: "Summary",
		slot: "primary",
		nodeId: "node-1",
		contentType: "text/markdown",
		sizeBytes: 10,
		inlinePayload: null,
		metadata: null,
		fileId: null,
		createdAt: "2026-07-20T10:04:00.000Z",
		...overrides,
	};
}

function baseAssembleDeps() {
	return {
		loadLinkedSessions: vi.fn(async () => [{ id: "sess-1" }, { id: "sess-2" }]),
		loadSessionEvents: vi.fn(async () => [
			{ sessionId: "sess-1", sequence: 0, type: "session.status_idle" },
			{ sessionId: "sess-1", sequence: 1, type: "agent.message" },
		]),
		loadScriptCalls: vi.fn(async () => [{ callId: "c0", seq: 0 }]),
		loadArtifacts: vi.fn(async (): Promise<ArchiveArtifact[]> => [artifact()]),
		loadArtifactFileBytes: vi.fn(async (): Promise<Buffer | null> => null),
		loadTraceSpans: vi.fn(
			async (): Promise<{ included: boolean; spans: unknown[]; note?: string }> => ({
				included: true,
				spans: [{ spanId: "s0" }],
			}),
		),
	};
}

describe("archiveObjectKey", () => {
	it("partitions by completion month", () => {
		expect(archiveObjectKey(execution())).toBe("2026-07/exec-1.json");
	});

	it("falls back to now when completedAt is missing", () => {
		expect(
			archiveObjectKey(execution({ completedAt: null }), new Date("2026-11-02T00:00:00Z")),
		).toBe("2026-11/exec-1.json");
	});
});

describe("assembleRunArchiveBundle", () => {
	it("assembles all parts with manifest counts", async () => {
		const deps = baseAssembleDeps();
		const bundle = await assembleRunArchiveBundle(execution(), deps, {
			now: () => new Date("2026-07-23T00:00:00.000Z"),
		});
		expect(bundle.manifest.parts).toMatchObject({
			execution: { included: true },
			sessions: { included: true, count: 2 },
			sessionEvents: { included: true, count: 2 },
			scriptCalls: { included: true, count: 1 },
			artifacts: { included: true, count: 1 },
			otlpSpans: { included: true, count: 1 },
		});
		expect(bundle.manifest.generatedAt).toBe("2026-07-23T00:00:00.000Z");
		expect(bundle.sessions).toHaveLength(2);
		expect(deps.loadSessionEvents).toHaveBeenCalledWith(["sess-1", "sess-2"]);
	});

	it("inlines a small blob artifact and omits an oversized one", async () => {
		const deps = baseAssembleDeps();
		deps.loadArtifacts = vi.fn(async () => [
			artifact({ id: "small", fileId: "file-small", sizeBytes: 100 }),
			artifact({ id: "big", fileId: "file-big", sizeBytes: 999_999 }),
		]);
		deps.loadArtifactFileBytes = vi.fn(async () => Buffer.from("blob-bytes"));

		const bundle = await assembleRunArchiveBundle(execution(), deps);
		const small = bundle.artifacts.find((a) => a.id === "small");
		const big = bundle.artifacts.find((a) => a.id === "big");
		expect(small?.payloadBase64).toBe(Buffer.from("blob-bytes").toString("base64"));
		expect(big?.payloadBase64).toBeUndefined();
		expect(big?.payloadOmittedReason).toBe("exceeds_inline_cap");
		// Oversized artifact never triggers a byte fetch.
		expect(deps.loadArtifactFileBytes).toHaveBeenCalledTimes(1);
	});

	it("degrades a single failing part to a noted omission without aborting", async () => {
		const deps = baseAssembleDeps();
		deps.loadTraceSpans = vi.fn(async () => {
			throw new Error("clickhouse down");
		});
		const bundle = await assembleRunArchiveBundle(execution(), deps);
		expect(bundle.manifest.parts.otlpSpans).toEqual({
			included: false,
			note: "clickhouse down",
		});
		// Other parts still assembled.
		expect(bundle.manifest.parts.sessions.included).toBe(true);
		expect(bundle.otlpSpans).toEqual([]);
	});

	it("skips the session-events query when there are no linked sessions", async () => {
		const deps = baseAssembleDeps();
		deps.loadLinkedSessions = vi.fn(async () => []);
		const bundle = await assembleRunArchiveBundle(execution(), deps);
		expect(deps.loadSessionEvents).not.toHaveBeenCalled();
		expect(bundle.manifest.parts.sessionEvents).toEqual({
			included: true,
			count: 0,
		});
	});

	it("serializes to valid JSON round-tripping the manifest", async () => {
		const deps = baseAssembleDeps();
		const bundle = await assembleRunArchiveBundle(execution(), deps);
		const parsed = JSON.parse(serializeRunArchiveBundle(bundle).toString("utf8"));
		expect(parsed.manifest.executionId).toBe("exec-1");
		expect(parsed.manifest.version).toBe(1);
	});
});

describe("runRunArchiveSweep", () => {
	function sweepDeps(
		executions: ArchiveExecutionRow[],
		overrides: Partial<RunArchiveSweepDeps> = {},
	): RunArchiveSweepDeps {
		return {
			...baseAssembleDeps(),
			listTerminalUnarchived: vi.fn(async () => executions),
			putArchive: vi.fn(async () => {}),
			markArchived: vi.fn(async () => {}),
			...overrides,
		};
	}

	it("archives each run at its month-partitioned key and marks it archived", async () => {
		const deps = sweepDeps([execution({ id: "exec-a" }), execution({ id: "exec-b" })]);
		const result = await runRunArchiveSweep(deps);
		expect(result.archived).toEqual(["exec-a", "exec-b"]);
		expect(result.failed).toEqual([]);
		expect(deps.putArchive).toHaveBeenNthCalledWith(
			1,
			"2026-07/exec-a.json",
			expect.any(Buffer),
		);
		expect(deps.markArchived).toHaveBeenCalledWith("exec-b");
	});

	it("isolates a per-run failure and still archives the rest", async () => {
		const putArchive = vi
			.fn()
			.mockRejectedValueOnce(new Error("s3 5xx"))
			.mockResolvedValue(undefined);
		const deps = sweepDeps(
			[execution({ id: "bad" }), execution({ id: "good" })],
			{ putArchive },
		);
		const result = await runRunArchiveSweep(deps);
		expect(result.archived).toEqual(["good"]);
		expect(result.failed).toEqual([{ executionId: "bad", error: "s3 5xx" }]);
		// The failed run is NOT marked archived, so it retries next scan.
		expect(deps.markArchived).toHaveBeenCalledTimes(1);
		expect(deps.markArchived).toHaveBeenCalledWith("good");
	});

	it("dry-run assembles but never writes or marks", async () => {
		const deps = sweepDeps([execution()]);
		const result = await runRunArchiveSweep(deps, { dryRun: true });
		expect(result.dryRun).toBe(true);
		expect(result.archived).toEqual(["exec-1"]);
		expect(deps.putArchive).not.toHaveBeenCalled();
		expect(deps.markArchived).not.toHaveBeenCalled();
	});

	it("clamps the batch limit into bounds", async () => {
		const deps = sweepDeps([]);
		await runRunArchiveSweep(deps, { limit: 100_000 });
		expect(deps.listTerminalUnarchived).toHaveBeenCalledWith(200);
	});
});
