import { env } from "$env/dynamic/private";
import { kubeApiFetch, kubeApiFetchFromKubeconfig } from "./client";

export type TektonPipelineRun = {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: Array<{
      apiVersion?: string;
      kind?: string;
      name?: string;
      uid?: string;
      controller?: boolean;
      blockOwnerDeletion?: boolean;
    }>;
  };
  spec?: Record<string, unknown>;
  status?: {
    conditions?: Array<{
      type?: string;
      status?: string;
      reason?: string;
      message?: string;
      lastTransitionTime?: string;
    }>;
    pipelineResults?: Array<{ name?: string; value?: string | string[] }>;
    results?: Array<{ name?: string; value?: string | string[] }>;
    startTime?: string;
    completionTime?: string;
  };
};

export type TektonCondition = NonNullable<
  NonNullable<TektonPipelineRun["status"]>["conditions"]
>[number];

export type TektonTaskRun = {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: Array<{
      apiVersion?: string;
      kind?: string;
      name?: string;
      uid?: string;
      controller?: boolean;
      blockOwnerDeletion?: boolean;
    }>;
  };
  spec?: Record<string, unknown>;
  status?: {
    conditions?: TektonCondition[];
    taskResults?: Array<{ name?: string; value?: string | string[] }>;
    results?: Array<{ name?: string; value?: string | string[] }>;
    startTime?: string;
    completionTime?: string;
    podName?: string;
    steps?: Array<{
      name?: string;
      container?: string;
      waiting?: Record<string, unknown>;
      running?: Record<string, unknown>;
      terminated?: Record<string, unknown>;
    }>;
  };
};

type TektonList<T> = {
  items?: T[];
};

export type TektonTargetCluster =
  | "local"
  | "hub"
  | "hub-preview-acceptance"
  | "hub-preview-activation"
  | "hub-preview-development";

type TektonRequestOptions = {
  targetCluster?: TektonTargetCluster;
};

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readEnvString(name: string): string | null {
  return readString(env[name]) ?? readString(process.env[name]);
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJson(item)]),
    );
  }
  return value;
}

function canonicalPipelineRunContract(
  pipelineRun: TektonPipelineRun,
  namespace: string,
): Record<string, unknown> {
  return {
    apiVersion: pipelineRun.apiVersion ?? null,
    kind: pipelineRun.kind ?? null,
    metadata: {
      name: readString(pipelineRun.metadata?.name),
      namespace: readString(pipelineRun.metadata?.namespace) ?? namespace,
      labels: pipelineRun.metadata?.labels ?? {},
      annotations: pipelineRun.metadata?.annotations ?? {},
    },
    spec: pipelineRun.spec ?? {},
  };
}

/**
 * Bind a deterministic create conflict to the exact PipelineRun request. A
 * matching name is not authority: an attacker with create permission could
 * pre-create that name with different params, credentials, or workspaces.
 */
export function assertCanonicalTektonPipelineRun(
  namespace: string,
  requested: TektonPipelineRun,
  actual: TektonPipelineRun,
): string {
  const expectedName = readString(requested.metadata?.name);
  if (!expectedName)
    throw new Error("PipelineRun request requires metadata.name");
  if (
    readString(requested.metadata?.namespace) !== null &&
    readString(requested.metadata?.namespace) !== namespace
  ) {
    throw new Error(
      "PipelineRun request namespace does not match create namespace",
    );
  }
  const expected = JSON.stringify(
    canonicalJson(canonicalPipelineRunContract(requested, namespace)),
  );
  const observed = JSON.stringify(
    canonicalJson(canonicalPipelineRunContract(actual, namespace)),
  );
  if (expected !== observed) {
    throw new Error(
      `PipelineRun ${namespace}/${expectedName} conflicts with a different canonical request`,
    );
  }
  return requireTektonPipelineRunUid(actual, { namespace, name: expectedName });
}

export function requireTektonPipelineRunUid(
  pipelineRun: TektonPipelineRun,
  expected?: { namespace: string; name: string },
): string {
  if (
    expected &&
    (readString(pipelineRun.metadata?.name) !== expected.name ||
      readString(pipelineRun.metadata?.namespace) !== expected.namespace)
  ) {
    throw new Error(
      `PipelineRun identity does not match ${expected.namespace}/${expected.name}`,
    );
  }
  const uid = readString(pipelineRun.metadata?.uid);
  if (!uid) throw new Error("PipelineRun response is missing metadata.uid");
  return uid;
}

