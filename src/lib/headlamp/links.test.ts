import { describe, expect, it } from "vitest";

import {
	DEFAULT_HEADLAMP_URL,
	headlampCustomResourceUrl,
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
