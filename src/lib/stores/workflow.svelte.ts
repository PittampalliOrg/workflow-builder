import type { Node, Edge } from "@xyflow/svelte";
import {
  createHistoryStore,
  type HistorySnapshot,
} from "./history-store.svelte";
import { normalizeAgentTaskConfig } from "$lib/types/agent-graph";
import {
  createLayoutConfig,
  DEFAULT_LAYOUT_CONFIG,
  type WorkflowLayoutConfig,
} from "$lib/utils/layout";
import {
  insertTaskAfter,
  removeTask as removeSpecTask,
  reorderLinearTasksFromEdges,
} from "$lib/helpers/spec-mutations";

// CNCF Serverless Workflow 1.0 node types (SW 1.0 only)
export type WorkflowNodeType =
  | "start"
  | "end"
  | "call"
  | "agent"
  | "set"
  | "switch"
  | "wait"
  | "emit"
  | "listen"
  | "for"
  | "fork"
  | "try"
  | "run"
  | "raise"
  | "do";

export type NodeStatus = "idle" | "running" | "success" | "error";

export interface WorkflowNodeData extends Record<string, unknown> {
  label: string;
  description?: string;
  type: WorkflowNodeType;
  config?: Record<string, unknown>;
  taskConfig?: Record<string, unknown>;
  status?: NodeStatus;
  enabled?: boolean;
}

export type WorkflowNode = Node<WorkflowNodeData>;
export type WorkflowEdge = Edge;

function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value;
  return structuredClone(value);
}

function snapshotNode(node: WorkflowNode): WorkflowNode {
  return {
    id: node.id,
    type: node.type,
    position: { x: node.position.x, y: node.position.y },
    data: cloneJsonValue(node.data),
    ...(node.selected !== undefined ? { selected: node.selected } : {}),
    ...(node.dragging !== undefined ? { dragging: node.dragging } : {}),
    ...(node.hidden !== undefined ? { hidden: node.hidden } : {}),
    ...(node.width !== undefined ? { width: node.width } : {}),
    ...(node.height !== undefined ? { height: node.height } : {}),
    ...(node.measured ? { measured: cloneJsonValue(node.measured) } : {}),
    ...(node.sourcePosition ? { sourcePosition: node.sourcePosition } : {}),
    ...(node.targetPosition ? { targetPosition: node.targetPosition } : {}),
    ...(node.connectable !== undefined ? { connectable: node.connectable } : {}),
    ...(node.deletable !== undefined ? { deletable: node.deletable } : {}),
    ...(node.draggable !== undefined ? { draggable: node.draggable } : {}),
    ...(node.selectable !== undefined ? { selectable: node.selectable } : {}),
    ...(node.parentId ? { parentId: node.parentId } : {}),
    ...(node.extent ? { extent: cloneJsonValue(node.extent) } : {}),
    ...(node.expandParent !== undefined ? { expandParent: node.expandParent } : {}),
    ...(node.zIndex !== undefined ? { zIndex: node.zIndex } : {}),
    ...(node.style ? { style: cloneJsonValue(node.style) } : {}),
    ...(node.class ? { class: node.class } : {})
  } as WorkflowNode;
}

function snapshotEdge(edge: WorkflowEdge): WorkflowEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
    ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
    ...(edge.type ? { type: edge.type } : {}),
    ...(edge.label !== undefined ? { label: cloneJsonValue(edge.label) } : {}),
    ...(edge.animated !== undefined ? { animated: edge.animated } : {}),
    ...(edge.hidden !== undefined ? { hidden: edge.hidden } : {}),
    ...(edge.selected !== undefined ? { selected: edge.selected } : {}),
    ...(edge.deletable !== undefined ? { deletable: edge.deletable } : {}),
    ...(edge.selectable !== undefined ? { selectable: edge.selectable } : {}),
    ...(edge.focusable !== undefined ? { focusable: edge.focusable } : {}),
    ...(edge.style ? { style: cloneJsonValue(edge.style) } : {}),
    ...(edge.class ? { class: edge.class } : {}),
    ...(edge.zIndex !== undefined ? { zIndex: edge.zIndex } : {}),
    ...(edge.data ? { data: cloneJsonValue(edge.data) } : {}),
    ...(edge.markerStart ? { markerStart: cloneJsonValue(edge.markerStart) } : {}),
    ...(edge.markerEnd ? { markerEnd: cloneJsonValue(edge.markerEnd) } : {})
  } as WorkflowEdge;
}

