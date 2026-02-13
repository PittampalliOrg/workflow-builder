import { useState, useCallback, useEffect, useRef } from "react";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import type { App as McpApp } from "@modelcontextprotocol/ext-apps";
import { WorkflowList } from "./components/WorkflowList";
import { GraphView } from "./components/GraphView";
import { NodeDetail } from "./components/NodeDetail";
import { GraphToolbar } from "./components/GraphToolbar";
import { useWorkflowApi } from "./hooks/useWorkflowApi";

export type WorkflowSummary = {
  id: string;
  name: string;
  description: string | null;
  node_count: number;
  edge_count: number;
};

export type NodeData = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: {
    label: string;
    description?: string;
    type: string;
    config?: Record<string, unknown>;
    status?: string;
    enabled?: boolean;
  };
};

export type EdgeData = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
};

export type Workflow = {
  id: string;
  name: string;
  description: string | null;
  nodes: NodeData[];
  edges: EdgeData[];
  visibility: string;
};

type Tab = "workflows" | "graph" | "node";

export default function App() {
  const { app } = useApp({
    appInfo: { name: "Workflow Builder", version: "1.0.0" },
    onAppCreated: (newApp: McpApp) => {
      newApp.ontoolinput = () => {};
      newApp.ontoolresult = (result: {
        content?: Array<{ type: string; text?: string }>;
      }) => {
        const text = result.content?.find((c) => c.type === "text")?.text;
        if (!text) return;
        try {
          const parsed = JSON.parse(text);
          // Auto-select if a full workflow was returned (has nodes array)
          if (parsed?.id && parsed?.nodes) {
            setWorkflow(parsed);
            setSelectedWorkflowId(parsed.id);
            setActiveTab("graph");
          }
          // Handle add_node / connect_nodes results that wrap workflow
          if (parsed?.workflow?.id && parsed?.workflow?.nodes) {
            setWorkflow(parsed.workflow);
            setSelectedWorkflowId(parsed.workflow.id);
            setActiveTab("graph");
          }
          // Always bump refresh to update sidebar list
          setRefreshKey((k) => k + 1);
        } catch {
          // ignore parse errors
        }
      };
    },
  });
  useHostStyles(app);

  const api = useWorkflowApi(app);

  const [activeTab, setActiveTab] = useState<Tab>("workflows");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loadingWorkflow, setLoadingWorkflow] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

  const showToast = useCallback((message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setSelectedNodeId(null);
  }, []);

  const handleSelectWorkflow = useCallback((wf: WorkflowSummary) => {
    setSelectedWorkflowId(wf.id);
    setActiveTab("graph");
  }, []);

  const handleSelectNode = useCallback((id: string | null) => {
    setSelectedNodeId(id);
    if (id) setActiveTab("node");
  }, []);

  const handleBackToGraph = useCallback(() => {
    setSelectedNodeId(null);
    setActiveTab("graph");
  }, []);

  const handleBackToList = useCallback(() => {
    setWorkflow(null);
    setSelectedWorkflowId(null);
    setSelectedNodeId(null);
    setActiveTab("workflows");
  }, []);

  const handleWorkflowDeleted = useCallback(() => {
    setWorkflow(null);
    setSelectedWorkflowId(null);
    setSelectedNodeId(null);
    setActiveTab("workflows");
    setRefreshKey((k) => k + 1);
    showToast("Workflow deleted");
  }, [showToast]);

  // Load full workflow when selection changes
  useEffect(() => {
    if (!selectedWorkflowId || !app) return;
    let cancelled = false;
    setLoadingWorkflow(true);
    api
      .getWorkflow(selectedWorkflowId)
      .then((data) => {
        if (cancelled) return;
        setWorkflow(data);
        setSelectedNodeId(null);
        setLoadingWorkflow(false);
      })
      .catch(() => {
        if (!cancelled) setLoadingWorkflow(false);
      });
    return () => { cancelled = true; };
  }, [selectedWorkflowId, refreshKey, app]);

  const selectedNode = workflow?.nodes.find((n) => n.id === selectedNodeId) ?? null;

  return (
    <div className="wf-app">
      {/* Tab bar */}
      <div className="tab-bar">
        <button
          className={`tab-btn ${activeTab === "workflows" ? "active" : ""}`}
          onClick={() => setActiveTab("workflows")}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M2 4h12M2 8h12M2 12h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          Workflows
        </button>
        <button
          className={`tab-btn ${activeTab === "graph" ? "active" : ""}`}
          onClick={() => setActiveTab("graph")}
          disabled={!workflow}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect x="1" y="2" width="5" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <rect x="10" y="2" width="5" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <rect x="5.5" y="10" width="5" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <path d="M3.5 6v2l4.5 2M12.5 6v2l-4.5 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          Graph
        </button>
        <button
          className={`tab-btn ${activeTab === "node" ? "active" : ""}`}
          onClick={() => setActiveTab("node")}
          disabled={!selectedNode}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.2" />
            <path d="M5 6h6M5 8.5h4M5 11h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          Node
        </button>
      </div>

      {/* Tab content */}
      <div className="tab-content">
        {activeTab === "workflows" && (
          <WorkflowList
            api={api}
            selectedId={selectedWorkflowId}
            onSelect={handleSelectWorkflow}
            refreshKey={refreshKey}
            showToast={showToast}
          />
        )}

        {activeTab === "graph" && (
          <>
            <GraphToolbar
              api={api}
              workflow={workflow}
              onRefresh={handleRefresh}
              onWorkflowDeleted={handleWorkflowDeleted}
              onBackToList={handleBackToList}
              showToast={showToast}
            />
            <GraphView
              workflow={workflow}
              loading={loadingWorkflow}
              selectedNodeId={selectedNodeId}
              onSelectNode={handleSelectNode}
              api={api}
              onRefresh={handleRefresh}
            />
          </>
        )}

        {activeTab === "node" && selectedNode && workflow && (
          <NodeDetail
            api={api}
            workflowId={workflow.id}
            node={selectedNode}
            onClose={handleBackToGraph}
            onUpdate={() => {
              handleRefresh();
              showToast("Node updated");
            }}
            showToast={showToast}
          />
        )}
      </div>

      {/* Toast notification */}
      {toast && (
        <div className={`toast toast-${toast.type}`}>
          {toast.message}
        </div>
      )}
    </div>
  );
}
