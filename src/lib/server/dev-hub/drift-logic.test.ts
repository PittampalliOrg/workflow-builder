import { describe, expect, it } from "vitest";

import type {
	PreviewPromotionReceiptSummary,
	VclusterPreviewSummary,
} from "$lib/types/dev-previews";
import {
	buildPreviewDriftOverview,
	deriveDriftStatus,
	derivePreviewStage,
	splitImageRef,
	type RuntimeObservation,
} from "./drift-logic";

const PIN_DIGEST = `sha256:${"a".repeat(64)}`;
const OLD_DIGEST = `sha256:${"b".repeat(64)}`;
const MAIN_SHA = "1111111111111111111111111111111111111111";
const OLD_SHA = "2222222222222222222222222222222222222222";

const NO_HISTORY = {
	knownPinTags: new Set<string>(),
	knownPinDigests: new Set<string>(),
};

describe("splitImageRef", () => {
	it("separates tag and digest", () => {
		expect(
			splitImageRef(`ghcr.io/o/workflow-builder:git-abc@${PIN_DIGEST}`),
		).toEqual({ tag: "git-abc", digest: PIN_DIGEST });
	});
	it("does not treat a registry port as a tag", () => {
		expect(splitImageRef("registry:5000/o/svc")).toEqual({
			tag: null,
			digest: null,
		});
	});
});

describe("deriveDriftStatus", () => {
	const pin = {
		tag: `git-${MAIN_SHA}`,
		digest: PIN_DIGEST,
		commitSha: MAIN_SHA,
	};

	it("unknown when there is no running image", () => {
		expect(
			deriveDriftStatus({ running: null, pin, mainHeadSha: MAIN_SHA, ...NO_HISTORY }),
		).toBe("unknown");
	});

	it("unknown when there is no pin for the service", () => {
		expect(
			deriveDriftStatus({
				running: { tag: "git-abc", digest: null },
				pin: null,
				mainHeadSha: MAIN_SHA,
				...NO_HISTORY,
			}),
		).toBe("unknown");
	});

	it("unknown when neither digests nor tags are comparable", () => {
		expect(
			deriveDriftStatus({
				running: { tag: null, digest: OLD_DIGEST },
				pin: { tag: "git-x", digest: null, commitSha: null },
				mainHeadSha: null,
				...NO_HISTORY,
			}),
		).toBe("unknown");
	});

	it("in-sync when digests match and the pin is at main HEAD", () => {
		expect(
			deriveDriftStatus({
				running: { tag: "whatever", digest: PIN_DIGEST },
				pin,
				mainHeadSha: MAIN_SHA,
				...NO_HISTORY,
			}),
		).toBe("in-sync");
	});

	it("in-sync via tag match when digests are unavailable", () => {
		expect(
			deriveDriftStatus({
				running: { tag: `git-${MAIN_SHA}`, digest: null },
				pin: { ...pin, digest: null },
				mainHeadSha: MAIN_SHA,
				...NO_HISTORY,
			}),
		).toBe("in-sync");
	});

	it("in-sync when main HEAD is unknown", () => {
		expect(
			deriveDriftStatus({
				running: { tag: null, digest: PIN_DIGEST },
				pin,
				mainHeadSha: null,
				...NO_HISTORY,
			}),
		).toBe("in-sync");
	});

	it("pin-behind-main when running matches an out-of-date pin", () => {
		expect(
			deriveDriftStatus({
				running: { tag: null, digest: PIN_DIGEST },
				pin: { ...pin, commitSha: OLD_SHA },
				mainHeadSha: MAIN_SHA,
				...NO_HISTORY,
			}),
		).toBe("pin-behind-main");
	});

	it("pin-behind-main tolerates short-sha pins", () => {
		expect(
			deriveDriftStatus({
				running: { tag: null, digest: PIN_DIGEST },
				pin: { ...pin, commitSha: MAIN_SHA.slice(0, 8) },
				mainHeadSha: MAIN_SHA,
				...NO_HISTORY,
			}),
		).toBe("in-sync");
	});

	it("behind-pin when the running tag is a known historical pin", () => {
		expect(
			deriveDriftStatus({
				running: { tag: `git-${OLD_SHA}`, digest: OLD_DIGEST },
				pin,
				mainHeadSha: MAIN_SHA,
				knownPinTags: new Set([`git-${OLD_SHA}`]),
				knownPinDigests: new Set<string>(),
			}),
		).toBe("behind-pin");
	});

	it("behind-pin when the running digest is a known historical pin digest", () => {
		expect(
			deriveDriftStatus({
				running: { tag: null, digest: OLD_DIGEST },
				pin,
				mainHeadSha: MAIN_SHA,
				knownPinTags: new Set<string>(),
				knownPinDigests: new Set([OLD_DIGEST]),
			}),
		).toBe("behind-pin");
	});

	it("diverged when the running image is not any known pin", () => {
		expect(
			deriveDriftStatus({
				running: { tag: "candidate-123", digest: OLD_DIGEST },
				pin,
				mainHeadSha: MAIN_SHA,
				knownPinTags: new Set([`git-${OLD_SHA}`]),
				knownPinDigests: new Set<string>(),
			}),
		).toBe("diverged");
	});
});

