import { describe, expect, it } from "vitest";
import type { KubeNode, KubePod } from "$lib/server/kube/client";
import {
	estimateSchedulableSandboxCapacity,
	kueueCapacityFromClusterQueue,
	kueueInstanceResourceProfileFromEnv,
	kueueInstancePodCountFromEnv,
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
	namespace?: string;
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
			namespace: params.namespace ?? "openshell",
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

	it("does not count non-sandbox SWE-bench controller pods as active sandboxes", () => {
		const snapshot = estimateSchedulableSandboxCapacity({
			nodes: [workerNode("worker-a", { cpu: "2000m", memory: "2Gi" })],
			pods: [
				{
					...pod({
						name: "swebench-coordinator-abc",
						nodeName: "worker-a",
						cpu: "500m",
						memory: "256Mi",
					}),
					metadata: {
						name: "swebench-coordinator-abc",
						namespace: "workflow-builder",
						labels: {},
					},
				},
				pod({
					name: "swebench-instance-1",
					nodeName: "worker-a",
					cpu: "500m",
					memory: "256Mi",
					labels: { "agents.x-k8s.io/workload": "swebench" },
				}),
			],
			sandboxRequest: {
				cpuMilli: 500,
				memoryBytes: 256 * 1024 * 1024,
				ephemeralStorageBytes: 8 * 1024 * 1024 * 1024,
			},
		});

		expect(snapshot).toMatchObject({
			activeSwebenchPods: 1,
		});
	});

	it("counts host execution benchmark pods as active sandboxes", () => {
		const snapshot = estimateSchedulableSandboxCapacity({
			nodes: [workerNode("worker-a", { cpu: "2000m", memory: "2Gi" })],
			pods: [
				pod({
					name: "sandbox-run-1-django",
					namespace: "workflow-builder",
					nodeName: "worker-a",
					cpu: "500m",
					memory: "256Mi",
					labels: {
						app: "sandbox-execution-worker",
						"benchmark-run-id": "run-1",
						"sandbox-execution-class": "benchmark-fast",
					},
				}),
			],
			sandboxRequest: {
				cpuMilli: 500,
				memoryBytes: 256 * 1024 * 1024,
				ephemeralStorageBytes: 8 * 1024 * 1024 * 1024,
			},
		});

		expect(snapshot).toMatchObject({
			activeSwebenchPods: 1,
			totalSchedulableSandboxCapacity: 4,
		});
	});

	it("counts pending host execution benchmark pods before admitting more", () => {
		const snapshot = estimateSchedulableSandboxCapacity({
			nodes: [workerNode("worker-a", { cpu: "2000m", memory: "2Gi" })],
			pods: [
				pod({
					name: "sandbox-run-1-django",
					namespace: "workflow-builder",
					phase: "Pending",
					cpu: "500m",
					memory: "256Mi",
					labels: {
						app: "sandbox-execution-worker",
						"benchmark-run-id": "run-1",
						"sandbox-execution-class": "benchmark-fast",
					},
				}),
			],
			sandboxRequest: {
				cpuMilli: 500,
				memoryBytes: 256 * 1024 * 1024,
				ephemeralStorageBytes: 8 * 1024 * 1024 * 1024,
			},
		});

		expect(snapshot).toMatchObject({
			pendingSwebenchPods: 1,
			pendingSwebenchCpuMilli: 500,
			totalSchedulableSandboxCapacity: 4,
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

	it("uses live node filesystem headroom as a sandbox capacity limiter", () => {
		const snapshot = estimateSchedulableSandboxCapacity({
			nodes: [
				workerNode("worker-a", {
					cpu: "8000m",
					memory: "32Gi",
					"ephemeral-storage": "200Gi",
				}),
			],
			pods: [],
			nodeStorageStats: new Map([
				[
					"worker-a",
					{
						availableBytes: 50 * 1024 * 1024 * 1024,
						capacityBytes: 200 * 1024 * 1024 * 1024,
					},
				],
			]),
			sandboxRequest: {
				cpuMilli: 100,
				memoryBytes: 256 * 1024 * 1024,
				ephemeralStorageBytes: 8 * 1024 * 1024 * 1024,
			},
		});

		expect(snapshot).toMatchObject({
			nodeFsAvailableBytes: 26 * 1024 * 1024 * 1024,
			nodeFsEvictionReserveBytes: 24 * 1024 * 1024 * 1024,
			nodeFsLimitedCapacity: 3,
			availableSandboxSlots: 3,
			schedulableSandboxCapacity: 3,
		});
	});

	it("uses Kueue cluster queue quota as a sandbox capacity limiter", () => {
		const kueueCapacity = kueueCapacityFromClusterQueue(
			{
				metadata: { name: "benchmark-fast" },
				spec: {
					resourceGroups: [
						{
							flavors: [
								{
									name: "dev-benchmark",
									resources: [
										{ name: "cpu", nominalQuota: "72", borrowingLimit: "12" },
										{ name: "memory", nominalQuota: "160Gi" },
										{ name: "ephemeral-storage", nominalQuota: "1536Gi" },
										{ name: "pods", nominalQuota: "384" },
									],
								},
							],
						},
					],
				},
				status: {
					conditions: [
						{
							type: "Active",
							status: "True",
							reason: "Ready",
							message: "Can admit new workloads",
						},
					],
					flavorsUsage: [
						{
							name: "dev-benchmark",
							resources: [
								{ name: "cpu", total: "42" },
								{ name: "memory", total: "42Gi" },
								{ name: "ephemeral-storage", total: "672Gi" },
								{ name: "pods", total: "168" },
							],
						},
					],
				},
			},
			{
				cpuMilli: 250,
				memoryBytes: 256 * 1024 * 1024,
				ephemeralStorageBytes: 4 * 1024 * 1024 * 1024,
			},
		);
		const snapshot = estimateSchedulableSandboxCapacity({
			nodes: [
				workerNode("worker-a", {
					cpu: "64000m",
					memory: "256Gi",
					"ephemeral-storage": "2Ti",
				}),
			],
			pods: [],
			kueueCapacity,
			sandboxRequest: {
				cpuMilli: 250,
				memoryBytes: 256 * 1024 * 1024,
				ephemeralStorageBytes: 4 * 1024 * 1024 * 1024,
			},
		});

		expect(snapshot).toMatchObject({
			kueueClusterQueueName: "benchmark-fast",
			kueueClusterQueueActive: true,
			kueueClusterQueueReason: "Ready",
			kueueCpuLimitedCapacity: 120,
			kueueEphemeralStorageLimitedCapacity: 216,
			kueuePodLimitedCapacity: 216,
			kueueAvailableSandboxSlots: 120,
			kueueBorrowAvailableSandboxSlots: 168,
			availableSandboxSlots: 120,
			schedulableSandboxCapacity: 120,
		});
	});

	it("extracts inactive Kueue cluster queue admission health", () => {
		const kueueCapacity = kueueCapacityFromClusterQueue(
			{
				metadata: { name: "benchmark-fast" },
				spec: {
					resourceGroups: [
						{
							flavors: [
								{
									name: "dev-benchmark",
									resources: [
										{ name: "cpu", nominalQuota: "8" },
										{ name: "memory", nominalQuota: "18Gi" },
										{ name: "ephemeral-storage", nominalQuota: "96Gi" },
										{ name: "pods", nominalQuota: "32" },
									],
								},
							],
						},
					],
				},
				status: {
					conditions: [
						{
							type: "Active",
							status: "False",
							reason: "AdmissionCheckInactive",
							message:
								"Can't admit new workloads: references inactive AdmissionCheck(s): psi-memory-pressure.",
						},
					],
				},
			},
			{
				cpuMilli: 100,
				memoryBytes: 256 * 1024 * 1024,
				ephemeralStorageBytes: 1024 * 1024 * 1024,
			},
		);

		expect(kueueCapacity).toMatchObject({
			clusterQueueName: "benchmark-fast",
			clusterQueueActive: false,
			clusterQueueReason: "AdmissionCheckInactive",
			clusterQueueMessage:
				"Can't admit new workloads: references inactive AdmissionCheck(s): psi-memory-pressure.",
		});
	});

	it("reports Kueue full-instance capacity for sandbox, worker, and agent host jobs", () => {
		const sandboxRequest = {
			cpuMilli: 250,
			memoryBytes: 256 * 1024 * 1024,
			ephemeralStorageBytes: 4 * 1024 * 1024 * 1024,
		};
		const instanceRequest = {
			cpuMilli: 600,
			memoryBytes: 1536 * 1024 * 1024,
			ephemeralStorageBytes: 9 * 1024 * 1024 * 1024,
		};
		const kueueCapacity = kueueCapacityFromClusterQueue(
			{
				metadata: { name: "benchmark-fast" },
				spec: {
					resourceGroups: [
						{
							flavors: [
								{
									name: "dev-benchmark",
									resources: [
										{ name: "cpu", nominalQuota: "84" },
										{ name: "memory", nominalQuota: "160Gi" },
										{ name: "ephemeral-storage", nominalQuota: "1536Gi" },
										{ name: "pods", nominalQuota: "384" },
									],
								},
							],
						},
					],
				},
				status: {
					flavorsUsage: [
						{
							name: "dev-benchmark",
							resources: [
								{ name: "cpu", total: "0" },
								{ name: "memory", total: "0" },
								{ name: "ephemeral-storage", total: "0" },
								{ name: "pods", total: "0" },
							],
						},
					],
				},
			},
			sandboxRequest,
			{ instanceRequest, instancePodCount: 3 },
		);
		const snapshot = estimateSchedulableSandboxCapacity({
			nodes: [
				workerNode("worker-a", {
					cpu: "96000m",
					memory: "256Gi",
					"ephemeral-storage": "2Ti",
				}),
			],
			pods: [],
			kueueCapacity,
			sandboxRequest,
			kueueInstanceRequest: instanceRequest,
		});

		expect(snapshot).toMatchObject({
			kueueAvailableSandboxSlots: 336,
			kueueAvailableInstanceSlots: 106,
			kueueInstanceCpuLimitedCapacity: 140,
			kueueInstanceMemoryLimitedCapacity: 106,
			kueueInstanceEphemeralStorageLimitedCapacity: 170,
			kueueInstancePodLimitedCapacity: 128,
			schedulableKueueInstanceCapacity: 106,
		});
	});

	it("defaults Kueue full-instance request to the live OpenShell pod shape", () => {
		const previous = {
			BENCHMARK_EXECUTION_BACKEND: process.env.BENCHMARK_EXECUTION_BACKEND,
			BENCHMARK_EXECUTION_CLASS: process.env.BENCHMARK_EXECUTION_CLASS,
			BENCHMARK_KUEUE_INSTANCE_REQUEST_MODE:
				process.env.BENCHMARK_KUEUE_INSTANCE_REQUEST_MODE,
			SANDBOX_EXECUTION_CLASSES_JSON:
				process.env.SANDBOX_EXECUTION_CLASSES_JSON,
		};
		const sandboxRequest = {
			cpuMilli: 100,
			memoryBytes: 512 * 1024 * 1024,
			ephemeralStorageBytes: 2600 * 1024 * 1024,
		};
		try {
			process.env.BENCHMARK_EXECUTION_BACKEND = "dapr-kueue";
			process.env.BENCHMARK_EXECUTION_CLASS = "benchmark-fast";
			delete process.env.BENCHMARK_KUEUE_INSTANCE_REQUEST_MODE;
			process.env.SANDBOX_EXECUTION_CLASSES_JSON = JSON.stringify({
				"benchmark-fast": {
					cpu: "100m",
					memory: "256Mi",
					ephemeralStorage: "1Gi",
					agentHostCpu: "250m",
					agentHostMemory: "1Gi",
					agentHostEphemeralStorage: "3Gi",
					agentHostImage:
						"ghcr.io/pittampalliorg/dapr-agent-py-sandbox:git-test",
				},
			});

			expect(kueueInstanceResourceProfileFromEnv(sandboxRequest)).toEqual({
				cpuMilli: 150,
				memoryBytes: 640 * 1024 * 1024,
				ephemeralStorageBytes: 2856 * 1024 * 1024,
			});

			process.env.BENCHMARK_KUEUE_INSTANCE_REQUEST_MODE = "legacy-composite";
			expect(kueueInstanceResourceProfileFromEnv(sandboxRequest)).toEqual({
				cpuMilli: 450,
				memoryBytes: 1792 * 1024 * 1024,
				ephemeralStorageBytes: 6696 * 1024 * 1024,
			});
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value == null) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
		}
	});

	it("defaults Kueue full-instance pod count to the live OpenShell pod shape", () => {
		const previous = {
			BENCHMARK_EXECUTION_BACKEND: process.env.BENCHMARK_EXECUTION_BACKEND,
			BENCHMARK_EXECUTION_CLASS: process.env.BENCHMARK_EXECUTION_CLASS,
			BENCHMARK_KUEUE_INSTANCE_POD_COUNT:
				process.env.BENCHMARK_KUEUE_INSTANCE_POD_COUNT,
			BENCHMARK_KUEUE_INSTANCE_REQUEST_MODE:
				process.env.BENCHMARK_KUEUE_INSTANCE_REQUEST_MODE,
			SANDBOX_EXECUTION_CLASSES_JSON:
				process.env.SANDBOX_EXECUTION_CLASSES_JSON,
		};
		const instanceRequest = {
			cpuMilli: 450,
			memoryBytes: 1024 * 1024 * 1024,
			ephemeralStorageBytes: 6 * 1024 * 1024 * 1024,
		};
		try {
			process.env.BENCHMARK_EXECUTION_BACKEND = "dapr-kueue";
			process.env.BENCHMARK_EXECUTION_CLASS = "benchmark-fast";
			delete process.env.BENCHMARK_KUEUE_INSTANCE_POD_COUNT;
			delete process.env.BENCHMARK_KUEUE_INSTANCE_REQUEST_MODE;
			process.env.SANDBOX_EXECUTION_CLASSES_JSON = JSON.stringify({
				"benchmark-fast": {
					agentHostImage:
						"ghcr.io/pittampalliorg/dapr-agent-py-sandbox:git-test",
				},
			});

			expect(kueueInstancePodCountFromEnv(instanceRequest)).toBe(1);

			process.env.BENCHMARK_KUEUE_INSTANCE_REQUEST_MODE = "legacy-composite";
			expect(kueueInstancePodCountFromEnv(instanceRequest)).toBe(2);

			process.env.BENCHMARK_KUEUE_INSTANCE_POD_COUNT = "3";
			expect(kueueInstancePodCountFromEnv(instanceRequest)).toBe(3);

			delete process.env.BENCHMARK_KUEUE_INSTANCE_POD_COUNT;
			delete process.env.BENCHMARK_KUEUE_INSTANCE_REQUEST_MODE;
			process.env.SANDBOX_EXECUTION_CLASSES_JSON = JSON.stringify({
				"benchmark-fast": {},
			});
			expect(kueueInstancePodCountFromEnv(instanceRequest)).toBe(1);
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value == null) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
		}
	});

	it("does not block launches when live node filesystem stats are unavailable", () => {
		const snapshot = estimateSchedulableSandboxCapacity({
			nodes: [
				workerNode("worker-a", {
					cpu: "8000m",
					memory: "32Gi",
					"ephemeral-storage": "200Gi",
				}),
			],
			pods: [],
			nodeStorageStats: new Map(),
			sandboxRequest: {
				cpuMilli: 100,
				memoryBytes: 256 * 1024 * 1024,
				ephemeralStorageBytes: 8 * 1024 * 1024 * 1024,
			},
		});

		expect(snapshot).toMatchObject({
			nodeFsAvailableBytes: null,
			nodeFsLimitedCapacity: null,
			ephemeralStorageLimitedCapacity: 25,
			availableSandboxSlots: 25,
			schedulableSandboxCapacity: 25,
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
