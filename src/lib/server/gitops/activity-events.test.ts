import { describe, expect, it } from "vitest";

import { normalizeGitOpsActivityEvent } from "./activity-events";

describe("normalizeGitOpsActivityEvent", () => {
	it("normalizes Tekton PipelineRun resource events with deterministic ids", () => {
		const first = normalizeGitOpsActivityEvent(samplePipelineRunEvent("cloud-1"));
		const second = normalizeGitOpsActivityEvent(samplePipelineRunEvent("cloud-2"));

		expect(first.eventId).toBe(second.eventId);
		expect(first.source).toBe("tekton");
		expect(first.activityType).toBe("tekton.pipelinerun");
		expect(first.phase).toBe("Succeeded");
		expect(first.resourceRef).toMatchObject({
			group: "tekton.dev",
			resource: "pipelineruns",
			kind: "PipelineRun",
			namespace: "tekton-pipelines",
			name: "outer-loop-workflow-builder-abc",
		});
		expect(first.correlation).toMatchObject({
			pipelineRun: "outer-loop-workflow-builder-abc",
			imageName: "workflow-builder",
			gitSha: "2ee6c88921c55fcb348e42c101e7decb47450b46",
			imageRef:
				"ghcr.io/pittampalliorg/workflow-builder:git-2ee6c88921c55fcb348e42c101e7decb47450b46",
		});
	});

	it("normalizes ArgoCD Application health and sync state", () => {
		const event = normalizeGitOpsActivityEvent({
			raw: {
				context: { time: "2026-06-05T13:00:00Z" },
				data: {
					type: "UPDATE",
					group: "argoproj.io",
					version: "v1alpha1",
					resource: "applications",
					body: {
						apiVersion: "argoproj.io/v1alpha1",
						kind: "Application",
						metadata: {
							name: "dev-workflow-builder",
							namespace: "dev",
							uid: "app-uid",
							resourceVersion: "1001",
						},
						status: {
							sync: { status: "Synced", revision: "abc123" },
							health: { status: "Healthy" },
						},
					},
				},
			},
		});

		expect(event.source).toBe("argocd");
		expect(event.activityType).toBe("argocd.application");
		expect(event.phase).toBe("Healthy");
		expect(event.correlation).toMatchObject({
			argocdApp: "dev-workflow-builder",
			cluster: "dev",
			syncRevision: "abc123",
			syncStatus: "Synced",
			healthStatus: "Healthy",
		});
	});

	it("classifies the hub inventory ConfigMap and trims its data payload", () => {
		const first = normalizeGitOpsActivityEvent(sampleInventoryConfigMapEvent("cloud-1"));
		const second = normalizeGitOpsActivityEvent(sampleInventoryConfigMapEvent("cloud-2"));

		expect(first.source).toBe("inventory");
		expect(first.activityType).toBe("gitops.inventory");
		expect(first.resourceRef).toMatchObject({
			kind: "ConfigMap",
			namespace: "argocd",
			name: "gitops-deployment-inventory",
		});
		// One deterministic event per snapshot revision (resourceVersion).
		expect(first.eventId).toBe(second.eventId);
		// The ConfigMap embeds the whole inventory.json — it must not be persisted.
		expect(JSON.stringify(first.raw)).not.toContain("HUGE_INVENTORY_PAYLOAD");
	});

	it("leaves other ConfigMaps classified as kubernetes.resource", () => {
		const payload = sampleInventoryConfigMapEvent("cloud-3");
		payload.data.body.metadata.name = "gitops-deployment-inventory-scripts";
		const event = normalizeGitOpsActivityEvent(payload);

		expect(event.source).toBe("kubernetes");
		expect(event.activityType).toBe("kubernetes.resource");
	});
});

function sampleInventoryConfigMapEvent(contextId: string) {
	return {
		context: {
			id: contextId,
			source: "gitops-inventory",
			subject: "configmaps",
			time: "2026-06-10T12:00:00Z",
		},
		data: {
			type: "UPDATE",
			group: "",
			version: "v1",
			resource: "configmaps",
			body: {
				apiVersion: "v1",
				kind: "ConfigMap",
				metadata: {
					name: "gitops-deployment-inventory",
					namespace: "argocd",
					uid: "cm-uid",
					resourceVersion: "778001",
				},
				data: { "inventory.json": "HUGE_INVENTORY_PAYLOAD" },
			},
		},
	};
}

function samplePipelineRunEvent(contextId: string) {
	return {
		context: {
			id: contextId,
			source: "gitops-tekton",
			subject: "pipelineruns",
			time: "2026-06-05T12:00:00Z",
		},
		data: {
			type: "UPDATE",
			group: "tekton.dev",
			version: "v1",
			resource: "pipelineruns",
			body: {
				apiVersion: "tekton.dev/v1",
				kind: "PipelineRun",
				metadata: {
					name: "outer-loop-workflow-builder-abc",
					namespace: "tekton-pipelines",
					uid: "pr-uid",
					resourceVersion: "901",
				},
				spec: {
					params: [
						{ name: "image_name", value: "workflow-builder" },
						{
							name: "git_sha",
							value: "2ee6c88921c55fcb348e42c101e7decb47450b46",
						},
					],
				},
				status: {
					conditions: [
						{
							type: "Succeeded",
							status: "True",
							reason: "Succeeded",
							message: "pipeline completed",
							lastTransitionTime: "2026-06-05T12:04:00Z",
						},
					],
					results: [
						{
							name: "image_ref",
							value:
								"ghcr.io/pittampalliorg/workflow-builder:git-2ee6c88921c55fcb348e42c101e7decb47450b46",
						},
					],
				},
			},
		},
	};
}
