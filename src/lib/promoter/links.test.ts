import { describe, expect, it } from "vitest";

import {
	argoCdAppUrl,
	githubBranchUrl,
	githubCommitUrl,
	githubPrUrl,
	giteaBranchUrl,
	repoBrowseUrl,
	tektonRunUrl,
} from "./links";

const bases = {
	stacksRepo: "https://github.com/PittampalliOrg/stacks",
	workflowBuilderRepo: "https://github.com/PittampalliOrg/workflow-builder",
	argoCdBase: "https://argocd-hub.tail286401.ts.net",
	tektonBase: "https://tekton-dashboard-hub.tail286401.ts.net",
};

describe("githubCommitUrl", () => {
	it("builds a commit URL for a repo and SHA", () => {
		expect(githubCommitUrl(bases.stacksRepo, "abc1234")).toBe(
			"https://github.com/PittampalliOrg/stacks/commit/abc1234",
		);
	});

	it("trims trailing slash on repo", () => {
		expect(githubCommitUrl("https://github.com/owner/repo/", "deadbeef")).toBe(
			"https://github.com/owner/repo/commit/deadbeef",
		);
	});

	it("returns null when missing inputs", () => {
		expect(githubCommitUrl(null, "abc")).toBeNull();
		expect(githubCommitUrl("https://x", null)).toBeNull();
	});
});

describe("githubBranchUrl", () => {
	it("URL-encodes branch with slashes", () => {
		expect(githubBranchUrl(bases.stacksRepo, "env/spokes-dev")).toBe(
			"https://github.com/PittampalliOrg/stacks/tree/env%2Fspokes-dev",
		);
	});
});

describe("githubPrUrl", () => {
	it("builds PR URLs for numeric or string IDs", () => {
		expect(githubPrUrl(bases.stacksRepo, 42)).toBe(
			"https://github.com/PittampalliOrg/stacks/pull/42",
		);
		expect(githubPrUrl(bases.stacksRepo, "42")).toBe(
			"https://github.com/PittampalliOrg/stacks/pull/42",
		);
	});

	it("returns null when number is empty", () => {
		expect(githubPrUrl(bases.stacksRepo, "")).toBeNull();
		expect(githubPrUrl(bases.stacksRepo, null)).toBeNull();
	});
});

describe("argoCdAppUrl", () => {
	it("builds an app URL with default argocd namespace", () => {
		expect(argoCdAppUrl({ argoCdBase: bases.argoCdBase }, { name: "dev-workflow-builder" })).toBe(
			"https://argocd-hub.tail286401.ts.net/applications/argocd/dev-workflow-builder",
		);
	});

	it("uses provided namespace when present", () => {
		expect(
			argoCdAppUrl(
				{ argoCdBase: bases.argoCdBase },
				{ name: "guestbook", namespace: "default" },
			),
		).toBe("https://argocd-hub.tail286401.ts.net/applications/default/guestbook");
	});

	it("returns null when bases missing", () => {
		expect(argoCdAppUrl({ argoCdBase: "" }, { name: "x" })).toBeNull();
		expect(argoCdAppUrl({ argoCdBase: bases.argoCdBase }, null)).toBeNull();
	});
});

describe("tektonRunUrl", () => {
	it("builds a tekton dashboard URL", () => {
		expect(tektonRunUrl({ tektonBase: bases.tektonBase }, "outer-loop-build-abc")).toBe(
			"https://tekton-dashboard-hub.tail286401.ts.net/#/namespaces/tekton-pipelines/pipelineruns/outer-loop-build-abc",
		);
	});

	it("returns null when tektonBase missing", () => {
		expect(tektonRunUrl({ tektonBase: null }, "x")).toBeNull();
	});
});

describe("giteaBranchUrl", () => {
	it("builds a Gitea branch URL", () => {
		expect(giteaBranchUrl("https://gitea.example.com/admin/stacks", "env/spokes-dev")).toBe(
			"https://gitea.example.com/admin/stacks/src/branch/env%2Fspokes-dev",
		);
	});
});

describe("repoBrowseUrl", () => {
	it("strips .git suffix", () => {
		expect(repoBrowseUrl("https://github.com/owner/repo.git")).toBe(
			"https://github.com/owner/repo",
		);
	});

	it("translates SSH form to https", () => {
		expect(repoBrowseUrl("git@github.com:owner/repo.git")).toBe(
			"https://github.com/owner/repo",
		);
	});

	it("returns null for empty input", () => {
		expect(repoBrowseUrl(null)).toBeNull();
		expect(repoBrowseUrl("")).toBeNull();
	});
});
