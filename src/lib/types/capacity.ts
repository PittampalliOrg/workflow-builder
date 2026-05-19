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