function buildDefaultNodeData(
  type: WorkflowNodeType,
  label?: string,
): WorkflowNodeData {
  const resolvedLabel = label || type.charAt(0).toUpperCase() + type.slice(1);
  const data: WorkflowNodeData = {
    label: resolvedLabel,
    type,
    status: "idle",
    enabled: true,
  };

  if (type === "agent") {
    data.taskConfig = normalizeAgentTaskConfig(undefined, resolvedLabel);
  }

  return data;
}

function taskNameFromNodeId(nodeId: string): string | null {
  if (!nodeId || nodeId === "__start__" || nodeId === "__end__") return null;
  if (nodeId.startsWith("/do/")) {
    const parts = nodeId.split("/");
    return parts[parts.length - 1] || null;
  }
  return nodeId;
}

function hasPosition(node: WorkflowNode): boolean {
  return (
    typeof node.position?.x === "number" &&
    Number.isFinite(node.position.x) &&
    typeof node.position?.y === "number" &&
    Number.isFinite(node.position.y)
  );
}

function normalizeLoadedNodes(loadedNodes: WorkflowNode[]): WorkflowNode[] {
  return loadedNodes.map((node, index) => ({
    ...node,
    position: hasPosition(node) ? node.position : { x: index * 260, y: 0 },
    type: (node.type || "default") as WorkflowNodeType,
    data: {
      ...node.data,
      label:
        typeof node.data?.label === "string" && node.data.label.trim()
          ? node.data.label
          : node.id,
      type: (node.data?.type || node.type || "default") as WorkflowNodeType,
      status: node.data?.status ?? "idle",
      enabled: node.data?.enabled ?? true,
    },
  }));
}

