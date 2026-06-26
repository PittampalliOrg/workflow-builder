export type CapacityResourceSnapshot = {
  flavor: string;
  resource: string;
  allocatable: number;
  requested: number;
  criticalRequested: number;
  criticalReserve: number;
  renderedBudget: number;
  headroom: number;
  observed?: number;
};

export type CapacityQueueResourceSnapshot = {
  resource: string;
  nominal: number;
  used: number;
  reserved: number;
  borrowed: number;
  headroom: number;
};

export type CapacityQueueSnapshot = {
  name: string;
  cohort: string | null;
  flavor: string;
  /** Kueue Active=True/False (undefined on old observer payloads). */
  active?: boolean;
  activeReason?: string;
  activeMessage?: string;
  admittedWorkloads: number;
  pendingWorkloads: number;
  reservingWorkloads: number;
  admissionWaitP50Seconds: number | null;
  admissionWaitP95Seconds: number | null;
  resources: CapacityQueueResourceSnapshot[];
};

export type CapacitySessionSnapshot = {
  executionClass: string;
  queue: string;
  request: Record<string, number>;
  benchmarkSandboxRequest?: Record<string, number> | null;
  benchmarkSandboxDaprRequest?: Record<string, number> | null;
  benchmarkKueueInstanceRequestMode?: string | null;
  benchmarkKueueInstancePodCountScope?: string | null;
  limits: Record<string, number | null>;
  fits: number | null;
};

export type CapacityOwnerHint = {
  source?: string;
  sessionId?: string;
  agentAppId?: string;
  benchmarkRunId?: string;
  benchmarkInstanceId?: string;
};

export type CapacityOwnerKind =
  | "workflowRun"
  | "session"
  | "agent"
  | "benchmarkRun"
  | "benchmarkInstance";

export type CapacityOwnerRef = {
  kind: CapacityOwnerKind;
  id: string;
  label: string;
  href: string;
  secondaryLabel?: string;
  source?: string;
  confidence?: "direct" | "derived" | "inferred";
};

export type CapacityBlockedWorkload = {
  namespace: string;
  name: string;
  queue: string;
  status: string;
  reason: string;
  message: string;
  pendingSeconds: number;
  ownerHints?: CapacityOwnerHint[];
  owners?: CapacityOwnerRef[];
};

export type CapacityContributorSnapshot = {
  key: string;
  namespace: string;
  name: string;
  kind: "critical" | "kueue" | "workload" | string;
  queue: string | null;
  podCount: number;
  resources: Record<string, number>;
  observedResources?: Record<string, number>;
  ownerHints?: CapacityOwnerHint[];
  owners?: CapacityOwnerRef[];
};

export type CapacityCriticalHealth = {
  name: string;
  ready: number;
  total: number;
  status: "healthy" | "degraded" | "unavailable" | string;
};

/**
 * Linux Pressure Stall Information from kubelet's /stats/summary endpoint.
 * `some` = time when ANY task was stalled; `full` = time when ALL tasks
 * were stalled. Each is a `% of wallclock` over the trailing 10s/60s/300s
 * window. Populated post K8s 1.36 + cgroup v2 + psi=1 kernel arg; absent
 * (or empty) on older clusters — UI should treat as optional.
 */
export type CapacityPsiBlock = {
  some?: { avg10?: number; avg60?: number; avg300?: number; total?: number };
  full?: { avg10?: number; avg60?: number; avg300?: number; total?: number };
};

export type CapacityPsiCoverage = {
  expectedNodes: string[];
  sampledNodes: string[];
  missingNodes: string[];
  complete: boolean;
  errorsByNode: Record<string, string>;
};

export type CapacityPsiSnapshot = {
  cpu?: CapacityPsiBlock;
  memory?: CapacityPsiBlock;
  io?: CapacityPsiBlock;
  perNode?: Record<string, { cpu?: CapacityPsiBlock; memory?: CapacityPsiBlock; io?: CapacityPsiBlock }>;
  coverage?: CapacityPsiCoverage;
};

/**
 * Cluster-wide ClusterQueue admission health roll-up. Surfaces Kueue's
 * `status.conditions[type=Active]` per CQ so an operator can see at a
 * glance whether Kueue is willing to admit work at all — a CQ that
 * goes inactive (missing flavor / inactive AdmissionCheck / etc.) is
 * the kind of failure that otherwise looks like "queue full" until
 * someone runs `kubectl get clusterqueue`.
 */
export type CapacityAdmissionHealth = {
  totalQueues: number;
  activeQueues: number;
  inactiveQueues: Array<{ name: string; reason: string; message: string }>;
};

