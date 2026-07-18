import { describe, expect, it } from "vitest";

import type { FleetDriftExtras } from "$lib/types/deployment-metadata";

import {
	buildPreviewPlatformView,
	PREVIEW_PLATFORM_SKEW_REMEDY,
} from "./preview-platform";

const BROKER = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PINNED = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function extras(overrides: Partial<FleetDriftExtras["previewPlatform"]>): FleetDriftExtras {
	return {
		generatedAt: "2026-07-17T00:00:00Z",
		workflowBuilderMainHead: null,
		stacksMainHead: {
			sha: "feedfacefeedfacefeedfacefeedfacefeedface",
			shortSha: "feedface",
			url: "https://github.com/PittampalliOrg/stacks/commit/feedface",
			message: null,
			authorName: null,
			committedAt: null,
		},
		pinAges: [],
		newestBuilt: [],
		previewPlatform: {
			pinRevision: "abc123",
			brokerImageDigest: BROKER,
			releasePinsWorkflowBuilderDigest: PINNED,
			skew: true,
			...overrides,
		},
		liveDeployments: [],
	};
}

describe("buildPreviewPlatformView", () => {
	it("surfaces skew prominently with the cleanup-degradation warning and remedy", () => {
		const view = buildPreviewPlatformView(extras({}));
		expect(view.state).toBe("skew");
		expect(view.detail).toContain("promotion sandbox cleanup may be degraded");
		expect(view.remedy).toBe(PREVIEW_PLATFORM_SKEW_REMEDY);
		expect(view.brokerDigestShort).toMatch(/^sha256:aaaaaaaaaaaa/);
		expect(view.stacksMainShortSha).toBe("feedface");
	});

	it("reports in-sync when both digests match", () => {
		const view = buildPreviewPlatformView(
			extras({ brokerImageDigest: PINNED, skew: false }),
		);
		expect(view.state).toBe("in-sync");
		expect(view.remedy).toBeNull();
	});

	it("degrades to unknown when a digest is missing or extras absent", () => {
		expect(
			buildPreviewPlatformView(extras({ brokerImageDigest: null, skew: false })).state,
		).toBe("unknown");
		const empty = buildPreviewPlatformView(null);
		expect(empty.state).toBe("unknown");
		expect(empty.brokerDigestShort).toBe("—");
	});
});
