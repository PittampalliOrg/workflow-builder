import {
  kubeApiFetch,
  kubeApiFetchFromKubeconfig,
  listDeployments,
  listPods,
  type KubeDeployment,
  type KubePod,
} from "$lib/server/kube/client";
import { getOrchestratorUrl } from "$lib/server/dapr-client";

export type BenchmarkLaunchControlPlaneStability = {
  stable: boolean;
  reasons: string[];
  stableSeconds: number;
  deployment: {
    name: string;
    namespace: string;
    stable: boolean;
    reasons: string[];
    replicas: number | null;
    updatedReplicas: number | null;
    readyReplicas: number | null;
    availableReplicas: number | null;
    observedGeneration: number | null;
    generation: number | null;
    youngestReadyPodAgeSeconds: number | null;
  };
  hookJobs: {
    stable: boolean;
    activeJobs: string[];
    checkedNames: string[];
    error: string | null;
  };
  argoApplication: {
    configured: boolean;
    stable: boolean;
    appName: string | null;
    namespace: string;
    syncStatus: string | null;
    healthStatus: string | null;
    operationPhase: string | null;
    operationMessage: string | null;
    operationStartedAt: string | null;
    operationFinishedAt: string | null;
    secondsSinceFinished: number | null;
    error: string | null;
  };
  activeSwebenchWorkflows: {
    stable: boolean;
    count: number | null;
    sampleIds: string[];
    error: string | null;
  };
};

type KubeJob = {
  metadata?: {
    name?: string;
    namespace?: string;
  };
  status?: {
    active?: number;
    succeeded?: number;
    failed?: number;
  };
};

type ArgoApplication = {
  status?: {
    sync?: { status?: string };
    health?: { status?: string };
    operationState?: {
      phase?: string;
      message?: string;
      startedAt?: string;
      finishedAt?: string;
    };
  };
};

type WorkflowListResponse = {
  workflows?: Array<{
    instanceId?: string;
    id?: string;
    runtimeStatus?: string;
    status?: string;
  }>;
  total?: number;
};

const DEFAULT_NAMESPACE = "workflow-builder";
const DEFAULT_DEPLOYMENT = "workflow-builder";
const DEFAULT_ARGO_NAMESPACE = "argocd";
const DEFAULT_STABLE_SECONDS = 120;
const HOOK_JOB_NAMES = ["db-migrate", "db-seed", "sync-platform-oauth-apps"];

function positiveInt(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number.parseInt(value, 10)
        : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readEnvString(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name];
    if (value?.trim()) return value.trim();
  }
  return null;
}

function configuredStableSeconds(): number {
  return (
    positiveInt(process.env.BENCHMARK_WORKFLOW_BUILDER_STABLE_SECONDS) ??
    DEFAULT_STABLE_SECONDS
  );
}

function configuredNamespace(): string {
  return (
    readEnvString("BENCHMARK_WORKFLOW_BUILDER_NAMESPACE") ?? DEFAULT_NAMESPACE
  );
}

function configuredDeployment(): string {
  return (
    readEnvString("BENCHMARK_WORKFLOW_BUILDER_DEPLOYMENT") ?? DEFAULT_DEPLOYMENT
  );
}

function podDeletionTimestamp(pod: KubePod): string | null {
  return (
    (pod.metadata as { deletionTimestamp?: string | null } | undefined)
      ?.deletionTimestamp ?? null
  );
}

function podIsReady(pod: KubePod): boolean {
  return (
    pod.status?.phase === "Running" &&
    podDeletionTimestamp(pod) == null &&
    pod.status.conditions?.some(
      (condition) => condition.type === "Ready" && condition.status === "True",
    ) === true
  );
}

function podMatchesDeployment(pod: KubePod, deploymentName: string): boolean {
  const labels = pod.metadata?.labels ?? {};
  return (
    labels.app === deploymentName ||
    labels["app.kubernetes.io/name"] === deploymentName
  );
}

