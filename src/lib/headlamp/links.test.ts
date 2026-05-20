import { describe, expect, it } from "vitest";

import {
	DEFAULT_HEADLAMP_URL,
	headlampClusterUrl,
	headlampCustomResourceUrl,
	headlampKueueUrl,
	headlampResourceUrl,
	normalizeHeadlampCluster,
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
