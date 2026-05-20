import { describe, expect, it } from "vitest";

import {
	DEFAULT_HEADLAMP_URL,
	embeddedHeadlampClusterUrl,
	embeddedHeadlampKueueUrl,
	embeddedHeadlampResourceUrl,
	headlampClusterUrl,
	headlampCustomResourceUrl,
	headlampEmbedSrc,
	headlampExternalUrl,
	headlampKueueUrl,
	headlampResourceUrl,
	normalizeEmbeddedHeadlampPath,
	normalizeHeadlampCluster,
	withHeadlampEmbedChrome,
} from "./links";

describe("headlampResourceUrl", () => {
	it("builds cluster-scoped workload URLs", () => {
		expect(
			headlampResourceUrl({
				cluster: "ryzen",
				kind: "Deployment",
				namespace: "workflow-builder",
				name: "workflow-builder",
			}),
		).toBe(
			`${DEFAULT_HEADLAMP_URL}/c/ryzen/deployments/workflow-builder/workflow-builder`,
		);
	});

	it("maps supported workload kinds", () => {
		expect(
			headlampResourceUrl({
				headlampBase: "https://headlamp.example/",
				cluster: "dev",
				kind: "Job",
				namespace: "workflow-builder",
				name: "swebench-eval",
			}),
		).toBe("https://headlamp.example/c/dev/jobs/workflow-builder/swebench-eval");
		expect(
			headlampResourceUrl({
				cluster: "staging",
				kind: "ReplicaSet",
				namespace: "workflow-builder",
				name: "workflow-builder-abc",
			}),
		).toBe(
			`${DEFAULT_HEADLAMP_URL}/c/staging/replicasets/workflow-builder/workflow-builder-abc`,
		);
	});

	it("encodes namespace and name path segments", () => {
		expect(
			headlampResourceUrl({
				cluster: "hub",
				kind: "Pod",
				namespace: "tekton pipelines",
				name: "build/run",
			}),
		).toBe(`${DEFAULT_HEADLAMP_URL}/c/hub/pods/tekton%20pipelines/build%2Frun`);
	});

	it("adds log view only for workload log routes", () => {
		expect(
			headlampResourceUrl({
				cluster: "ryzen",
				kind: "Job",
				namespace: "workflow-builder",
				name: "eval",
				logs: true,
			}),
		).toBe(`${DEFAULT_HEADLAMP_URL}/c/ryzen/jobs/workflow-builder/eval?view=logs`);
		expect(
			headlampResourceUrl({
				cluster: "ryzen",
				kind: "Pod",
				namespace: "workflow-builder",
				name: "pod-1",
				logs: true,
			}),
		).toBe(`${DEFAULT_HEADLAMP_URL}/c/ryzen/pods/workflow-builder/pod-1`);
	});
});

