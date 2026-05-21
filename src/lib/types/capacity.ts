export type CapacityResourceSnapshot = {
  flavor: string;
  resource: string;
  allocatable: number;
  requested: number;
  criticalRequested: number;
  criticalReserve: number;
  renderedBudget: number;
  headroom: number;
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
  coverage: CapacityCoverageSummary;
};
