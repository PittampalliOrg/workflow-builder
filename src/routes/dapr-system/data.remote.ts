import { query } from "$app/server";
import { env } from "$env/dynamic/private";
import {
  daprFetch,
  getDaprSidecarUrl,
  getWorkflowCapableServices,
} from "$lib/server/dapr-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DaprComponent {
  name: string;
  type: string;
  version: string;
  capabilities?: string[];
}

interface DaprSubscription {
  pubsubname: string;
  topic: string;
  route?: string;
  routes?: { rules?: { path: string; match?: string }[]; default?: string };
}

interface SidecarMetadata {
  id: string;
  runtimeVersion: string;
  enabledFeatures: string[];
  components: DaprComponent[];
  subscriptions: DaprSubscription[];
  httpEndpoints: unknown[];
  appConnectionProperties: Record<string, unknown>;
}

interface ServiceHealthEntry {
  id: string;
  healthy: boolean;
  version: string;
  runtime: string;
  workflowCount: number;
  activityCount: number;
  features: string[];
  error?: string;
}

interface WorkflowInstance {
  instanceId: string;
  workflowId?: string;
  workflowName?: string;
  runtimeStatus?: string;
  status?: string;
  phase?: string;
  progress?: number;
  startedAt?: string;
  completedAt?: string;
  duration?: string | number;
  message?: string;
}

interface WorkflowRegistration {
  serviceId: string;
  name: string;
  version?: string;
  metadata?: Record<string, unknown>;
}

interface WorkflowHistoryEvent {
  eventId?: number;
  eventType: string;
  timestamp?: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
}

interface KnownStateKeys {
  agents: {
    key: string;
    label: string;
    storeName: string;
    serviceId: string;
    metadata?: Record<string, string>;
  }[];
  conversations: {
    key: string;
    label: string;
    storeName: string;
    serviceId: string;
    metadata?: Record<string, string>;
  }[];
}