describe("embedded Headlamp URLs", () => {
	it("wraps Headlamp resource paths in the workspace Kubernetes route", () => {
		expect(
			embeddedHeadlampResourceUrl({
				workspaceSlug: "default-project",
				cluster: "ryzen",
				kind: "Deployment",
				namespace: "workflow-builder",
				name: "workflow-builder",
			}),
		).toBe(
			"/workspaces/default-project/kubernetes?path=%2Fc%2Fryzen%2Fdeployments%2Fworkflow-builder%2Fworkflow-builder",
		);
	});

	it("preserves Headlamp query strings inside the path parameter", () => {
		expect(
			embeddedHeadlampResourceUrl({
				workspaceSlug: "default-project",
				cluster: "dev",
				kind: "Job",
				namespace: "workflow-builder",
				name: "eval",
				logs: true,
			}),
		).toBe(
			"/workspaces/default-project/kubernetes?path=%2Fc%2Fdev%2Fjobs%2Fworkflow-builder%2Feval%3Fview%3Dlogs",
		);
	});

	it("builds embedded Pod, Kueue, and cluster links used by Workflow Builder surfaces", () => {
		expect(
			embeddedHeadlampResourceUrl({
				workspaceSlug: "ops",
				cluster: "ryzen",
				kind: "Pod",
				namespace: "workflow-builder",
				name: "runtime-pod",
			}),
		).toBe(
			"/workspaces/ops/kubernetes?path=%2Fc%2Fryzen%2Fpods%2Fworkflow-builder%2Fruntime-pod",
		);
		expect(
			embeddedHeadlampKueueUrl({
				workspaceSlug: "ops",
				cluster: "ryzen",
				kind: "Workload",
				namespace: "workflow-builder",
				name: "agent-run",
			}),
		).toBe(
			"/workspaces/ops/kubernetes?path=%2Fc%2Fryzen%2Fcustomresources%2Fworkloads.kueue.x-k8s.io%2Fworkflow-builder%2Fagent-run",
		);
		expect(
			embeddedHeadlampKueueUrl({
				workspaceSlug: "ops",
				cluster: "ryzen",
				kind: "ClusterQueue",
				name: "interactive-agent",
			}),
		).toBe(
			"/workspaces/ops/kubernetes?path=%2Fc%2Fryzen%2Fcustomresources%2Fclusterqueues.kueue.x-k8s.io%2F-%2Finteractive-agent",
		);
		expect(
			embeddedHeadlampKueueUrl({
				workspaceSlug: "ops",
				cluster: "ryzen",
				kind: "ResourceFlavor",
				name: "ryzen-workers",
			}),
		).toBe(
			"/workspaces/ops/kubernetes?path=%2Fc%2Fryzen%2Fcustomresources%2Fresourceflavors.kueue.x-k8s.io%2F-%2Fryzen-workers",
		);
		expect(embeddedHeadlampClusterUrl({ workspaceSlug: "ops", cluster: "hub" })).toBe(
			"/workspaces/ops/kubernetes?path=%2Fc%2Fhub%2F",
		);
	});
});

describe("Headlamp path normalization", () => {
	it("accepts cluster-scoped Headlamp paths and strips the embed base", () => {
		expect(normalizeEmbeddedHeadlampPath("/c/ryzen/pods/workflow-builder/pod-1")).toBe(
			"/c/ryzen/pods/workflow-builder/pod-1",
		);
		expect(normalizeEmbeddedHeadlampPath("/headlamp/c/dev/")).toBe("/c/dev/");
		expect(
			normalizeEmbeddedHeadlampPath(
				"https://headlamp-hub.tail286401.ts.net/headlamp/c/staging/?drawer=events",
			),
		).toBe("/c/staging/?drawer=events");
	});

	it("normalizes invalid embedded paths to the cluster index", () => {
		expect(normalizeEmbeddedHeadlampPath("/api/private")).toBe("/");
		expect(normalizeEmbeddedHeadlampPath("//evil.example/c/ryzen")).toBe("/");
		expect(normalizeEmbeddedHeadlampPath("/c/prod/pods/default/x")).toBe("/");
	});

	it("builds iframe and external URLs from normalized paths", () => {
		expect(headlampEmbedSrc({ path: "/c/ryzen/" })).toBe("/headlamp/c/ryzen/");
		expect(headlampEmbedSrc({ embedBase: "/embedded/", path: "/headlamp/c/dev/" })).toBe(
			"/embedded/c/dev/",
		);
		expect(headlampExternalUrl({ path: "/headlamp/c/ryzen/" })).toBe(
			`${DEFAULT_HEADLAMP_URL}/c/ryzen/`,
		);
	});

	it("adds and strips embed-only chrome state", () => {
		expect(
			withHeadlampEmbedChrome({
				src: "/headlamp/c/dev/jobs/workflow-builder/eval?view=logs",
				chrome: "unified",
			}),
		).toBe("/headlamp/c/dev/jobs/workflow-builder/eval?view=logs&wb_chrome=unified");
		expect(normalizeEmbeddedHeadlampPath("/headlamp/c/dev/?view=logs&wb_chrome=unified")).toBe(
			"/c/dev/?view=logs",
		);
	});
});

