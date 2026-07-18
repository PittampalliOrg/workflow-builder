import { describe, expect, it } from "vitest";

import {
	commitShaFromImageTag,
	createGithubSources,
	parseBrokerImageDigest,
	parseReleasePinsYaml,
} from "./github-sources";

const DIGEST = `sha256:${"3".repeat(64)}`;

const BROKER_YAML = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: preview-control-broker
spec:
  template:
    spec:
      initContainers:
        - name: db-migrate
          image: ghcr.io/pittampalliorg/workflow-builder@${DIGEST}
      containers:
        - name: preview-control-broker
          image: ghcr.io/pittampalliorg/workflow-builder@${DIGEST}
`;

const PINS_YAML = `
images:
  workflow-builder: git-abcdef1234567890abcdef1234567890abcdef12
digests:
  workflow-builder: ${DIGEST}
sourceShas:
  workflow-builder: abcdef1234567890abcdef1234567890abcdef12
updatedAts:
  workflow-builder: "2026-07-16T12:00:00Z"
pipelineRuns:
  workflow-builder: build-workflow-builder-xyz
`;

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200 });
}

describe("parseBrokerImageDigest", () => {
	it("extracts the workflow-builder digest from the Deployment YAML", () => {
		expect(parseBrokerImageDigest(BROKER_YAML)).toBe(DIGEST);
	});
	it("returns null when no digest-pinned image exists", () => {
		expect(parseBrokerImageDigest("image: ghcr.io/o/workflow-builder:tag")).toBeNull();
	});
});

describe("parseReleasePinsYaml", () => {
	it("builds the per-service pin map", () => {
		expect(parseReleasePinsYaml(PINS_YAML)).toEqual({
			"workflow-builder": {
				tag: "git-abcdef1234567890abcdef1234567890abcdef12",
				digest: DIGEST,
				commitSha: "abcdef1234567890abcdef1234567890abcdef12",
				updatedAt: "2026-07-16T12:00:00Z",
				pipelineRun: "build-workflow-builder-xyz",
			},
		});
	});
	it("falls back to the git- tag for the commit sha", () => {
		expect(commitShaFromImageTag("git-ABCDEF1")).toBe("abcdef1");
		expect(commitShaFromImageTag("v1.2.3")).toBeNull();
	});
});

describe("createGithubSources caching", () => {
	it("caches and dedupes raw fetches for the TTL, then refetches", async () => {
		const calls: string[] = [];
		let clock = 0;
		const sources = createGithubSources({
			now: () => clock,
			ttlMs: 60_000,
			fetchImpl: async (url) => {
				calls.push(url);
				if (url.includes("Deployment-preview-control-broker")) {
					return new Response(BROKER_YAML, { status: 200 });
				}
				if (url.includes("release-pins")) {
					return new Response(PINS_YAML, { status: 200 });
				}
				return jsonResponse({
					sha: "1234567890123456789012345678901234567890",
					html_url: "https://github.com/x",
					commit: { message: "head", committer: { date: "2026-07-17T00:00:00Z" } },
				});
			},
		});

		const [first, second] = await Promise.all([
			sources.getBrokerImage(),
			sources.getBrokerImage(),
		]);
		expect(first.digest).toBe(DIGEST);
		expect(second.digest).toBe(DIGEST);
		await sources.getBrokerImage();
		expect(calls).toHaveLength(1);

		clock = 60_001;
		await sources.getBrokerImage();
		expect(calls).toHaveLength(2);

		const head = await sources.getMainHead("workflow-builder");
		expect(head?.sha).toBe("1234567890123456789012345678901234567890");
		await sources.getMainHead("workflow-builder");
		expect(calls).toHaveLength(3);
	});

	it("degrades to an error-shaped snapshot and keeps the stale value on refetch failure", async () => {
		let fail = false;
		let clock = 0;
		const sources = createGithubSources({
			now: () => clock,
			ttlMs: 60_000,
			fetchImpl: async () => {
				if (fail) throw new Error("network down");
				return new Response(PINS_YAML, { status: 200 });
			},
		});

		const good = await sources.getReleasePins();
		expect(good.error).toBeNull();
		expect(good.services["workflow-builder"]?.digest).toBe(DIGEST);

		fail = true;
		clock = 60_001;
		const degraded = await sources.getReleasePins();
		expect(degraded.error).toContain("network down");
		// Stale pins survive the failed refresh.
		expect(degraded.services["workflow-builder"]?.digest).toBe(DIGEST);
	});
});