export function createWorkflowStore() {
  // Canvas state — $state.raw avoids deep proxy overhead on large arrays
  let nodes = $state.raw<WorkflowNode[]>([]);
  let edges = $state.raw<WorkflowEdge[]>([]);
  let selectedNodeId = $state<string | null>(null);
  let selectedEdgeId = $state<string | null>(null);

  // SW 1.0 Spec — source of truth for execution
  let spec = $state<Record<string, unknown> | null>(null);

  // Per-task catalog metadata cache (survives graph rebuilds)
  let taskMetadata = $state<Record<string, Record<string, unknown>>>({});

  // Workflow metadata
  let workflowId = $state<string | null>(null);
  // ── Code-first authoring (dynamic-script): shared draft + code⇄canvas sync ─
  // The DRAFT is the single unsaved edit buffer shared by the code panel and
  // the canvas projection; null = clean (canvas renders the saved source).
  let scriptDraft = $state<string | null>(null);
  let scriptCursorLine = $state<number | null>(null);
  let scriptRevealRequest = $state<{ line: number; nonce: number } | null>(null);
  let scriptRevealNonce = 0;
  // One-shot intent prefill for the AI author panel (e.g. legacy → script
  // conversion CTA); the panel consumes and clears it.
  let authorIntent = $state<string | null>(null);
  let workflowName = $state("Untitled Workflow");
  let engineType = $state<string | null>(null);
  let isSaving = $state(false);
  let isLoading = $state(false);
  let publishedRuntime = $state<Record<string, unknown> | null>(null);

  // Version-based dirty detection (O(1) instead of boolean)
  let _editVersion = $state(0);
  let _savedVersion = $state(0);
  let isDirty = $derived(_editVersion !== _savedVersion);

  // Execution state
  let currentRunningNodeId = $state<string | null>(null);
  let selectedExecutionId = $state<string | null>(null);
  let focusedRunNode = $state<string | null>(null);
  let executionFollowMode = $state(true);
  let executionFollowSuppressUntil = $state(0);

  // UI state
  let activeConfigTab = $state("runs");
  let showMinimap = $state(true);
  let showRunsPanel = $state(true);
  let layoutConfig = $state<WorkflowLayoutConfig>(createLayoutConfig());
  let layoutConfigTouched = $state(false);

  // History integration
  const history = createHistoryStore();

  // Derived
  let selectedNode = $derived(
    selectedNodeId
      ? (nodes.find((n) => n.id === selectedNodeId) ?? null)
      : null,
  );
  let nodeCount = $derived(nodes.length);

  function _snapshot(): HistorySnapshot {
    return {
      nodes: nodes.map(snapshotNode),
      edges: edges.map(snapshotEdge),
    };
  }

  function pushHistory() {
    history.pushState(_snapshot());
    _editVersion++;
  }

  function undo() {
    const entry = history.undo(_snapshot);
    if (entry) {
      nodes = entry.nodes as WorkflowNode[];
      edges = entry.edges as WorkflowEdge[];
    }
  }

  function redo() {
    const entry = history.redo(_snapshot);
    if (entry) {
      nodes = entry.nodes as WorkflowNode[];
      edges = entry.edges as WorkflowEdge[];
    }
  }

  function addNode(
    type: WorkflowNodeType,
    position: { x: number; y: number },
    label?: string,
  ) {
    pushHistory();
    const id = crypto.randomUUID();
    const newNode: WorkflowNode = {
      id,
      type,
      position,
      data: buildDefaultNodeData(type, label),
    };
    nodes = [...nodes, newNode];
    selectedNodeId = id;
    return id;
  }

  function duplicateNode(
    id: string,
    positionOverride?: { x: number; y: number },
  ) {
    const node = nodes.find((candidate) => candidate.id === id);
    if (!node) return null;
    const resolvedType =
      typeof node.type === "string" &&
      [
        "start",
        "end",
        "call",
        "agent",
        "set",
        "switch",
        "wait",
        "emit",
        "listen",
        "for",
        "fork",
        "try",
        "run",
        "raise",
        "do",
      ].includes(node.type)
        ? (node.type as WorkflowNodeType)
        : ((node.data?.type as WorkflowNodeType | undefined) ?? "call");

    pushHistory();
    const nextId = crypto.randomUUID();
    const nextPosition = positionOverride ?? {
      x: node.position.x + 50,
      y: node.position.y + 50,
    };
    const nextLabel =
      typeof node.data?.label === "string" && node.data.label.trim().length > 0
        ? node.data.label
        : resolvedType.charAt(0).toUpperCase() + resolvedType.slice(1);
    const nextData = cloneJsonValue(node.data ?? {});

    if (resolvedType === "agent") {
      nextData.taskConfig = normalizeAgentTaskConfig(
        nextData.taskConfig as Record<string, unknown> | undefined,
        nextLabel,
      );
    }

    const newNode: WorkflowNode = {
      ...snapshotNode(node),
      id: nextId,
      type: resolvedType,
      position: nextPosition,
      selected: false,
      data: {
        ...buildDefaultNodeData(resolvedType, nextLabel),
        ...nextData,
        label: nextLabel,
        type: resolvedType,
        status: "idle",
      },
    };

    nodes = [...nodes, newNode];
    selectedNodeId = nextId;
    return nextId;
  }

  async function removeNode(id: string) {
    pushHistory();
    const taskName = spec ? taskNameFromNodeId(id) : null;
    const doArray = spec
      ? (((spec as Record<string, unknown>).do || []) as Array<
          Record<string, unknown>
        >)
      : [];
    if (taskName && doArray.some((entry) => Object.keys(entry)[0] === taskName)) {
      spec = removeSpecTask(spec!, taskName);
      await rebuildGraphFromSpec();
      if (selectedNodeId === id) selectedNodeId = null;
      return;
    }
    nodes = nodes.filter((n) => n.id !== id);
    edges = edges.filter((e) => e.source !== id && e.target !== id);
    if (selectedNodeId === id) selectedNodeId = null;
  }

  function updateNodeData(id: string, data: Partial<WorkflowNodeData>) {
    pushHistory();
    nodes = nodes.map((n) =>
      n.id === id ? { ...n, data: { ...n.data, ...data } } : n,
    );
  }

  function updateNodeStatus(id: string, status: NodeStatus) {
    nodes = nodes.map((n) =>
      n.id === id ? { ...n, data: { ...n.data, status } } : n,
    );
  }

  function addEdge(
    source: string,
    target: string,
    sourceHandle?: string,
    targetHandle?: string,
  ) {
    pushHistory();
    const id = sourceHandle
      ? `${source}-${sourceHandle}-${target}`
      : `${source}-${target}`;
    if (edges.some((e) => e.id === id)) return;
    const newEdge: WorkflowEdge = { id, source, target };
    if (sourceHandle) newEdge.sourceHandle = sourceHandle;
    if (targetHandle) newEdge.targetHandle = targetHandle;
    edges = [...edges, newEdge];
    if (spec) {
      spec = reorderLinearTasksFromEdges(spec, edges);
    }
  }

  function removeEdge(id: string) {
    pushHistory();
    edges = edges.filter((e) => e.id !== id);
  }

  function setLayoutConfig(
    next: Partial<WorkflowLayoutConfig>,
    options: { touched?: boolean } = {},
  ) {
    layoutConfig = createLayoutConfig(next, layoutConfig);
    if (options.touched ?? true) {
      layoutConfigTouched = true;
    }
  }

  function resetLayoutConfig(options: { touched?: boolean } = {}) {
    layoutConfig = createLayoutConfig({}, DEFAULT_LAYOUT_CONFIG);
    if (options.touched ?? true) {
      layoutConfigTouched = true;
    }
  }

  function insertNodeOnEdge(
    edgeId: string,
    nodeType: WorkflowNodeType,
    position: { x: number; y: number },
  ) {
    const edge = edges.find((e) => e.id === edgeId);
    if (!edge) return;

    pushHistory();
    const newId = crypto.randomUUID();
    const newNode: WorkflowNode = {
      id: newId,
      type: nodeType,
      position,
      data: buildDefaultNodeData(nodeType),
    };

    // Remove old edge, add node, add two new edges
    edges = edges.filter((e) => e.id !== edgeId);
    nodes = [...nodes, newNode];
    const edgeBefore: WorkflowEdge = {
      id: `${edge.source}-${newId}`,
      source: edge.source,
      target: newId,
    };
    if (edge.sourceHandle) edgeBefore.sourceHandle = edge.sourceHandle;
    const edgeAfter: WorkflowEdge = {
      id: `${newId}-${edge.target}`,
      source: newId,
      target: edge.target,
    };
    if (edge.targetHandle) edgeAfter.targetHandle = edge.targetHandle;
    edges = [...edges, edgeBefore, edgeAfter];
    selectedNodeId = newId;
    return newId;
  }

  function getSelectedNodes(): WorkflowNode[] {
    return nodes.filter((n) => n.selected);
  }

  function getSelectedEdges(): WorkflowEdge[] {
    return edges.filter((e) => e.selected);
  }

  function loadWorkflow(
    id: string,
    name: string,
    loadedNodes: WorkflowNode[],
    loadedEdges: WorkflowEdge[],
    loadedSpec?: Record<string, unknown> | null,
    loadedEngineType?: string | null,
  ) {
    workflowId = id;
    workflowName = name;
    scriptDraft = null;
    scriptCursorLine = null;
    spec = loadedSpec || null;
    engineType =
      loadedEngineType ??
      (spec && typeof (spec as Record<string, unknown>).engine === "string"
        ? ((spec as Record<string, unknown>).engine as string)
        : null);
    layoutConfig = createLayoutConfig({}, DEFAULT_LAYOUT_CONFIG);
    layoutConfigTouched = false;
    executionFollowMode = true;
    executionFollowSuppressUntil = 0;
    currentRunningNodeId = null;
    selectedExecutionId = null;

    const shouldDeriveGraphFromSpec =
      spec &&
      Array.isArray((spec as Record<string, unknown>).do) &&
      typeof window !== "undefined";

    // Spec is the source of truth. Avoid rendering stale persisted graph rows before
    // the spec-derived graph is ready because old rows may be incomplete.
    nodes = shouldDeriveGraphFromSpec ? [] : normalizeLoadedNodes(loadedNodes);
    edges = shouldDeriveGraphFromSpec ? [] : loadedEdges;

    // If spec exists, derive nodes/edges from it (async, client-side only)
    if (shouldDeriveGraphFromSpec) {
      void rebuildGraphFromSpec();
    }

    history.clear();
    _editVersion = 0;
    _savedVersion = 0;
    selectedNodeId = null;
    selectedEdgeId = null;
  }

  /** Rebuild nodes/edges from spec, preserving cached catalog metadata */
  async function rebuildGraphFromSpec() {
    if (!spec) return;
    // Dynamic-script specs have no SW 1.0 `do` graph — the ScriptCanvas
    // derives its structure preview from spec.script directly.
    if ((spec as Record<string, unknown>).engine === "dynamic-script") return;
    try {
      const { specToGraph } = await import("$lib/utils/spec-graph-adapter");
      const graph = specToGraph(spec, taskMetadata);
      if (graph) {
        nodes = graph.nodes as WorkflowNode[];
        edges = graph.edges as WorkflowEdge[];
      }
    } catch (err) {
      console.warn("[workflow] Failed to rebuild graph from spec:", err);
    }
  }

  function setTaskMetadata(
    taskName: string,
    metadata: Record<string, unknown>,
  ) {
    taskMetadata = { ...taskMetadata, [taskName]: metadata };
  }

  /** Add a task to the spec's do array and rebuild graph. Returns a promise that resolves after graph rebuild. */
  async function addTask(
    name: string,
    taskDef: Record<string, unknown>,
    insertAfter?: string | null,
  ) {
    if (!spec) {
      spec = {
        document: {
          dsl: "1.0.0",
          namespace: "workflow-builder",
          name:
            workflowName
              .toLowerCase()
              .replace(/[^a-z0-9-]/g, "-")
              .replace(/-+/g, "-") || "untitled",
          version: "1.0.0",
          title: workflowName,
        },
        do: [],
      };
    }
    pushHistory();
    spec = insertTaskAfter(spec, name, taskDef, insertAfter);
    await rebuildGraphFromSpec();
    return name;
  }

  /** Update a task in the spec's do array */
  async function updateTask(name: string, taskDef: Record<string, unknown>) {
    if (!spec) return;
    pushHistory();
    const doArray = [...(((spec as Record<string, unknown>).do || []) as Array<
      Record<string, unknown>
    >)];
    const idx = doArray.findIndex((entry) => Object.keys(entry)[0] === name);
    if (idx >= 0) {
      doArray[idx] = {
        [name]: {
          ...(doArray[idx][name] as Record<string, unknown>),
          ...taskDef,
        },
      };
      spec = { ...spec, do: [...doArray] };
      await rebuildGraphFromSpec();
    }
  }

  /** Remove a task from the spec's do array */
  async function removeTask(name: string) {
    if (!spec) return;
    pushHistory();
    const doArray = ((spec as Record<string, unknown>).do || []) as Array<
      Record<string, unknown>
    >;
    spec = {
      ...spec,
      do: doArray.filter((entry) => Object.keys(entry)[0] !== name),
    };
    await rebuildGraphFromSpec();
  }

  /** Apply a new spec and rebuild the graph. Single entry point for all spec changes. */
  async function applySpecAndRebuild(newSpec: Record<string, unknown>) {
    pushHistory();
    spec = newSpec;
    await rebuildGraphFromSpec();
    _editVersion++;
  }

  function markSaved() {
    _savedVersion = _editVersion;
  }

  function clearAll() {
    pushHistory();
    nodes = [];
    edges = [];
    selectedNodeId = null;
    selectedEdgeId = null;
    layoutConfig = createLayoutConfig({}, DEFAULT_LAYOUT_CONFIG);
    layoutConfigTouched = false;
  }

  return {
    // Canvas state (getters/setters for reactivity)
    get nodes() {
      return nodes;
    },
    set nodes(v) {
      nodes = v;
    },
    get edges() {
      return edges;
    },
    set edges(v) {
      edges = v;
    },
    get selectedNodeId() {
      return selectedNodeId;
    },
    set selectedNodeId(v) {
      selectedNodeId = v;
    },
    get selectedEdgeId() {
      return selectedEdgeId;
    },
    set selectedEdgeId(v) {
      selectedEdgeId = v;
    },

    // Spec (SW 1.0 source of truth)
    get spec() {
      return spec;
    },
    set spec(v) {
      spec = v;
    },

    // Metadata
    get workflowId() {
      return workflowId;
    },
    get workflowName() {
      return workflowName;
    },
    get engineType() {
      return engineType;
    },
    /** Dynamic-script workflows: the spec IS a JS script (not an SW 1.0 node
     * graph). Rendered via the read-only ScriptCanvas, not WorkflowCanvas. */
    get isDynamicScript() {
      return (
        engineType === "dynamic-script" ||
        (spec != null &&
          (spec as Record<string, unknown>).engine === "dynamic-script")
      );
    },
    /** The dynamic-script source (spec.script), or "" when absent. */
    get scriptSource() {
      const s = spec as { script?: unknown } | null;
      return s && typeof s.script === "string" ? s.script : "";
    },
    /** Unsaved dynamic-script edit buffer (null = clean). Shared by the code
     * panel (writer) and the canvas (renders draft ?? saved source). */
    get scriptDraft() {
      return scriptDraft;
    },
    set scriptDraft(v: string | null) {
      scriptDraft = v;
    },
    get scriptDirty() {
      return scriptDraft !== null;
    },
    /** Editor cursor line (1-based) — the canvas highlights the matching node. */
    get scriptCursorLine() {
      return scriptCursorLine;
    },
    set scriptCursorLine(v: number | null) {
      scriptCursorLine = v;
    },
    /** Canvas→code jump channel: a node click asks the code panel to reveal a
     * line (nonce so repeat clicks on the same line still fire). */
    get scriptRevealRequest() {
      return scriptRevealRequest;
    },
    requestScriptReveal(line: number) {
      scriptRevealRequest = { line, nonce: ++scriptRevealNonce };
    },
    get authorIntent() {
      return authorIntent;
    },
    set authorIntent(v: string | null) {
      authorIntent = v;
    },
    /** The dynamic-script meta block (spec.meta), or null. */
    get scriptMeta() {
      const s = spec as { meta?: unknown } | null;
      return s && s.meta && typeof s.meta === "object"
        ? (s.meta as Record<string, unknown>)
        : null;
    },
    set workflowName(v) {
      workflowName = v;
      _editVersion++;
    },
    get isSaving() {
      return isSaving;
    },
    set isSaving(v) {
      isSaving = v;
    },
    get isLoading() {
      return isLoading;
    },
    set isLoading(v) {
      isLoading = v;
    },
    get isDirty() {
      return isDirty;
    },
    set isDirty(v) {
      // Legacy compat: setting isDirty = false marks as saved
      if (!v) _savedVersion = _editVersion;
      else _editVersion++;
    },
    get publishedRuntime() {
      return publishedRuntime;
    },
    set publishedRuntime(v) {
      publishedRuntime = v;
    },

    // Execution
    get currentRunningNodeId() {
      return currentRunningNodeId;
    },
    set currentRunningNodeId(v) {
      currentRunningNodeId = v;
    },
    get selectedExecutionId() {
      return selectedExecutionId;
    },
    set selectedExecutionId(v) {
      selectedExecutionId = v;
    },
    // Canvas → run-feed sync: the node the user clicked while watching a run, so the
    // run panel focuses that node's session (the canvas is the rail; the panel is the feed).
    get focusedRunNode() {
      return focusedRunNode;
    },
    set focusedRunNode(v) {
      focusedRunNode = v;
    },
    get executionFollowMode() {
      return executionFollowMode;
    },
    set executionFollowMode(v) {
      executionFollowMode = v;
    },
    get executionFollowSuppressUntil() {
      return executionFollowSuppressUntil;
    },
    set executionFollowSuppressUntil(v) {
      executionFollowSuppressUntil = v;
    },

    // UI
    get activeConfigTab() {
      return activeConfigTab;
    },
    set activeConfigTab(v) {
      activeConfigTab = v;
    },
    get showMinimap() {
      return showMinimap;
    },
    set showMinimap(v) {
      showMinimap = v;
    },
    get showRunsPanel() {
      return showRunsPanel;
    },
    set showRunsPanel(v) {
      showRunsPanel = v;
    },
    get layoutConfig() {
      return layoutConfig;
    },
    set layoutConfig(v) {
      layoutConfig = createLayoutConfig(v, layoutConfig);
      layoutConfigTouched = true;
    },
    get layoutConfigTouched() {
      return layoutConfigTouched;
    },

    // Derived
    get selectedNode() {
      return selectedNode;
    },
    get canUndo() {
      return history.canUndo;
    },
    get canRedo() {
      return history.canRedo;
    },
    get nodeCount() {
      return nodeCount;
    },

    // History
    history,

    // Methods
    pushHistory,
    undo,
    redo,
    addNode,
    duplicateNode,
    removeNode,
    updateNodeData,
    updateNodeStatus,
    addEdge,
    removeEdge,
    setLayoutConfig,
    resetLayoutConfig,
    insertNodeOnEdge,
    getSelectedNodes,
    getSelectedEdges,
    loadWorkflow,
    markSaved,
    clearAll,
    // Spec-first methods
    addTask,
    updateTask,
    removeTask,
    applySpecAndRebuild,
    rebuildGraphFromSpec,
    setTaskMetadata,
  };
}