describe("derivePreviewStage", () => {
	const base = {
		phase: "ready",
		state: "hot" as const,
		lifecycle: "ephemeral" as const,
		hasReceipts: false,
		hasActiveSandboxes: false,
	};

	it.each([
		[{ ...base, phase: "failed", hasReceipts: true }, "failed"],
		[{ ...base, state: "slept" as const, hasActiveSandboxes: true }, "sleeping"],
		[{ ...base, phase: "provisioning" }, "provisioning"],
		[{ ...base, phase: "pending" }, "provisioning"],
		[{ ...base, phase: "claiming" }, "provisioning"],
		[{ ...base, hasActiveSandboxes: true, hasReceipts: true }, "agent-editing"],
		[{ ...base, hasReceipts: true, lifecycle: "retained" as const }, "promoted"],
		[{ ...base, lifecycle: "retained" as const }, "retained"],
		[base, "ready"],
	])("derives %j -> %s", (input, expected) => {
		expect(derivePreviewStage(input)).toBe(expected);
	});
});

function preview(
	overrides: Partial<VclusterPreviewSummary> = {},
): VclusterPreviewSummary {
	return {
		name: "pv-1",
		phase: "ready",
		ready: true,
		url: "https://wfb-pv-1.tail.example",
		targetCluster: "dev",
		pool: null,
		state: "hot",
		lifecycle: "retained",
		origin: null,
		legacyOrigin: null,
		prNumber: null,
		expiresAt: null,
		lastActive: null,
		protected: false,
		bootSeconds: null,
		platformRevision: null,
		sourceRevision: null,
		profile: "app-live",
		lane: "application",
		mode: "live",
		owner: { kind: "workflow", id: "exec-1" },
		services: ["workflow-builder"],
		provenance: null,
		trustedCode: true,
		allocation: null,
		images: null,
		catalogDigest: null,
		prUrl: null,
		...overrides,
	};
}