export function tektonTaskRunOwnedByPipelineRun(
  taskRun: TektonTaskRun,
  pipelineRun: TektonPipelineRun,
): boolean {
  const pipelineRunName = readString(pipelineRun.metadata?.name);
  const pipelineRunUid = readString(pipelineRun.metadata?.uid);
  if (!pipelineRunName || !pipelineRunUid) return false;
  return Boolean(
    taskRun.metadata?.ownerReferences?.some(
      (reference) =>
        reference.apiVersion === "tekton.dev/v1" &&
        reference.kind === "PipelineRun" &&
        reference.name === pipelineRunName &&
        reference.uid === pipelineRunUid &&
        reference.controller === true,
    ),
  );
}

type HubTektonCredentialProfile = Exclude<TektonTargetCluster, "local">;

export function configuredHubTektonKubeconfig(
  profile: HubTektonCredentialProfile = "hub",
) {
  if (profile === "hub-preview-acceptance") {
    return {
      path:
        readEnvString("PREVIEW_ACCEPTANCE_HUB_KUBECONFIG") ??
        readEnvString("PREVIEW_ACCEPTANCE_HUB_KUBECONFIG_PATH"),
      content:
        readEnvString("PREVIEW_ACCEPTANCE_HUB_KUBECONFIG_CONTENT") ??
        readEnvString("PREVIEW_ACCEPTANCE_HUB_KUBECONFIG_YAML"),
      context: readEnvString("PREVIEW_ACCEPTANCE_HUB_KUBECONFIG_CONTEXT"),
    };
  }
  if (profile === "hub-preview-development") {
    return {
      path:
        readEnvString("PREVIEW_DEVELOPMENT_HUB_KUBECONFIG") ??
        readEnvString("PREVIEW_DEVELOPMENT_HUB_KUBECONFIG_PATH"),
      content:
        readEnvString("PREVIEW_DEVELOPMENT_HUB_KUBECONFIG_CONTENT") ??
        readEnvString("PREVIEW_DEVELOPMENT_HUB_KUBECONFIG_YAML"),
      context: readEnvString("PREVIEW_DEVELOPMENT_HUB_KUBECONFIG_CONTEXT"),
    };
  }
  if (profile === "hub-preview-activation") {
    return {
      path:
        readEnvString("PREVIEW_ACTIVATION_HUB_KUBECONFIG") ??
        readEnvString("PREVIEW_ACTIVATION_HUB_KUBECONFIG_PATH"),
      content:
        readEnvString("PREVIEW_ACTIVATION_HUB_KUBECONFIG_CONTENT") ??
        readEnvString("PREVIEW_ACTIVATION_HUB_KUBECONFIG_YAML"),
      context: readEnvString("PREVIEW_ACTIVATION_HUB_KUBECONFIG_CONTEXT"),
    };
  }
  return {
    path:
      readEnvString("SWEBENCH_INFERENCE_BUILD_HUB_KUBECONFIG") ??
      readEnvString("SWEBENCH_INFERENCE_BUILD_HUB_KUBECONFIG_PATH") ??
      readEnvString("HUB_KUBECONFIG"),
    content:
      readEnvString("SWEBENCH_INFERENCE_BUILD_HUB_KUBECONFIG_CONTENT") ??
      readEnvString("SWEBENCH_INFERENCE_BUILD_HUB_KUBECONFIG_YAML"),
    context: readEnvString("SWEBENCH_INFERENCE_BUILD_HUB_KUBECONFIG_CONTEXT"),
  };
}

export function hasConfiguredHubTektonKubeconfig(): boolean {
  const config = configuredHubTektonKubeconfig();
  return Boolean(config.path || config.content);
}

function tektonFetch(
  path: string,
  init: RequestInit & { retries?: number } = {},
  options: TektonRequestOptions = {},
): Promise<Response> {
  if (!options.targetCluster || options.targetCluster === "local") {
    return kubeApiFetch(path, init);
  }
  const config = configuredHubTektonKubeconfig(options.targetCluster);
  if (!config.path && !config.content) {
    const message =
      options.targetCluster === "hub-preview-acceptance"
        ? "preview acceptance hub Tekton kubeconfig is not configured; set PREVIEW_ACCEPTANCE_HUB_KUBECONFIG"
        : options.targetCluster === "hub-preview-activation"
          ? "preview activation hub Tekton kubeconfig is not configured; set PREVIEW_ACTIVATION_HUB_KUBECONFIG"
          : options.targetCluster === "hub-preview-development"
            ? "preview development hub Tekton kubeconfig is not configured; set PREVIEW_DEVELOPMENT_HUB_KUBECONFIG"
            : "hub Tekton kubeconfig is not configured; set SWEBENCH_INFERENCE_BUILD_HUB_KUBECONFIG";
    throw new Error(message);
  }
  return kubeApiFetchFromKubeconfig(path, init, {
    kubeconfigPath: config.path,
    kubeconfigContent: config.content,
    context: config.context,
  });
}