export type CapacityCoverageStatus =
  | "kueue_managed"
  | "critical_system"
  | "supplemental_lease"
  | "track_only"
  | "gap"
  | "unknown";

export type CapacityCoveragePath = {
  id: string;
  label: string;
  description: string;
  status: CapacityCoverageStatus;
  podProducing: boolean;
  queue: string | null;
  priorityClass: string | null;
  controller: string;
  evidence: string;
};

export type CapacityKubernetes136Feature = {
  id: string;
  label: string;
  status: "available" | "configured" | "candidate" | "needs_audit" | "not_required" | "track_only" | "unknown";
  required: boolean;
  message: string;
};

export type CapacityCoverageSummary = {
  generatedAt: string;
  counts: Record<CapacityCoverageStatus, number>;
  paths: CapacityCoveragePath[];
  gaps: CapacityCoveragePath[];
  criticalSystem: CapacityCoveragePath[];
  kubernetes136: CapacityKubernetes136Feature[];
};

export type CapacityObserverSnapshot = {
  sampledAt: string;
  cluster: string;
  flavor: string;
  resources: CapacityResourceSnapshot[];
  queues: CapacityQueueSnapshot[];
  localQueues: number;
  sessionCapacity: CapacitySessionSnapshot[];
  blockedWorkloads: CapacityBlockedWorkload[];
  contributors?: CapacityContributorSnapshot[];
  nodePressure: Record<string, number>;
  criticalHealth: CapacityCriticalHealth[];
  recentPreemptions: number;
  /** Phase C: kubelet PSI metrics. Empty object on K8s < 1.36 or scrape failure. */
  psi?: CapacityPsiSnapshot;
  /** ClusterQueue admission health roll-up — drives the Zone A admission banner. */
  admissionHealth?: CapacityAdmissionHealth;
  warnings: string[];
  observer?: {
    ok: boolean;
    errors: string[];
  };
};

export type CapacityObserverResult =
  | {
      available: true;
      snapshot: CapacityObserverSnapshot;
      error: null;
    }
  | {
      available: false;
      snapshot: null;
      error: string;
    };

export type CapacityOverviewSummary = {
  observer: CapacityObserverResult;
  businessWork: CapacityBusinessWorkSummary;
  coverage?: CapacityCoverageSummary;
};

export type CapacityBusinessWorkKind =
  | "workflowRun"
  | "session"
  | "agent"
  | "benchmarkRun"
  | "benchmarkInstance"
  | "infrastructure";

export type CapacityBusinessWorkItem = {
  key: string;
  kind: CapacityBusinessWorkKind;
  id: string;
  title: string;
  status: string;
  href?: string;
  active: boolean;
  startedAt?: string | null;
  completedAt?: string | null;
  ageSeconds?: number | null;
  durationSeconds?: number | null;
  model?: string | null;
  provider?: string | null;
  /** Workflow-run only: the node currently executing (for inline "what stage" display). */
  currentNodeName?: string | null;
  /** Workflow-run only: 0–100 progress. */
  progress?: number | null;
  /** Workflow-run only: this run is a fork/resume of another (rerun parent id). */
  rerunOfExecutionId?: string | null;
  /** Workflow-run only: the node this run was forked FROM (skip-prefix point). */
  forkedFromNode?: string | null;
  /** Workflow-run only: count of fork/resume children of this run. */
  forkCount?: number | null;
  /** Workflow-run only: the parent workflow id (for lineage deep-links). */
  workflowId?: string | null;
  owners: CapacityOwnerRef[];
  requestedResources: Record<string, number>;
  observedResources: Record<string, number>;
  resourceSeconds?: Record<string, number>;
  podCount: number;
  contributorCount: number;
  blockedWorkloadCount: number;
  queues: string[];
  namespaces: string[];
  contributorKeys: string[];
  pressure: {
    cpuPct?: number | null;
    memoryPct?: number | null;
    podsPct?: number | null;
    storagePct?: number | null;
  };
  telemetry: {
    requested: boolean;
    observed: boolean;
  };
};

export type CapacityBusinessWorkSummary = {
  active: CapacityBusinessWorkItem[];
  recent: CapacityBusinessWorkItem[];
  infrastructure: CapacityBusinessWorkItem[];
  totals: {
    activeWork: number;
    recentWork: number;
    unattributedInfrastructure: number;
    requestedResources: Record<string, number>;
    observedResources: Record<string, number>;
    blockedWorkloads: number;
  };
  generatedAt: string;
};