function secondsSince(timestamp: string | null | undefined, now = Date.now()) {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed)
    ? Math.max(0, Math.floor((now - parsed) / 1000))
    : null;
}

export function summarizeWorkflowBuilderDeployment(input: {
  deployment: KubeDeployment | null;
  pods: KubePod[];
  namespace: string;
  name: string;
  stableSeconds: number;
  now?: number;
}): BenchmarkLaunchControlPlaneStability["deployment"] {
  const reasons: string[] = [];
  const deployment = input.deployment;
  if (!deployment) {
    reasons.push(`deployment_not_found:${input.namespace}/${input.name}`);
    return {
      name: input.name,
      namespace: input.namespace,
      stable: false,
      reasons,
      replicas: null,
      updatedReplicas: null,
      readyReplicas: null,
      availableReplicas: null,
      observedGeneration: null,
      generation: null,
      youngestReadyPodAgeSeconds: null,
    };
  }

  const replicas =
    deployment.spec?.replicas ?? deployment.status?.replicas ?? 1;
  const updatedReplicas = deployment.status?.updatedReplicas ?? 0;
  const readyReplicas = deployment.status?.readyReplicas ?? 0;
  const availableReplicas = deployment.status?.availableReplicas ?? 0;
  const generation = deployment.metadata?.generation ?? null;
  const observedGeneration = deployment.status?.observedGeneration ?? null;
  if (generation != null && observedGeneration !== generation) {
    reasons.push("deployment_generation_not_observed");
  }
  if (updatedReplicas < replicas)
    reasons.push("deployment_updated_replicas_pending");
  if (readyReplicas < replicas)
    reasons.push("deployment_ready_replicas_pending");
  if (availableReplicas < replicas) {
    reasons.push("deployment_available_replicas_pending");
  }
  if ((deployment.status?.unavailableReplicas ?? 0) > 0) {
    reasons.push("deployment_has_unavailable_replicas");
  }

  const matchingPods = input.pods.filter((pod) =>
    podMatchesDeployment(pod, input.name),
  );
  if (matchingPods.some((pod) => podDeletionTimestamp(pod) != null)) {
    reasons.push("deployment_pods_terminating");
  }
  const readyPods = matchingPods.filter(podIsReady);
  if (readyPods.length < replicas)
    reasons.push("deployment_ready_pods_pending");
  const readyPodAges = readyPods
    .map((pod) => secondsSince(pod.metadata?.creationTimestamp, input.now))
    .filter((age): age is number => age !== null);
  const youngestReadyPodAgeSeconds =
    readyPodAges.length > 0 ? Math.min(...readyPodAges) : null;
  if (
    replicas > 0 &&
    (youngestReadyPodAgeSeconds == null ||
      youngestReadyPodAgeSeconds < input.stableSeconds)
  ) {
    reasons.push("deployment_recently_rolled");
  }

  return {
    name: input.name,
    namespace: input.namespace,
    stable: reasons.length === 0,
    reasons,
    replicas,
    updatedReplicas,
    readyReplicas,
    availableReplicas,
    observedGeneration,
    generation,
    youngestReadyPodAgeSeconds,
  };
}