describe("buildPreviewDriftOverview", () => {
	const receipts: PreviewPromotionReceiptSummary[] = [
		{
			prNumber: 42,
			prUrl: "https://github.com/o/r/pull/42",
			commitSha: MAIN_SHA,
			createdAt: "2026-07-16T00:00:00.000Z",
		},
	];

	it("joins runtime, pins, receipts, and stage per preview", () => {
		const runtime: RuntimeObservation = {
			ok: true,
			view: {
				name: "pv-1",
				reconciliationSucceeded: true,
				provision: { found: true, active: false, succeeded: true, failed: false },
				services: [
					{
						service: "workflow-builder",
						containers: [
							{ image: `ghcr.io/o/workflow-builder@${PIN_DIGEST}`, ready: true },
						],
					},
				],
			},
		};
		const overview = buildPreviewDriftOverview({
			previews: [preview()],
			runtimeByPreview: new Map([["pv-1", runtime]]),
			pinsByService: new Map([
				[
					"workflow-builder",
					{ tag: `git-${MAIN_SHA}`, digest: PIN_DIGEST, commitSha: MAIN_SHA },
				],
			]),
			pinHistoryByService: new Map(),
			receiptsByPreview: new Map([["pv-1", receipts]]),
			receiptExecutionIdsByPreview: new Map([["pv-1", ["exec-1"]]]),
			activeSandboxExecutionIds: new Set<string>(),
			workflowBuilderMainSha: MAIN_SHA,
			stacksMainSha: OLD_SHA,
		});

		expect(overview.repoHeads).toEqual({
			workflowBuilderMainSha: MAIN_SHA,
			stacksMainSha: OLD_SHA,
		});
		expect(overview.previews).toHaveLength(1);
		const entry = overview.previews[0];
		expect(entry.stage).toBe("promoted");
		expect(entry.receipts).toEqual(receipts);
		expect(entry.services).toEqual([
			{
				service: "workflow-builder",
				running: {
					image: `ghcr.io/o/workflow-builder@${PIN_DIGEST}`,
					tag: null,
					digest: PIN_DIGEST,
					ready: true,
				},
				runningUnavailableReason: null,
				pin: { tag: `git-${MAIN_SHA}`, digest: PIN_DIGEST, commitSha: MAIN_SHA },
				driftStatus: "in-sync",
			},
		]);
	});

	it("marks slept previews' services unavailable with the reason", () => {
		const overview = buildPreviewDriftOverview({
			previews: [preview({ state: "slept", phase: "slept" })],
			runtimeByPreview: new Map([["pv-1", { ok: false, reason: "slept" }]]),
			pinsByService: new Map(),
			pinHistoryByService: new Map(),
			receiptsByPreview: new Map(),
			activeSandboxExecutionIds: new Set<string>(),
			workflowBuilderMainSha: null,
			stacksMainSha: null,
		});
		const entry = overview.previews[0];
		expect(entry.stage).toBe("sleeping");
		expect(entry.services[0]).toMatchObject({
			running: null,
			runningUnavailableReason: "slept",
			driftStatus: "unknown",
		});
	});

	it("links active sandboxes through the owner execution id", () => {
		const overview = buildPreviewDriftOverview({
			previews: [preview()],
			runtimeByPreview: new Map(),
			pinsByService: new Map(),
			pinHistoryByService: new Map(),
			receiptsByPreview: new Map(),
			activeSandboxExecutionIds: new Set(["exec-1"]),
			workflowBuilderMainSha: null,
			stacksMainSha: null,
		});
		expect(overview.previews[0].stage).toBe("agent-editing");
	});

	it("surfaces runtime services missing from the declared list", () => {
		const runtime: RuntimeObservation = {
			ok: true,
			view: {
				name: "pv-1",
				reconciliationSucceeded: true,
				provision: { found: true, active: false, succeeded: true, failed: false },
				services: [
					{
						service: "workflow-orchestrator",
						containers: [{ image: "ghcr.io/o/workflow-orchestrator:git-x", ready: false }],
					},
				],
			},
		};
		const overview = buildPreviewDriftOverview({
			previews: [preview({ services: ["workflow-builder"] })],
			runtimeByPreview: new Map([["pv-1", runtime]]),
			pinsByService: new Map(),
			pinHistoryByService: new Map(),
			receiptsByPreview: new Map(),
			activeSandboxExecutionIds: new Set<string>(),
			workflowBuilderMainSha: null,
			stacksMainSha: null,
		});
		expect(overview.previews[0].services.map((s) => s.service)).toEqual([
			"workflow-builder",
			"workflow-orchestrator",
		]);
	});
});
