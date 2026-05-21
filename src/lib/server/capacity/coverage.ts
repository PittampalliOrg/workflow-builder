import type {
	CapacityCoveragePath,
	CapacityCoverageStatus,
	CapacityCoverageSummary,
	CapacityKubernetes136Feature,
	CapacityObserverResult,
} from "$lib/types/capacity";

const QUEUE_BY_PATH: CapacityCoveragePath[] = [
	{
		id: "workflow-durable-run-agent-host",
		label: "durable/run agent host",
		description:
			"SW 1.0 durable/run sessions launch through the Kueue-backed agent-host path.",
		status: "kueue_managed",
		podProducing: true,
		queue: "interactive-agent",
		priorityClass: "interactive-agent",
		controller: "workflow-builder BFF / sandbox-execution-api",
		evidence: "AGENT_WORKFLOW_HOST_BACKEND=kueue",
	},
	{
		id: "swebench-inference",
		label: "SWE-bench inference",
		description:
			"Benchmark solve instances use the dapr-kueue backend and benchmark-fast queue.",
		status: "kueue_managed",
		podProducing: true,
		queue: "benchmark-fast",
		priorityClass: "swebench-cohort",
		controller: "swebench-coordinator / sandbox-execution-api",
		evidence: "BENCHMARK_EXECUTION_BACKEND=dapr-kueue",
	},
	{
		id: "swebench-evaluator",
		label: "SWE-bench evaluator TaskRuns",
		description:
			"Official grader TaskRuns are labeled for the benchmark-eval LocalQueue.",
		status: "kueue_managed",
		podProducing: true,
		queue: "benchmark-eval",
		priorityClass: "swebench-cohort",
		controller: "swebench-evaluator",
		evidence: "SWEBENCH_TEKTON_KUEUE_QUEUE_NAME=benchmark-eval",
	},
	{
		id: "agent-warm-pool",
		label: "agent warm pool",
		description:
			"Background warm capacity is admitted through the lowest-priority Kueue queue.",
		status: "kueue_managed",
		podProducing: true,
		queue: "background-warm",
		priorityClass: "background-warm",
		controller: "workflow-builder warm-pool builder",
		evidence: "AGENT_WARM_POOL_KUEUE_QUEUE=background-warm",
	},
	{
		id: "secure-gvisor",
		label: "secure gVisor execution",
		description:
			"Sandbox execution class for less-trusted workloads uses its own Kueue queue and RuntimeClass.",
		status: "kueue_managed",
		podProducing: true,
		queue: "secure-gvisor",
		priorityClass: "swebench-cohort",
		controller: "sandbox-execution-api",
		evidence: "SANDBOX_EXECUTION_CLASSES_JSON.secure-gvisor",
	},
	{
		id: "browserstation-raycluster",
		label: "browserstation RayCluster",
		description:
			"KubeRay browser workers are admitted through Kueue's Ray integration.",
		status: "kueue_managed",
		podProducing: true,
		queue: "benchmark-fast",
		priorityClass: null,
		controller: "KubeRay / Kueue RayCluster integration",
		evidence: "kueue.x-k8s.io/queue-name=benchmark-fast",
	},
	{
		id: "dapr-workflow-slots",
		label: "Dapr workflow slots",
		description:
			"Dapr sidecar workflow capacity is a non-Kubernetes runtime limit, so workflow-builder leases remain supplemental.",
		status: "supplemental_lease",
		podProducing: false,
		queue: null,
		priorityClass: null,
		controller: "workflow-builder resource leases",
		evidence: "dapr_workflow_slot lease",
	},
	{
		id: "model-provider-slots",
		label: "model/provider slots",
		description:
			"Provider rate and model concurrency limits are outside the Kubernetes scheduler and remain app-side leases.",
		status: "supplemental_lease",
		podProducing: false,
		queue: null,
		priorityClass: null,
		controller: "workflow-builder resource leases",
		evidence: "model_slot lease",
	},
	{
		id: "workflow-orchestrator",
		label: "workflow-orchestrator",
		description:
			"Durable parent workflow worker; protected as critical system capacity, not queued workload capacity.",
		status: "critical_system",
		podProducing: false,
		queue: null,
		priorityClass: "workflow-orchestration",
		controller: "Deployment/workflow-orchestrator",
		evidence: "priorityClassName=workflow-orchestration",
	},
	{
		id: "workflow-state",
		label: "workflow state stores",
		description:
			"Postgres and Dapr workflow state must remain available for replay, callbacks, cancellation, and cleanup.",
		status: "critical_system",
		podProducing: false,
		queue: null,
		priorityClass: "platform-critical",
		controller: "PostgreSQL / Dapr components",
		evidence: "workflowstatestore actor store",
	},
	{
		id: "kueue-control-plane",
		label: "Kueue and capacity observers",
		description:
			"Admission control components are critical system services and must not be queued behind the workloads they gate.",
		status: "critical_system",
		podProducing: false,
		queue: null,
		priorityClass: "workflow-orchestration",
		controller: "kueue / capacity-observer / psi-admission-check",
		evidence: "ClusterQueues + AdmissionCheck psi-memory-pressure",
	},
];