async function loadHookJobStability(input: {
  namespace: string;
}): Promise<BenchmarkLaunchControlPlaneStability["hookJobs"]> {
  try {
    const res = await kubeApiFetch(
      `/apis/batch/v1/namespaces/${encodeURIComponent(input.namespace)}/jobs`,
    );
    if (!res.ok) {
      throw new Error(`list jobs failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { items?: KubeJob[] };
    const activeJobs = (body.items ?? [])
      .filter((job) => HOOK_JOB_NAMES.includes(job.metadata?.name ?? ""))
      .filter((job) => (job.status?.active ?? 0) > 0)
      .map((job) => job.metadata?.name ?? "unknown");
    return {
      stable: activeJobs.length === 0,
      activeJobs,
      checkedNames: HOOK_JOB_NAMES,
      error: null,
    };
  } catch (err) {
    return {
      stable: false,
      activeJobs: [],
      checkedNames: HOOK_JOB_NAMES,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function inferArgoApplicationName(): string | null {
  const explicit = readEnvString("BENCHMARK_ARGOCD_APPLICATION_NAME");
  if (explicit) return explicit;
  const publicUrl = readEnvString("APP_PUBLIC_URL", "PUBLIC_APP_URL");
  if (!publicUrl) return null;
  try {
    const host = new URL(publicUrl).hostname;
    const match = host.match(/^workflow-builder-([a-z0-9-]+)\./i);
    if (match?.[1]) return `${match[1].toLowerCase()}-workflow-builder`;
  } catch {
    return null;
  }
  return null;
}

function argoKubeconfigPath(): string | null {
  return readEnvString(
    "BENCHMARK_ARGOCD_HUB_KUBECONFIG",
    "SWEBENCH_INFERENCE_BUILD_HUB_KUBECONFIG",
    "SWEBENCH_INFERENCE_BUILD_HUB_KUBECONFIG_PATH",
    "HUB_KUBECONFIG",
  );
}

function argoKubeconfigContext(): string | null {
  return readEnvString(
    "BENCHMARK_ARGOCD_HUB_KUBECONFIG_CONTEXT",
    "SWEBENCH_INFERENCE_BUILD_HUB_KUBECONFIG_CONTEXT",
  );
}

function argoUsesInClusterApi(): boolean {
  return (
    readEnvString("BENCHMARK_ARGOCD_KUBECONFIG_MODE")?.toLowerCase() ===
      "in-cluster" ||
    readEnvString("BENCHMARK_ARGOCD_IN_CLUSTER")?.toLowerCase() === "true"
  );
}

export function summarizeArgoApplicationStability(input: {
  appName: string | null;
  namespace: string;
  app: ArgoApplication | null;
  error?: string | null;
  stableSeconds: number;
  now?: number;
}): BenchmarkLaunchControlPlaneStability["argoApplication"] {
  if (!input.appName) {
    return {
      configured: false,
      stable: true,
      appName: null,
      namespace: input.namespace,
      syncStatus: null,
      healthStatus: null,
      operationPhase: null,
      operationMessage: null,
      operationStartedAt: null,
      operationFinishedAt: null,
      secondsSinceFinished: null,
      error: null,
    };
  }
  if (input.error) {
    return {
      configured: true,
      stable: false,
      appName: input.appName,
      namespace: input.namespace,
      syncStatus: null,
      healthStatus: null,
      operationPhase: null,
      operationMessage: null,
      operationStartedAt: null,
      operationFinishedAt: null,
      secondsSinceFinished: null,
      error: input.error,
    };
  }
  const operation = input.app?.status?.operationState;
  const operationPhase = operation?.phase ?? null;
  const operationFinishedAt = operation?.finishedAt ?? null;
  const secondsSinceFinished = secondsSince(operationFinishedAt, input.now);
  const syncStatus = input.app?.status?.sync?.status ?? null;
  const healthStatus = input.app?.status?.health?.status ?? null;
  const stable =
    syncStatus === "Synced" &&
    healthStatus === "Healthy" &&
    operationPhase !== "Running" &&
    (secondsSinceFinished == null ||
      secondsSinceFinished >= input.stableSeconds);
  return {
    configured: true,
    stable,
    appName: input.appName,
    namespace: input.namespace,
    syncStatus,
    healthStatus,
    operationPhase,
    operationMessage: operation?.message ?? null,
    operationStartedAt: operation?.startedAt ?? null,
    operationFinishedAt,
    secondsSinceFinished,
    error: null,
  };
}

async function loadArgoApplicationStability(input: {
  stableSeconds: number;
}): Promise<BenchmarkLaunchControlPlaneStability["argoApplication"]> {
  const appName = inferArgoApplicationName();
  const namespace =
    readEnvString("BENCHMARK_ARGOCD_NAMESPACE") ?? DEFAULT_ARGO_NAMESPACE;
  const kubeconfigPath = argoKubeconfigPath();
  const useInClusterApi = argoUsesInClusterApi();
  if (!appName || (!kubeconfigPath && !useInClusterApi)) {
    return summarizeArgoApplicationStability({
      appName: null,
      namespace,
      app: null,
      stableSeconds: input.stableSeconds,
    });
  }
  try {
    const path = `/apis/argoproj.io/v1alpha1/namespaces/${encodeURIComponent(
      namespace,
    )}/applications/${encodeURIComponent(appName)}`;
    const res = useInClusterApi
      ? await kubeApiFetch(path)
      : await kubeApiFetchFromKubeconfig(
          path,
          {},
          {
            kubeconfigPath: kubeconfigPath!,
            context: argoKubeconfigContext(),
          },
        );
    if (!res.ok) {
      throw new Error(
        `get Argo Application ${namespace}/${appName} failed: ${
          res.status
        } ${await res.text()}`,
      );
    }
    return summarizeArgoApplicationStability({
      appName,
      namespace,
      app: (await res.json()) as ArgoApplication,
      stableSeconds: input.stableSeconds,
    });
  } catch (err) {
    return summarizeArgoApplicationStability({
      appName,
      namespace,
      app: null,
      error: err instanceof Error ? err.message : String(err),
      stableSeconds: input.stableSeconds,
    });
  }
}

async function loadActiveSwebenchWorkflowStability(): Promise<
  BenchmarkLaunchControlPlaneStability["activeSwebenchWorkflows"]
> {
  try {
    const query = new URLSearchParams({
      status: "PENDING,RUNNING",
      search: "sw-swebench-instance",
      limit: "200",
    });
    const res = await fetch(`${getOrchestratorUrl()}/api/v2/workflows?${query}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`list workflows failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as WorkflowListResponse;
    const workflows = body.workflows ?? [];
    const count = Number.isFinite(body.total) ? Number(body.total) : workflows.length;
    return {
      stable: count === 0,
      count,
      sampleIds: workflows
        .map((workflow) => workflow.instanceId ?? workflow.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .slice(0, 10),
      error: null,
    };
  } catch (err) {
    return {
      stable: false,
      count: null,
      sampleIds: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function loadBenchmarkLaunchControlPlaneStability(): Promise<BenchmarkLaunchControlPlaneStability> {
  const namespace = configuredNamespace();
  const deploymentName = configuredDeployment();
  const stableSeconds = configuredStableSeconds();
  const [deployments, pods, hookJobs, argoApplication, activeSwebenchWorkflows] =
    await Promise.all([
      listDeployments(namespace).catch(() => []),
      listPods(namespace).catch(() => []),
      loadHookJobStability({ namespace }),
      loadArgoApplicationStability({ stableSeconds }),
      loadActiveSwebenchWorkflowStability(),
    ]);
  const deployment =
    deployments.find((entry) => entry.metadata?.name === deploymentName) ??
    null;
  const deploymentStability = summarizeWorkflowBuilderDeployment({
    deployment,
    pods,
    namespace,
    name: deploymentName,
    stableSeconds,
  });
  const reasons = [
    ...deploymentStability.reasons,
    ...(hookJobs.stable ? [] : ["workflow_builder_hook_jobs_active"]),
    ...(argoApplication.stable ? [] : ["argocd_application_not_stable"]),
    ...(activeSwebenchWorkflows.stable ? [] : ["active_swebench_workflows"]),
  ];
  return {
    stable:
      deploymentStability.stable &&
      hookJobs.stable &&
      argoApplication.stable &&
      activeSwebenchWorkflows.stable,
    reasons,
    stableSeconds,
    deployment: deploymentStability,
    hookJobs,
    argoApplication,
    activeSwebenchWorkflows,
  };
}

export function benchmarkLaunchControlPlaneError(
  stability: BenchmarkLaunchControlPlaneStability,
): string | null {
  if (stability.stable) return null;
  const reason =
    stability.reasons[0] ?? "workflow_builder_control_plane_unstable";
  return `SWE-bench launch is paused while workflow-builder control plane stabilizes: ${reason}`;
}