export async function createTektonPipelineRun(
  namespace: string,
  body: TektonPipelineRun,
  options: TektonRequestOptions = {},
): Promise<{ created: boolean; pipelineRun: TektonPipelineRun }> {
  const res = await tektonFetch(
    `/apis/tekton.dev/v1/namespaces/${encodeURIComponent(namespace)}/pipelineruns`,
    {
      method: "POST",
      body: JSON.stringify(body),
      retries: 1,
    },
    options,
  );
  if (res.status === 409) {
    const name = readString(body.metadata?.name);
    if (!name) {
      throw new Error(
        "create PipelineRun conflict cannot be resolved without metadata.name",
      );
    }
    const existing = await getTektonPipelineRun(namespace, name, options);
    if (!existing) {
      throw new Error(
        `PipelineRun ${namespace}/${name} conflicted but could not be read`,
      );
    }
    assertCanonicalTektonPipelineRun(namespace, body, existing);
    return { created: false, pipelineRun: existing };
  }
  if (!res.ok) {
    throw new Error(
      `create PipelineRun failed: ${res.status} ${await res.text()}`,
    );
  }
  return {
    created: true,
    pipelineRun: (await res.json()) as TektonPipelineRun,
  };
}

export async function getTektonPipelineRun(
  namespace: string,
  name: string,
  options: TektonRequestOptions = {},
): Promise<TektonPipelineRun | null> {
  const res = await tektonFetch(
    `/apis/tekton.dev/v1/namespaces/${encodeURIComponent(namespace)}/pipelineruns/${encodeURIComponent(name)}`,
    { retries: 1 },
    options,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(
      `get PipelineRun ${namespace}/${name} failed: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as TektonPipelineRun;
}

export async function listTektonTaskRunsForPipelineRun(
  namespace: string,
  pipelineRunName: string,
  options: TektonRequestOptions = {},
): Promise<TektonTaskRun[]> {
  const labelSelector = new URLSearchParams({
    labelSelector: `tekton.dev/pipelineRun=${pipelineRunName}`,
  });
  const res = await tektonFetch(
    `/apis/tekton.dev/v1/namespaces/${encodeURIComponent(namespace)}/taskruns?${labelSelector}`,
    { retries: 1 },
    options,
  );
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(
      `list TaskRuns for PipelineRun ${namespace}/${pipelineRunName} failed: ${res.status} ${await res.text()}`,
    );
  }
  const body = (await res.json()) as TektonList<TektonTaskRun>;
  return Array.isArray(body.items) ? body.items : [];
}

export function tektonPipelineRunResults(
  pipelineRun: TektonPipelineRun | null | undefined,
): Record<string, string> {
  const rawResults = [
    ...(pipelineRun?.status?.pipelineResults ?? []),
    ...(pipelineRun?.status?.results ?? []),
  ];
  const results: Record<string, string> = {};
  for (const result of rawResults) {
    if (!result?.name) continue;
    results[result.name] = Array.isArray(result.value)
      ? result.value.join("\n")
      : String(result.value ?? "");
  }
  return results;
}

export function tektonTaskRunResults(
  taskRun: TektonTaskRun | null | undefined,
): Record<string, string> {
  const rawResults = [
    ...(taskRun?.status?.taskResults ?? []),
    ...(taskRun?.status?.results ?? []),
  ];
  const results: Record<string, string> = {};
  for (const result of rawResults) {
    if (!result?.name) continue;
    results[result.name] = Array.isArray(result.value)
      ? result.value.join("\n")
      : String(result.value ?? "");
  }
  return results;
}

export function tektonSucceededCondition(
  pipelineRun: TektonPipelineRun | null | undefined,
) {
  return (
    pipelineRun?.status?.conditions?.find(
      (condition) => condition.type === "Succeeded",
    ) ?? null
  );
}

export function tektonTaskRunSucceededCondition(
  taskRun: TektonTaskRun | null | undefined,
) {
  return (
    taskRun?.status?.conditions?.find(
      (condition) => condition.type === "Succeeded",
    ) ?? null
  );
}