describe("headlampCustomResourceUrl", () => {
	it("builds custom resource detail URLs", () => {
		expect(
			headlampCustomResourceUrl({
				cluster: "ryzen",
				crd: "sandboxwarmpools.extensions.agents.x-k8s.io",
				namespace: "workflow-builder",
				name: "agent-runtime-browser",
			}),
		).toBe(
			`${DEFAULT_HEADLAMP_URL}/c/ryzen/customresources/sandboxwarmpools.extensions.agents.x-k8s.io/workflow-builder/agent-runtime-browser`,
		);
	});
});

describe("headlampKueueUrl", () => {
	it("uses '-' namespace for cluster-scoped Kueue CRs", () => {
		expect(
			headlampKueueUrl({
				cluster: "ryzen",
				kind: "ClusterQueue",
				name: "interactive-agent",
			}),
		).toBe(
			`${DEFAULT_HEADLAMP_URL}/c/ryzen/customresources/clusterqueues.kueue.x-k8s.io/-/interactive-agent`,
		);
		expect(
			headlampKueueUrl({
				cluster: "ryzen",
				kind: "ResourceFlavor",
				name: "dev-benchmark",
			}),
		).toBe(
			`${DEFAULT_HEADLAMP_URL}/c/ryzen/customresources/resourceflavors.kueue.x-k8s.io/-/dev-benchmark`,
		);
		expect(
			headlampKueueUrl({
				cluster: "ryzen",
				kind: "Cohort",
				name: "agent-platform",
			}),
		).toBe(
			`${DEFAULT_HEADLAMP_URL}/c/ryzen/customresources/cohorts.kueue.x-k8s.io/-/agent-platform`,
		);
	});

	it("requires a namespace for namespaced Kueue CRs", () => {
		expect(
			headlampKueueUrl({
				cluster: "ryzen",
				kind: "Workload",
				namespace: "workflow-builder",
				name: "job-abc-12345",
			}),
		).toBe(
			`${DEFAULT_HEADLAMP_URL}/c/ryzen/customresources/workloads.kueue.x-k8s.io/workflow-builder/job-abc-12345`,
		);
		expect(
			headlampKueueUrl({
				cluster: "ryzen",
				kind: "LocalQueue",
				namespace: "workflow-builder",
				name: "default-queue",
			}),
		).toBe(
			`${DEFAULT_HEADLAMP_URL}/c/ryzen/customresources/localqueues.kueue.x-k8s.io/workflow-builder/default-queue`,
		);
		expect(
			headlampKueueUrl({
				cluster: "ryzen",
				kind: "Workload",
				namespace: null,
				name: "lonely",
			}),
		).toBeNull();
	});
});

describe("headlampClusterUrl", () => {
	it("builds the cluster index URL", () => {
		expect(headlampClusterUrl({ cluster: "ryzen" })).toBe(
			`${DEFAULT_HEADLAMP_URL}/c/ryzen/`,
		);
		expect(
			headlampClusterUrl({
				headlampBase: "https://headlamp.example/",
				cluster: "dev",
			}),
		).toBe("https://headlamp.example/c/dev/");
	});
});

describe("normalizeHeadlampCluster", () => {
	it("accepts known Headlamp kubeconfig contexts", () => {
		expect(normalizeHeadlampCluster("hub")).toBe("hub");
		expect(normalizeHeadlampCluster("dev")).toBe("dev");
		expect(normalizeHeadlampCluster("staging")).toBe("staging");
		expect(normalizeHeadlampCluster("ryzen")).toBe("ryzen");
	});

	it("falls back to ryzen for unknown local contexts", () => {
		expect(normalizeHeadlampCluster("admin@ryzen")).toBe("ryzen");
		expect(normalizeHeadlampCluster("")).toBe("ryzen");
	});
});
