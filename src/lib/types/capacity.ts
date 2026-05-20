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

export type CapacityBlockedWorkload = {
  namespace: string;
  name: string;
  queue: string;
  status: string;
  reason: string;
  message: string;
  pendingSeconds: number;
};

export type CapacityContributorSnapshot = {
  key: string;
  namespace: string;
  name: string;
  kind: "critical" | "kueue" | "workload" | string;
  queue: string | null;
  podCount: number;
  resources: Record<string, number>;
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
  some?: { avg10?: number; avg60?: number; avg300?: number };
  full?: { avg10?: number; avg60?: number; avg300?: number };
};

export type CapacityPsiSnapshot = {
  cpu?: CapacityPsiBlock;
  memory?: CapacityPsiBlock;
  io?: CapacityPsiBlock;
  perNode?: Record<string, { cpu?: CapacityPsiBlock; memory?: CapacityPsiBlock; io?: CapacityPsiBlock }>;
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
};
