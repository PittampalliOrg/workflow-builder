import { describe, expect, it } from "vitest";
import type { KubeNode, KubePod } from "$lib/server/kube/client";
import {
	estimateSchedulableSandboxCapacity,
	parseCpuMilli,
	parseMemoryBytes,
} from "./sandbox-capacity";

function workerNode(
	name: string,
	allocatable: Record<string, string>,
	labels: Record<string, string> = { "node-role.kubernetes.io/worker": "" },
	conditions: Array<{ type?: string; status?: string }> = [
		{ type: "Ready", status: "True" },
	],
): KubeNode {
	return {
		metadata: { name, labels },
		status: {
			allocatable,
			conditions,
		},
	};
}

function pod(params: {
	name: string;
	nodeName?: string;
	phase?: string;
	cpu?: string;
	memory?: string;
	ephemeralStorage?: string;
	labels?: Record<string, string>;
}): KubePod {
	return {
		metadata: {
			name: params.name,
			namespace: "openshell",
			labels: params.labels ?? {},
		},
		spec: {
			nodeName: params.nodeName,
			containers: [
				{
					name: "sandbox",
					resources: {
						requests: {
							cpu: params.cpu ?? "100m",
							memory: params.memory ?? "256Mi",
							"ephemeral-storage": params.ephemeralStorage ?? "1Gi",
						},
					},
				},
			],
		},
		status: { phase: params.phase ?? "Running" },
	};
}

describe("sandbox scheduler capacity", () => {
	it("parses Kubernetes CPU and memory quantities", () => {
		expect(parseCpuMilli("250m")).toBe(250);
		expect(parseCpuMilli("2")).toBe(2000);
		expect(parseMemoryBytes("256Mi")).toBe(256 * 1024 * 1024);
		expect(parseMemoryBytes("1G")).toBe(1_000_000_000);
	});

	it("derives available sandbox slots from worker allocatable minus requests", () => {
		const snapshot = estimateSchedulableSandboxCapacity({
			now: new Date("2026-05-03T12:00:00Z"),
			nodes: [
				workerNode("worker-a", { cpu: "4000m", memory: "8Gi" }),
				workerNode(
					"control-plane",
					{ cpu: "8000m", memory: "16Gi" },
					{
						"node-role.kubernetes.io/control-plane": "",
					},
				),
			],
			pods: [
				pod({ name: "api", nodeName: "worker-a", cpu: "500m", memory: "1Gi" }),
				pod({
					name: "swebench-run-1-django",
					nodeName: "worker-a",
					cpu: "1000m",
					memory: "2Gi",
				}),
			],
			sandboxRequest: {
				cpuMilli: 1000,
				memoryBytes: 2 * 1024 * 1024 * 1024,
				ephemeralStorageBytes: 8 * 1024 * 1024 * 1024,
			},
		});

		expect(snapshot).toMatchObject({
			nodeCount: 1,
			allocatableCpuMilli: 4000,
			allocatableEphemeralStorageBytes: 0,
			requestedCpuMilli: 1500,
			activeSwebenchPods: 1,
			availableSandboxSlots: 2,
			schedulableSandboxCapacity: 2,
			totalSchedulableSandboxCapacity: 3,
		});
	});

	it("accounts for pending SWE-bench pod requests before admitting more", () => {
		const snapshot = estimateSchedulableSandboxCapacity({
			nodes: [workerNode("worker-a", { cpu: "2000m", memory: "2Gi" })],
			pods: [
				pod({
					name: "swebench-run-1-pending",
					phase: "Pending",
					cpu: "1000m",
					memory: "1Gi",
				}),
			],
			sandboxRequest: {
				cpuMilli: 1000,
				memoryBytes: 1024 * 1024 * 1024,
				ephemeralStorageBytes: 8 * 1024 * 1024 * 1024,
			},
		});

		expect(snapshot).toMatchObject({
			pendingSwebenchPods: 1,
			pendingSwebenchCpuMilli: 1000,
			availableSandboxSlots: 1,
			totalSchedulableSandboxCapacity: 2,
		});
	});

	it("reports zero available slots when requests consume worker headroom", () => {
		const snapshot = estimateSchedulableSandboxCapacity({
			nodes: [workerNode("worker-a", { cpu: "1000m", memory: "1Gi" })],
			pods: [
				pod({
					name: "db",
					nodeName: "worker-a",
					cpu: "1000m",
					memory: "1Gi",
				}),
			],
			sandboxRequest: {
				cpuMilli: 1000,
				memoryBytes: 1024 * 1024 * 1024,
				ephemeralStorageBytes: 8 * 1024 * 1024 * 1024,
			},
		});

		expect(snapshot).toMatchObject({
			availableCpuMilli: 0,
			availableMemoryBytes: 0,
			availableSandboxSlots: 0,
			schedulableSandboxCapacity: 0,
			totalSchedulableSandboxCapacity: 0,
		});
	});

	it("uses ephemeral-storage headroom as a sandbox capacity limiter", () => {
		const snapshot = estimateSchedulableSandboxCapacity({
			nodes: [
				workerNode("worker-a", {
					cpu: "8000m",
					memory: "32Gi",
					"ephemeral-storage": "40Gi",
				}),
			],
			pods: [
				pod({
					name: "swebench-run-1",
					nodeName: "worker-a",
					cpu: "100m",
					memory: "256Mi",
					ephemeralStorage: "16Gi",
				}),
			],
			sandboxRequest: {
				cpuMilli: 100,
				memoryBytes: 256 * 1024 * 1024,
				ephemeralStorageBytes: 8 * 1024 * 1024 * 1024,
			},
		});

		expect(snapshot).toMatchObject({
			allocatableEphemeralStorageBytes: 40 * 1024 * 1024 * 1024,
			requestedEphemeralStorageBytes: 16 * 1024 * 1024 * 1024,
			ephemeralStorageLimitedCapacity: 3,
			availableSandboxSlots: 3,
			schedulableSandboxCapacity: 3,
		});
	});

	it("excludes workers with DiskPressure from schedulable capacity", () => {
		const snapshot = estimateSchedulableSandboxCapacity({
			nodes: [
				workerNode(
					"pressure-worker",
					{ cpu: "8000m", memory: "32Gi", "ephemeral-storage": "200Gi" },
					{ "node-role.kubernetes.io/worker": "" },
					[
						{ type: "Ready", status: "True" },
						{ type: "DiskPressure", status: "True" },
					],
				),
				workerNode("worker-a", {
					cpu: "1000m",
					memory: "1Gi",
					"ephemeral-storage": "10Gi",
				}),
			],
			pods: [],
			sandboxRequest: {
				cpuMilli: 1000,
				memoryBytes: 1024 * 1024 * 1024,
				ephemeralStorageBytes: 8 * 1024 * 1024 * 1024,
			},
		});

		expect(snapshot).toMatchObject({
			nodeCount: 1,
			diskPressureNodeCount: 1,
			availableSandboxSlots: 1,
			schedulableSandboxCapacity: 1,
		});
	});
});