interface AgentStateMessage {
  role: string;
  content: string;
  timestamp?: string;
  name?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface AgentStateInstance {
  input_value: string;
  output: string | null;
  start_time: string;
  end_time: string | null;
  status: string;
  messages: AgentStateMessage[];
  tool_history: {
    tool_name: string;
    tool_args?: Record<string, unknown>;
    execution_result: string;
    timestamp: string;
  }[];
  workflow_instance_id: string | null;
  session_id: string | null;
  source?: string;
  workflow_name?: string;
  error?: string | null;
}

interface AgentRegistryEntry {
  name: string;
  metadata: Record<string, unknown>;
}

const DEFAULT_AGENT_REGISTRY_STORE = "agent-registry";
const DEFAULT_AGENT_REGISTRY_TEAM = "default";

// ---------------------------------------------------------------------------
// Helpers — cross-service state access via Dapr service invocation
// ---------------------------------------------------------------------------

/** Read a state key via the local Dapr sidecar. */
async function readStateLocal(
  storeName: string,
  key: string,
  metadata: Record<string, string> = {},
): Promise<{
  found: boolean;
  value: unknown;
  etag: string | null;
  error?: string;
}> {
  const sidecarUrl = getDaprSidecarUrl();
  try {
    const url = new URL(
      `${sidecarUrl}/v1.0/state/${encodeURIComponent(storeName)}/${encodeURIComponent(key)}`,
    );
    url.searchParams.set("consistency", "strong");
    for (const [metaKey, metaValue] of Object.entries(metadata)) {
      url.searchParams.set(`metadata.${metaKey}`, metaValue);
    }

    const res = await daprFetch(url.toString(), { maxRetries: 1 });
    if (res.status === 204 || res.status === 404) {
      return { found: false, value: null, etag: null };
    }
    if (!res.ok) {
      return {
        found: false,
        value: null,
        etag: null,
        error: `HTTP ${res.status} — store "${storeName}" may not be in scope for this app's sidecar.`,
      };
    }
    const rawText = await res.text();
    const etag =
      res.headers.get("etag")?.replace(/^W\//, "").replace(/^"|"$/g, "") ??
      null;
    let value: unknown;
    try {
      value = JSON.parse(rawText);
    } catch {
      value = rawText;
    }
    return { found: true, value, etag };
  } catch (err) {
    return {
      found: false,
      value: null,
      etag: null,
      error: err instanceof Error ? err.message : "Sidecar unreachable",
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
}

function agentRegistryStore(): string {
  return env.DAPR_AGENT_REGISTRY_STORE?.trim() || DEFAULT_AGENT_REGISTRY_STORE;
}

function agentRegistryTeams(): string[] {
  const configured =
    env.DAPR_AGENT_REGISTRY_TEAMS ||
    env.AGENT_REGISTRY_TEAM ||
    DEFAULT_AGENT_REGISTRY_TEAM;
  const teams = configured
    .split(",")
    .map((team) => team.trim())
    .filter(Boolean);
  return teams.length
    ? Array.from(new Set(teams))
    : [DEFAULT_AGENT_REGISTRY_TEAM];
}

function teamRegistryKey(team: string): string {
  return `agents:${team}`;
}

function registryIndexKey(team: string): string {
  return `${teamRegistryKey(team)}:_index`;
}

function agentRegistryKey(team: string, agentName: string): string {
  return `${teamRegistryKey(team)}:${agentName}`;
}

function metadataString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return null;
}

function registryStateMetadata(team: string): Record<string, string> {
  return { partitionKey: teamRegistryKey(team) };
}

async function invokeApp(appId: string, path: string): Promise<Response> {
  const sidecarUrl = getDaprSidecarUrl();
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  return daprFetch(
    `${sidecarUrl}/v1.0/invoke/${encodeURIComponent(appId)}/method/${normalizedPath}`,
    { maxRetries: 1 },
  );
}

function normalizeWorkflowRegistrations(
  serviceId: string,
  value: unknown,
): WorkflowRegistration[] {
  const records = Array.isArray(value) ? value : [];
  return records.map((record, index) => {
    if (typeof record === "string") {
      return { serviceId, name: record };
    }
    const item = asRecord(record);
    const name =
      asString(item.name) ??
      asString(item.workflowName) ??
      asString(item.id) ??
      `workflow-${index + 1}`;
    const version =
      asString(item.version) ?? asString(item.workflowVersion) ?? undefined;
    return { serviceId, name, ...(version ? { version } : {}), metadata: item };
  });
}

async function loadWorkflowRegistrations(): Promise<WorkflowRegistration[]> {
  const services = getWorkflowCapableServices();
  const results = await Promise.allSettled(
    services.map(async (svc) => {
      const res = await invokeApp(svc.id, svc.introspectPath);
      if (!res.ok) return [];
      const raw = (await res.json()) as Record<string, unknown>;
      return normalizeWorkflowRegistrations(svc.id, raw.registeredWorkflows);
    }),
  );

  return results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
}

async function loadDaprAgentRegistry(): Promise<{
  agents: AgentRegistryEntry[];
  storeName: string;
  teams: string[];
  diagnostics: string[];
}> {
  const storeName = agentRegistryStore();
  const teams = agentRegistryTeams();
  const agents: AgentRegistryEntry[] = [];
  const diagnostics: string[] = [];

  for (const team of teams) {
    const indexKey = registryIndexKey(team);
    const index = await readStateLocal(
      storeName,
      indexKey,
      registryStateMetadata(team),
    );
    if (!index.found) {
      diagnostics.push(
        `No Dapr agent registry index found at ${storeName}/${indexKey}${index.error ? `: ${index.error}` : ""}`,
      );
      continue;
    }

    const agentNames = asStringArray(asRecord(index.value).agents);
    if (!agentNames.length) {
      diagnostics.push(
        `Dapr agent registry index ${storeName}/${indexKey} has no agent entries`,
      );
      continue;
    }

    for (const agentName of Array.from(new Set(agentNames)).sort((a, b) =>
      a.localeCompare(b),
    )) {
      const key = agentRegistryKey(team, agentName);
      const state = await readStateLocal(
        storeName,
        key,
        registryStateMetadata(team),
      );
      if (!state.found) {
        diagnostics.push(
          `Registry index references missing agent key ${storeName}/${key}`,
        );
        continue;
      }

      const record = asRecord(state.value);
      const agent = asRecord(record.agent);
      const agentMetadata = asRecord(agent.metadata);
      const stateStore = metadataString(
        agentMetadata,
        "stateStore",
        "state_store",
        "state_store_name",
      );
      const stateKey = metadataString(agentMetadata, "stateKey", "state_key");
      const stateKeyPrefix = metadataString(
        agentMetadata,
        "stateKeyPrefix",
        "state_key_prefix",
      );
      const instancesEndpoint = metadataString(
        agentMetadata,
        "instancesEndpoint",
        "instances_endpoint",
      );
      const instanceCount =
        asString(agent.appid) && instancesEndpoint
          ? await countDaprAgentInstancesViaService(
              asString(agent.appid) ?? agentName,
              agentName,
              instancesEndpoint,
            )
          : stateStore && stateKey
          ? await countDaprAgentInstances(stateStore, agentName, stateKey)
          : null;

      agents.push({
        name: asString(record.name) ?? agentName,
        metadata: {
          source: "dapr-agent-registry",
          team,
          registryStore: storeName,
          registryKey: key,
          schemaVersion: asString(record.version),
          registeredAt: asString(record.registered_at),
          appId: asString(agent.appid),
          type: asString(agent.type),
          framework: asString(agent.framework),
          role: asString(agent.role),
          goal: asString(agent.goal),
          ...(stateStore ? { storeName: stateStore } : {}),
          ...(stateKey ? { stateKey } : {}),
          ...(stateKeyPrefix ? { stateKeyPrefix } : {}),
          ...(instancesEndpoint ? { instancesEndpoint } : {}),
          ...(instanceCount != null ? { instanceCount } : {}),
          registryRecord: record,
        },
      });
    }
  }

  return { agents, storeName, teams, diagnostics };
}

function isAgentStateInstance(value: unknown): value is AgentStateInstance {
  const record = asRecord(value);
  return Array.isArray(record.messages) && Array.isArray(record.tool_history);
}

function normalizeDaprAgentInstance(
  agentName: string,
  instanceId: string,
  value: unknown,
): AgentStateInstance | null {
  if (!isAgentStateInstance(value)) return null;
  return {
    ...value,
    workflow_instance_id: value.workflow_instance_id ?? instanceId,
    workflow_name: value.workflow_name ?? agentName,
    source: value.source ?? "dapr-state",
  };
}

async function countDaprAgentInstances(
  storeName: string,
  agentName: string,
  stateKey: string,
): Promise<number> {
  const state = await readDaprAgentState(storeName, agentName, stateKey);
  return Object.keys(state.instances).length;
}

async function countDaprAgentInstancesViaService(
  appId: string,
  agentName: string,
  instancesEndpoint: string,
): Promise<number> {
  const state = await readDaprAgentStateViaService(
    appId,
    agentName,
    instancesEndpoint,
  );
  return Object.keys(state.instances).length;
}

async function readDaprAgentStateViaService(
  appId: string,
  agentName: string,
  instancesEndpoint: string,
): Promise<{
  source: "dapr-state";
  storeName: string;
  agentName: string;
  stateKey: string;
  found: boolean;
  error?: string;
  instances: Record<string, AgentStateInstance>;
}> {
  const res = await invokeApp(
    appId,
    `${instancesEndpoint.replace(/^\//, "")}?limit=200`,
  );
  if (!res.ok) {
    return {
      source: "dapr-state",
      storeName: "",
      agentName,
      stateKey: instancesEndpoint,
      found: false,
      error: `Agent ${appId} returned HTTP ${res.status} from ${instancesEndpoint}`,
      instances: {},
    };
  }
  const payload = (await res.json()) as {
    storeName?: string;
    stateKey?: string;
    found?: boolean;
    instances?: Record<string, unknown>;
    error?: string;
  };
  const instances: Record<string, AgentStateInstance> = {};
  for (const [instanceId, instance] of Object.entries(payload.instances ?? {})) {
    const normalized = normalizeDaprAgentInstance(agentName, instanceId, instance);
    if (normalized) instances[instanceId] = normalized;
  }
  return {
    source: "dapr-state",
    storeName: payload.storeName ?? "",
    agentName,
    stateKey: payload.stateKey ?? instancesEndpoint,
    found: payload.found ?? Object.keys(instances).length > 0,
    ...(payload.error ? { error: payload.error } : {}),
    instances,
  };
}

async function readDaprAgentState(
  storeName: string,
  agentName: string,
  stateKey: string,
): Promise<{
  source: "dapr-state";
  storeName: string;
  agentName: string;
  stateKey: string;
  found: boolean;
  error?: string;
  instances: Record<string, AgentStateInstance>;
}> {
  const result = await readStateLocal(storeName, stateKey);
  const rawInstances = asRecord(asRecord(result.value).instances);
  const instances: Record<string, AgentStateInstance> = {};

  for (const [instanceId, instance] of Object.entries(rawInstances)) {
    const normalized = normalizeDaprAgentInstance(
      agentName,
      instanceId,
      instance,
    );
    if (normalized) instances[instanceId] = normalized;
  }

  return {
    source: "dapr-state",
    storeName,
    agentName,
    stateKey,
    found: result.found,
    ...(result.error ? { error: result.error } : {}),
    instances,
  };
}

// ---------------------------------------------------------------------------
// Tab 1: Overview
// ---------------------------------------------------------------------------

export const getSidecarMetadata = query(async () => {
  const sidecarUrl = getDaprSidecarUrl();
  let metadata: SidecarMetadata | null = null;
  let healthy = false;

  try {
    const [metaRes, healthRes] = await Promise.allSettled([
      daprFetch(`${sidecarUrl}/v1.0/metadata`, { maxRetries: 1 }),
      daprFetch(`${sidecarUrl}/v1.0/healthz`, { maxRetries: 1 }),
    ]);

    if (metaRes.status === "fulfilled" && metaRes.value.ok) {
      metadata = (await metaRes.value.json()) as SidecarMetadata;
    }
    healthy = healthRes.status === "fulfilled" && healthRes.value.ok;
  } catch {
    // sidecar unavailable
  }

  return { metadata, healthy };
});

export const getServiceHealth = query(async () => {
  const services = getWorkflowCapableServices();

  const results = await Promise.allSettled(
    services.map(async (svc) => {
      const res = await invokeApp(svc.id, svc.introspectPath);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return {
        serviceId: svc.id,
        data: (await res.json()) as Record<string, unknown>,
      };
    }),
  );

  const entries: ServiceHealthEntry[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const serviceId = services[i].id;

    if (result.status === "rejected") {
      entries.push({
        id: serviceId,
        healthy: false,
        version: "unknown",
        runtime: "unknown",
        workflowCount: 0,
        activityCount: 0,
        features: [],
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      });
      continue;
    }

    const raw = result.value.data;
    entries.push({
      id: serviceId,
      healthy: Boolean(raw.ready),
      version: String(raw.version || "unknown"),
      runtime: String(raw.runtime || "unknown"),
      workflowCount: Array.isArray(raw.registeredWorkflows)
        ? raw.registeredWorkflows.length
        : 0,
      activityCount: Array.isArray(raw.registeredActivities)
        ? raw.registeredActivities.length
        : 0,
      features: Array.isArray(raw.features) ? (raw.features as string[]) : [],
    });
  }

  return entries;
});

// ---------------------------------------------------------------------------
// Tab 2: State Inspector
// ---------------------------------------------------------------------------

export const getStateValue = query(
  "unchecked",
  async ({
    storeName,
    key,
    metadata,
  }: {
    storeName: string;
    key: string;
    metadata?: Record<string, string>;
  }) => {
    return await readStateLocal(storeName, key, metadata ?? {});
  },
);

export const getKnownStateKeys = query(async () => {
  const keys: KnownStateKeys = { agents: [], conversations: [] };
  const registry = await loadDaprAgentRegistry();

  for (const team of registry.teams) {
    keys.agents.push({
      key: registryIndexKey(team),
      label: `Dapr Agent Registry index (${team})`,
      storeName: registry.storeName,
      serviceId: "dapr-agent-registry",
      metadata: registryStateMetadata(team),
    });
  }

  for (const agent of registry.agents) {
    const meta = agent.metadata;
    const team =
      typeof meta.team === "string" ? meta.team : DEFAULT_AGENT_REGISTRY_TEAM;
    keys.agents.push({
      key:
        typeof meta.registryKey === "string"
          ? meta.registryKey
          : agentRegistryKey(team, agent.name),
      label: `${agent.name} (registry record)`,
      storeName: registry.storeName,
      serviceId: typeof meta.appId === "string" ? meta.appId : agent.name,
      metadata: registryStateMetadata(team),
    });

    if (
      typeof meta.storeName === "string" &&
      typeof meta.stateKey === "string"
    ) {
      keys.agents.push({
        key: meta.stateKey,
        label: `${agent.name} (execution state)`,
        storeName: meta.storeName,
        serviceId: typeof meta.appId === "string" ? meta.appId : agent.name,
      });
    }
  }

  return keys;
});

// ---------------------------------------------------------------------------
// Tab 3: Workflows
// ---------------------------------------------------------------------------

export const getWorkflowSummary = query(async () => {
  let instances: WorkflowInstance[] = [];
  let orchestratorError: string | undefined;
  const registrations = await loadWorkflowRegistrations();

  try {
    const res = await invokeApp(
      "workflow-orchestrator",
      "/api/v2/workflows?limit=100",
    );
    if (res.ok) {
      const data = await res.json();
      instances = (
        Array.isArray(data) ? data : data.workflows || []
      ) as WorkflowInstance[];
    } else {
      const detail = await res.text();
      orchestratorError = `Orchestrator returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`;
    }
  } catch (err) {
    orchestratorError =
      err instanceof Error ? err.message : "Orchestrator unreachable";
  }

  const summary = {
    running: 0,
    completed: 0,
    failed: 0,
    total: instances.length,
  };

  for (const inst of instances) {
    const s = (inst.runtimeStatus || inst.status || "").toUpperCase();
    if (s === "RUNNING" || s === "SUSPENDED" || s === "PENDING")
      summary.running++;
    else if (s === "COMPLETED" || s === "SUCCESS") summary.completed++;
    else if (s === "FAILED" || s === "ERROR") summary.failed++;
  }

  return {
    summary,
    instances: instances.slice(0, 50),
    registrations,
    orchestratorError,
    discovery: {
      registrations:
        "Registered workflows are discovered from workflow-capable services via Dapr service invocation to their runtime introspection endpoints.",
      executions:
        "Workflow executions are queried from workflow-orchestrator through Dapr service invocation; workflow-orchestrator reads the Dapr workflow TaskHub instance state.",
    },
  };
});

export const getWorkflowHistory = query(
  "unchecked",
  async (instanceId: string) => {
    try {
      const res = await invokeApp(
        "workflow-orchestrator",
        `/api/v2/workflows/${encodeURIComponent(instanceId)}/history`,
      );
      if (!res.ok)
        return {
          events: [] as WorkflowHistoryEvent[],
          error: `HTTP ${res.status}`,
        };
      const data = await res.json();
      return { events: (data.events || []) as WorkflowHistoryEvent[] };
    } catch (err) {
      return {
        events: [] as WorkflowHistoryEvent[],
        error: err instanceof Error ? err.message : "Failed to fetch history",
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tab 4: Agents — fetch from Dapr Agent Registry state store
// ---------------------------------------------------------------------------

export const getAgentRegistry = query(async () => {
  const registry = await loadDaprAgentRegistry();
  return {
    ...registry,
    discovery: {
      definitions:
        "Agent definitions are discovered from the Dapr Agent Registry state store index and agent records.",
      executions:
        "Agent executions are read from Dapr-owned agent instance endpoints or from Dapr state keys declared in each registry record. Dapr state stores do not provide a portable key scan API, so each agent must publish a deterministic execution listing contract.",
    },
  };
});

export const getAgentDaprState = query(
  "unchecked",
  async ({
    agentName,
    storeName,
    stateKey,
    appId,
    instancesEndpoint,
  }: {
    agentName: string;
    storeName?: string | null;
    stateKey?: string | null;
    appId?: string | null;
    instancesEndpoint?: string | null;
  }) => {
    if (appId && instancesEndpoint) {
      return readDaprAgentStateViaService(appId, agentName, instancesEndpoint);
    }
    if (!storeName || !stateKey) {
      return {
        source: "dapr-state" as const,
        storeName: storeName ?? "",
        agentName,
        stateKey: stateKey ?? "",
        found: false,
        error:
          "This agent registry record does not declare metadata.instancesEndpoint or metadata.stateStore plus metadata.stateKey, so executions cannot be enumerated deterministically from Dapr state.",
        instances: {} as Record<string, AgentStateInstance>,
      };
    }
    return readDaprAgentState(storeName, agentName, stateKey);
  },
);