const STATUS_ORDER: CapacityCoverageStatus[] = [
	"kueue_managed",
	"critical_system",
	"supplemental_lease",
	"track_only",
	"gap",
	"unknown",
];

function hasPsi(snapshot: CapacityObserverResult | null | undefined): boolean | null {
	if (!snapshot) return null;
	if (!snapshot.available) return null;
	const psi = snapshot.snapshot.psi;
	return !!psi && (Boolean(psi.cpu || psi.memory || psi.io) || Boolean(psi.coverage));
}

function psiCoverageComplete(snapshot: CapacityObserverResult | null | undefined): boolean | null {
	if (!snapshot?.available) return null;
	const coverage = snapshot.snapshot.psi?.coverage;
	if (!coverage) return null;
	return coverage.complete;
}

function queueNames(snapshot: CapacityObserverResult | null | undefined): Set<string> | null {
	if (!snapshot?.available) return null;
	return new Set(snapshot.snapshot.queues.map((queue) => queue.name));
}

function withQueueHealth(
	paths: CapacityCoveragePath[],
	snapshot: CapacityObserverResult | null | undefined,
): CapacityCoveragePath[] {
	const queues = queueNames(snapshot);
	if (!queues) return paths;
	return paths.map((path) => {
		if (path.status !== "kueue_managed" || !path.queue || queues.has(path.queue)) {
			return path;
		}
		return {
			...path,
			status: "gap",
			evidence: `${path.evidence}; queue ${path.queue} missing from capacity observer snapshot`,
		};
	});
}

function kubernetes136Features(
	snapshot: CapacityObserverResult | null | undefined,
): CapacityKubernetes136Feature[] {
	const psi = hasPsi(snapshot);
	const complete = psiCoverageComplete(snapshot);
	return [
		{
			id: "psi-metrics",
			label: "PSI metrics",
			status:
				psi === true && complete !== false
					? "available"
					: psi === true && complete === false
						? "needs_audit"
						: psi === false
							? "needs_audit"
							: "unknown",
			required: true,
			message:
				psi === true && complete !== false
					? "kubelet PSI is present in the capacity snapshot and can gate Kueue AdmissionChecks."
					: psi === true && complete === false
						? "kubelet PSI is present but at least one expected worker node is missing telemetry."
					: "Kubernetes 1.36 exposes PSI as stable kubelet metrics; verify the observer can read them on this cluster.",
		},
		{
			id: "mutating-admission-policy",
			label: "MutatingAdmissionPolicy",
			status: "candidate",
			required: false,
			message:
				"Use for simple deterministic queue/default labels; keep custom controllers for Kueue AdmissionCheck decisions.",
		},
		{
			id: "user-namespaces",
			label: "User namespaces",
			status: "needs_audit",
			required: false,
			message:
				"Evaluate hostUsers=false for sandbox/security-sensitive classes; keep gVisor/OpenShell as the isolation baseline.",
		},
		{
			id: "dra-resource-health",
			label: "DRA resource health",
			status: "not_required",
			required: false,
			message:
				"Not required for current CPU/memory SWE-bench and agent runs; revisit for GPUs or specialized devices.",
		},
		{
			id: "workload-aware-scheduling",
			label: "Workload-aware scheduling",
			status: "track_only",
			required: false,
			message:
				"Track upstream alpha progress, but keep Kueue as the mature production admission layer.",
		},
	];
}

export function buildCapacityCoverageSummary(
	snapshot?: CapacityObserverResult | null,
): CapacityCoverageSummary {
	const paths = withQueueHealth(QUEUE_BY_PATH, snapshot);
	const counts = Object.fromEntries(
		STATUS_ORDER.map((status) => [
			status,
			paths.filter((path) => path.status === status).length,
		]),
	) as Record<CapacityCoverageStatus, number>;
	return {
		generatedAt: new Date().toISOString(),
		counts,
		paths,
		gaps: paths.filter((path) => path.status === "gap"),
		criticalSystem: paths.filter((path) => path.status === "critical_system"),
		kubernetes136: kubernetes136Features(snapshot),
	};
}

export const __capacityCoverageForTest = {
	QUEUE_BY_PATH,
	buildCapacityCoverageSummary,
};
