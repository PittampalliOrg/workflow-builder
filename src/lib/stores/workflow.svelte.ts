import type { Node, Edge } from "@xyflow/svelte";
import {
  createHistoryStore,
  type HistorySnapshot,
} from "./history-store.svelte";
import { normalizeAgentTaskConfig } from "$lib/types/agent-graph";

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
  return JSON.parse(JSON.stringify(value)) as T;
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
  let workflowName = $state("Untitled Workflow");
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

  // UI state
  let activeConfigTab = $state("runs");
  let showMinimap = $state(true);
  let showRunsPanel = $state(true);

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

  function removeNode(id: string) {
    pushHistory();
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
  }

  function removeEdge(id: string) {
    pushHistory();
    edges = edges.filter((e) => e.id !== id);
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
  ) {
    workflowId = id;
    workflowName = name;
    spec = loadedSpec || null;

    // Load nodes/edges (will be rebuilt from spec if available)
    nodes = loadedNodes;
    edges = loadedEdges;

    // If spec exists, derive nodes/edges from it (async, client-side only)
    if (
      spec &&
      Array.isArray((spec as Record<string, unknown>).do) &&
      typeof window !== "undefined"
    ) {
      import("$lib/utils/spec-graph-adapter")
        .then(({ specToGraph }) => {
          const graph = specToGraph(spec!);
          if (graph) {
            nodes = graph.nodes as WorkflowNode[];
            edges = graph.edges as WorkflowEdge[];
          }
        })
        .catch(() => {});
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
    insertAfter?: string,
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
    const doArray = ((spec as Record<string, unknown>).do || []) as Array<
      Record<string, unknown>
    >;

    if (insertAfter) {
      // Insert after a specific task
      const idx = doArray.findIndex(
        (entry) => Object.keys(entry)[0] === insertAfter,
      );
      if (idx >= 0) {
        doArray.splice(idx + 1, 0, { [name]: taskDef });
      } else {
        doArray.push({ [name]: taskDef });
      }
    } else {
      doArray.push({ [name]: taskDef });
    }

    spec = { ...spec, do: doArray };
    await rebuildGraphFromSpec();
    return name;
  }

  /** Update a task in the spec's do array */
  async function updateTask(name: string, taskDef: Record<string, unknown>) {
    if (!spec) return;
    pushHistory();
    const doArray = ((spec as Record<string, unknown>).do || []) as Array<
      Record<string, unknown>
    >;
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
    isDirty = true;
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
