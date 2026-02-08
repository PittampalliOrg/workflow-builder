"use client";

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { NodeConfigPanel } from "@/components/workflow/node-config-panel";
import { useIsMobile } from "@/hooks/use-mobile";
import { api } from "@/lib/api-client";
import {
  connectionsAtom,
  connectionsLoadedAtom,
  connectionsVersionAtom,
} from "@/lib/connections-store";
import type { PluginType } from "@/plugins/registry";
import {
  batchSetNodeStatusesAtom,
  currentRunningNodeIdAtom,
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  currentWorkflowVisibilityAtom,
  edgesAtom,
  hasSidebarBeenShownAtom,
  hasUnsavedChangesAtom,
  isGeneratingAtom,
  isPanelAnimatingAtom,
  isSavingAtom,
  isSidebarCollapsedAtom,
  isWorkflowOwnerAtom,
  nodesAtom,
  rightPanelWidthAtom,
  selectedExecutionIdAtom,
  triggerExecuteAtom,
  updateNodeDataAtom,
  type WorkflowNode,
  type WorkflowVisibility,
  workflowNotFoundAtom,
} from "@/lib/workflow-store";
import { findActionById } from "@/plugins";

type WorkflowPageProps = {
  params: Promise<{ workflowId: string }>;
};

function buildConnectionAuthTemplate(externalId: string): string {
  return `{{connections['${externalId}']}}`;
}

// Helper to get required piece name for an action
function getRequiredPieceName(
  actionType: string
): string | undefined {
  const action = findActionById(actionType);
  return action?.integration;
}

// Helper to check and fix a single node's connection
type ConnectionFixResult = {
  nodeId: string;
  newConnectionExternalId?: string;
};

function checkNodeConnection(
  node: WorkflowNode,
  connectionsByPiece: Map<string, { externalId: string }[]>
): ConnectionFixResult | null {
  const actionType = node.data.config?.actionType as string | undefined;
  if (!actionType) {
    return null;
  }

  const pieceName = getRequiredPieceName(actionType);
  if (!pieceName) {
    return null;
  }

  // Already has a connection auth template
  const currentAuth = node.data.config?.auth as string | undefined;
  if (currentAuth && currentAuth.includes("connections[")) {
    return null;
  }

  // Find available connections for this piece
  const available = connectionsByPiece.get(pieceName) ?? [];

  if (available.length === 1) {
    return {
      nodeId: node.id,
      newConnectionExternalId: available[0].externalId,
    };
  }
  return null;
}

const WorkflowEditor = ({ params }: WorkflowPageProps) => {
  const { workflowId } = use(params);
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();
  const [isGenerating, setIsGenerating] = useAtom(isGeneratingAtom);
  const [_isSaving, setIsSaving] = useAtom(isSavingAtom);
  const [nodes] = useAtom(nodesAtom);
  const [edges] = useAtom(edgesAtom);
  const [currentWorkflowId] = useAtom(currentWorkflowIdAtom);
  const [selectedExecutionId] = useAtom(selectedExecutionIdAtom);
  const setNodes = useSetAtom(nodesAtom);
  const setEdges = useSetAtom(edgesAtom);
  const setCurrentWorkflowId = useSetAtom(currentWorkflowIdAtom);
  const setCurrentWorkflowName = useSetAtom(currentWorkflowNameAtom);
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const batchSetNodeStatuses = useSetAtom(batchSetNodeStatusesAtom);
  const setHasUnsavedChanges = useSetAtom(hasUnsavedChangesAtom);
  const [workflowNotFound, setWorkflowNotFound] = useAtom(workflowNotFoundAtom);
  const setTriggerExecute = useSetAtom(triggerExecuteAtom);
  const currentRunningNodeId = useAtomValue(currentRunningNodeIdAtom);
  const setRightPanelWidth = useSetAtom(rightPanelWidthAtom);
  const setIsPanelAnimating = useSetAtom(isPanelAnimatingAtom);
  const [hasSidebarBeenShown, setHasSidebarBeenShown] = useAtom(
    hasSidebarBeenShownAtom
  );
  const [panelCollapsed, setPanelCollapsed] = useAtom(isSidebarCollapsedAtom);
  const setCurrentWorkflowVisibility = useSetAtom(
    currentWorkflowVisibilityAtom
  );
  const [isOwner, setIsWorkflowOwner] = useAtom(isWorkflowOwnerAtom);
  const setGlobalConnections = useSetAtom(connectionsAtom);
  const setConnectionsLoaded = useSetAtom(connectionsLoadedAtom);
  const connectionsVersion = useAtomValue(connectionsVersionAtom);

  // Panel width state for resizing
  const [panelWidth, setPanelWidth] = useState(30); // default percentage
  // Start visible if sidebar has already been shown (switching between workflows)
  const [panelVisible, setPanelVisible] = useState(hasSidebarBeenShown);
  const [isDraggingResize, setIsDraggingResize] = useState(false);
  const isResizing = useRef(false);
  const hasReadCookies = useRef(false);

  // Read sidebar preferences from cookies on mount (after hydration)
  useEffect(() => {
    if (hasReadCookies.current) {
      return;
    }
    hasReadCookies.current = true;

    // Read width
    const widthCookie = document.cookie
      .split("; ")
      .find((row) => row.startsWith("sidebar-width="));
    if (widthCookie) {
      const value = Number.parseFloat(widthCookie.split("=")[1]);
      if (!Number.isNaN(value) && value >= 20 && value <= 50) {
        setPanelWidth(value);
      }
    }

    // Read collapsed state
    const collapsedCookie = document.cookie
      .split("; ")
      .find((row) => row.startsWith("sidebar-collapsed="));
    if (collapsedCookie) {
      setPanelCollapsed(collapsedCookie.split("=")[1] === "true");
    }
  }, [setPanelCollapsed]);

  // Save sidebar width to cookie when it changes (skip initial render)
  const hasInitialized = useRef(false);
  useEffect(() => {
    if (!hasInitialized.current) {
      hasInitialized.current = true;
      return;
    }
    // biome-ignore lint/suspicious/noDocumentCookie: simple cookie storage for sidebar width
    document.cookie = `sidebar-width=${panelWidth}; path=/; max-age=31536000`; // 1 year
  }, [panelWidth]);

  // Save collapsed state to cookie when it changes
  useEffect(() => {
    if (!hasReadCookies.current) {
      return;
    }
    // biome-ignore lint/suspicious/noDocumentCookie: simple cookie storage for sidebar state
    document.cookie = `sidebar-collapsed=${panelCollapsed}; path=/; max-age=31536000`; // 1 year
  }, [panelCollapsed]);

  // Trigger slide-in animation on mount (only for homepage -> workflow transition)
  useEffect(() => {
    // Check if we came from homepage
    const shouldAnimate = sessionStorage.getItem("animate-sidebar") === "true";
    sessionStorage.removeItem("animate-sidebar");

    // Skip animation if sidebar has already been shown (switching between workflows)
    // or if we didn't come from homepage (direct load, refresh)
    if (hasSidebarBeenShown || !shouldAnimate) {
      setPanelVisible(true);
      setHasSidebarBeenShown(true);
      return;
    }

    // Set animating state before starting
    setIsPanelAnimating(true);
    // Delay to ensure the canvas is visible at full width first
    const timer = setTimeout(() => {
      setPanelVisible(true);
      setHasSidebarBeenShown(true);
    }, 100);
    // Clear animating state after animation completes (300ms + buffer)
    const animationTimer = setTimeout(() => setIsPanelAnimating(false), 400);
    return () => {
      clearTimeout(timer);
      clearTimeout(animationTimer);
      setIsPanelAnimating(false);
    };
  }, [hasSidebarBeenShown, setHasSidebarBeenShown, setIsPanelAnimating]);

  // Keyboard shortcut Cmd/Ctrl+B to toggle sidebar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        setIsPanelAnimating(true);
        setPanelCollapsed((prev) => !prev);
        setTimeout(() => setIsPanelAnimating(false), 350);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setIsPanelAnimating, setPanelCollapsed]);

  // Set right panel width for AI prompt positioning
  // Only set it after the panel is visible (animated in) to coordinate the animation
  useEffect(() => {
    if (!isMobile && panelVisible && !panelCollapsed) {
      setRightPanelWidth(`${panelWidth}%`);
    } else {
      // During initial render or when collapsed, set to null so prompt is centered
      setRightPanelWidth(null);
    }
    return () => {
      setRightPanelWidth(null);
    };
  }, [isMobile, setRightPanelWidth, panelWidth, panelVisible, panelCollapsed]);

  // Handle panel resize
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    setIsDraggingResize(true);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizing.current) {
        return;
      }
      const newWidth =
        ((window.innerWidth - moveEvent.clientX) / window.innerWidth) * 100;
      // Clamp between 20% and 50%
      setPanelWidth(Math.min(50, Math.max(20, newWidth)));
    };

    const handleMouseUp = () => {
      isResizing.current = false;
      setIsDraggingResize(false);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  // Ref to track polling interval for selected execution
  const selectedExecutionPollingIntervalRef = useRef<NodeJS.Timeout | null>(
    null
  );
  // Ref to access currentRunningNodeId inside polling without triggering re-runs
  const currentRunningNodeIdRef = useRef(currentRunningNodeId);

  // Keep currentRunningNodeId ref in sync
  useEffect(() => {
    currentRunningNodeIdRef.current = currentRunningNodeId;
  }, [currentRunningNodeId]);

  // Helper function to generate workflow from AI
  const generateWorkflowFromAI = useCallback(
    async (prompt: string) => {
      setIsGenerating(true);
      setCurrentWorkflowId(workflowId);
      setCurrentWorkflowName("AI Generated Workflow");

      try {
        const workflowData = await api.ai.generate(prompt);

        // Clear selection on all nodes
        const nodesWithoutSelection = (workflowData.nodes || []).map(
          (node: WorkflowNode) => ({ ...node, selected: false })
        );
        setNodes(nodesWithoutSelection);
        setEdges(workflowData.edges || []);
        setCurrentWorkflowName(workflowData.name || "AI Generated Workflow");

        await api.workflow.update(workflowId, {
          name: workflowData.name,
          description: workflowData.description,
          nodes: workflowData.nodes,
          edges: workflowData.edges,
        });
      } catch (error) {
        console.error("Failed to generate workflow:", error);
        toast.error("Failed to generate workflow");
      } finally {
        setIsGenerating(false);
      }
    },
    [
      workflowId,
      setIsGenerating,
      setCurrentWorkflowId,
      setCurrentWorkflowName,
      setNodes,
      setEdges,
    ]
  );

  // Helper function to load existing workflow
  const loadExistingWorkflow = useCallback(async () => {
    try {
      const workflow = await api.workflow.getById(workflowId);

      if (!workflow) {
        setWorkflowNotFound(true);
        return;
      }

      // Reset node statuses to idle and clear selection when loading from database
      const nodesWithIdleStatus = workflow.nodes.map((node: WorkflowNode) => ({
        ...node,
        selected: false,
        data: {
          ...node.data,
          status: "idle" as const,
        },
      }));

      setNodes(nodesWithIdleStatus);
      setEdges(workflow.edges);
      setCurrentWorkflowId(workflow.id);
      setCurrentWorkflowName(workflow.name);
      setCurrentWorkflowVisibility(
        (workflow.visibility as WorkflowVisibility) ?? "private"
      );
      setIsWorkflowOwner(workflow.isOwner !== false); // Default to true if not set
      setHasUnsavedChanges(false);
      setWorkflowNotFound(false);
    } catch (error) {
      console.error("Failed to load workflow:", error);
      toast.error("Failed to load workflow");
    }
  }, [
    workflowId,
    setNodes,
    setEdges,
    setCurrentWorkflowId,
    setCurrentWorkflowName,
    setCurrentWorkflowVisibility,
    setIsWorkflowOwner,
    setHasUnsavedChanges,
    setWorkflowNotFound,
  ]);

  // Track if we've already auto-fixed integrations for this workflow+version
  const lastAutoFixRef = useRef<{ workflowId: string; version: number } | null>(
    null
  );

  useEffect(() => {
    const loadWorkflowData = async () => {
      const isGeneratingParam = searchParams?.get("generating") === "true";
      const storedPrompt = sessionStorage.getItem("ai-prompt");
      const storedWorkflowId = sessionStorage.getItem("generating-workflow-id");

      // Check if state is already loaded for this workflow
      if (currentWorkflowId === workflowId && nodes.length > 0) {
        return;
      }

      // Check if we should generate from AI
      if (
        isGeneratingParam &&
        storedPrompt &&
        storedWorkflowId === workflowId
      ) {
        sessionStorage.removeItem("ai-prompt");
        sessionStorage.removeItem("generating-workflow-id");
        await generateWorkflowFromAI(storedPrompt);
      } else {
        await loadExistingWorkflow();
      }
    };

    loadWorkflowData();
  }, [
    workflowId,
    searchParams,
    currentWorkflowId,
    nodes.length,
    generateWorkflowFromAI,
    loadExistingWorkflow,
  ]);

  // Auto-fix missing connections on workflow load or when connections change
  useEffect(() => {
    if (nodes.length === 0 || !currentWorkflowId) {
      return;
    }
    if (!isOwner) {
      return;
    }

    const lastFix = lastAutoFixRef.current;
    if (
      lastFix &&
      lastFix.workflowId === currentWorkflowId &&
      lastFix.version === connectionsVersion
    ) {
      return;
    }

    const autoFixConnections = async () => {
      try {
        const response = await api.appConnection.list({ projectId: "default", limit: 1000 });
        const allConnections = response.data;
        setGlobalConnections(allConnections);
        setConnectionsLoaded(true);

        // Group connections by pieceName
        const byPiece = new Map<string, { externalId: string }[]>();
        for (const conn of allConnections) {
          const list = byPiece.get(conn.pieceName) ?? [];
          list.push({ externalId: conn.externalId });
          byPiece.set(conn.pieceName, list);
        }

        const fixes = nodes
          .map((node) => checkNodeConnection(node, byPiece))
          .filter((fix): fix is ConnectionFixResult => fix !== null);

        for (const fix of fixes) {
          const node = nodes.find((n) => n.id === fix.nodeId);
          if (node) {
            updateNodeData({
              id: fix.nodeId,
              data: {
                config: {
                  ...node.data.config,
                  auth: fix.newConnectionExternalId
                    ? buildConnectionAuthTemplate(fix.newConnectionExternalId)
                    : undefined,
                },
              },
            });
          }
        }

        lastAutoFixRef.current = {
          workflowId: currentWorkflowId,
          version: connectionsVersion,
        };
        if (fixes.length > 0) {
          setHasUnsavedChanges(true);
        }
      } catch (error) {
        console.error("Failed to auto-fix connections:", error);
      }
    };

    autoFixConnections();
  }, [
    nodes,
    currentWorkflowId,
    connectionsVersion,
    isOwner,
    updateNodeData,
    setGlobalConnections,
    setConnectionsLoaded,
    setHasUnsavedChanges,
  ]);

  // Keyboard shortcuts
  const handleSave = useCallback(async () => {
    if (!currentWorkflowId || isGenerating) {
      return;
    }
    setIsSaving(true);
    try {
      await api.workflow.update(currentWorkflowId, { nodes, edges });
      setHasUnsavedChanges(false);
    } catch (error) {
      console.error("Failed to save workflow:", error);
      toast.error("Failed to save workflow");
    } finally {
      setIsSaving(false);
    }
  }, [
    currentWorkflowId,
    nodes,
    edges,
    isGenerating,
    setIsSaving,
    setHasUnsavedChanges,
  ]);

  // Helper to check if target is an input element
  const isInputElement = useCallback(
    (target: HTMLElement) =>
      target.tagName === "INPUT" || target.tagName === "TEXTAREA",
    []
  );

  // Helper to check if we're in Monaco editor
  const isInMonacoEditor = useCallback(
    (target: HTMLElement) => target.closest(".monaco-editor") !== null,
    []
  );

  // Helper to handle save shortcut
  const handleSaveShortcut = useCallback(
    (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        e.stopPropagation();
        handleSave();
        return true;
      }
      return false;
    },
    [handleSave]
  );

  // Helper to handle run shortcut
  // Uses triggerExecuteAtom to share the same execute flow as the Run button
  // This ensures keyboard shortcut goes through the same checks (e.g., missing integrations)
  const handleRunShortcut = useCallback(
    (e: KeyboardEvent, target: HTMLElement) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        if (!(isInputElement(target) || isInMonacoEditor(target))) {
          e.preventDefault();
          e.stopPropagation();
          // Trigger execute via atom - the toolbar will handle it
          setTriggerExecute(true);
        }
        return true;
      }
      return false;
    },
    [setTriggerExecute, isInputElement, isInMonacoEditor]
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;

      // Handle save shortcut
      if (handleSaveShortcut(e)) {
        return;
      }

      // Handle run shortcut
      if (handleRunShortcut(e, target)) {
        return;
      }
    };

    // Use capture phase only to ensure we can intercept before other handlers
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [handleSaveShortcut, handleRunShortcut]);

  // Cleanup polling interval on unmount
  useEffect(
    () => () => {
      if (selectedExecutionPollingIntervalRef.current) {
        clearInterval(selectedExecutionPollingIntervalRef.current);
      }
    },
    []
  );

  // Poll for selected execution status
  useEffect(() => {
    // Clear existing interval if any
    if (selectedExecutionPollingIntervalRef.current) {
      clearInterval(selectedExecutionPollingIntervalRef.current);
      selectedExecutionPollingIntervalRef.current = null;
    }

    // If no execution is selected, reset all node statuses
    if (!selectedExecutionId) {
      batchSetNodeStatuses(new Map());
      return;
    }

    // Start polling for the selected execution
    const pollSelectedExecution = async () => {
      try {
        const statusData =
          await api.workflow.getExecutionStatus(selectedExecutionId);

        // Build a complete status map: log-based statuses + currentRunningNodeId
        // Nodes NOT in this map get reset to "idle" by batchSetNodeStatuses
        const statusMap = new Map<
          string,
          "idle" | "running" | "success" | "error"
        >();
        for (const nodeStatus of statusData.nodeStatuses) {
          const mappedStatus =
            nodeStatus.status === "pending" ? "idle" : nodeStatus.status;
          statusMap.set(
            nodeStatus.nodeId,
            mappedStatus as "idle" | "running" | "success" | "error"
          );
        }

        // Add the currently executing node from orchestrator status,
        // but only if logs haven't already recorded a terminal status.
        const runningNodeId = currentRunningNodeIdRef.current;
        const existingStatus = runningNodeId
          ? statusMap.get(runningNodeId)
          : undefined;
        if (
          runningNodeId &&
          existingStatus !== "success" &&
          existingStatus !== "error"
        ) {
          statusMap.set(runningNodeId, "running");
        }

        // Single atomic write: updates all nodes at once via Jotai atom
        // (reads latest state internally, no stale ref issues)
        batchSetNodeStatuses(statusMap);

        // Stop polling if execution is complete
        if (
          statusData.status !== "running" &&
          selectedExecutionPollingIntervalRef.current
        ) {
          clearInterval(selectedExecutionPollingIntervalRef.current);
          selectedExecutionPollingIntervalRef.current = null;
        }
      } catch {
        // Transient fetch failures are expected during long-running execution
      }
    };

    // Poll immediately and then every 1s
    pollSelectedExecution();
    const pollInterval = setInterval(pollSelectedExecution, 1000);
    selectedExecutionPollingIntervalRef.current = pollInterval;

    return () => {
      if (selectedExecutionPollingIntervalRef.current) {
        clearInterval(selectedExecutionPollingIntervalRef.current);
        selectedExecutionPollingIntervalRef.current = null;
      }
    };
  }, [selectedExecutionId, batchSetNodeStatuses]);

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden">
      {/* Workflow not found overlay */}
      {workflowNotFound && (
        <div className="pointer-events-auto absolute inset-0 z-20 flex items-center justify-center">
          <div className="rounded-lg border bg-background p-8 text-center shadow-lg">
            <h1 className="mb-2 font-semibold text-2xl">Workflow Not Found</h1>
            <p className="mb-6 text-muted-foreground">
              The workflow you're looking for doesn't exist or has been deleted.
            </p>
            <Button asChild>
              <Link href="/">New Workflow</Link>
            </Button>
          </div>
        </div>
      )}

      {/* Expand button when panel is collapsed */}
      {!isMobile && panelCollapsed && (
        <button
          className="pointer-events-auto absolute top-1/2 right-0 z-20 flex size-6 -translate-y-1/2 items-center justify-center rounded-l-full border border-r-0 bg-background shadow-sm transition-colors hover:bg-muted"
          onClick={() => {
            setIsPanelAnimating(true);
            setPanelCollapsed(false);
            setTimeout(() => setIsPanelAnimating(false), 350);
          }}
          type="button"
        >
          <ChevronLeft className="size-4" />
        </button>
      )}

      {/* Right panel overlay (desktop only) */}
      {!isMobile && (
        <div
          className="pointer-events-auto absolute inset-y-0 right-0 z-20 border-l bg-background transition-transform duration-300 ease-out"
          style={{
            width: `${panelWidth}%`,
            transform:
              panelVisible && !panelCollapsed
                ? "translateX(0)"
                : "translateX(100%)",
          }}
        >
          {/* Resize handle with collapse button */}
          {/* biome-ignore lint/a11y/useSemanticElements: custom resize handle */}
          <div
            aria-orientation="vertical"
            aria-valuenow={panelWidth}
            className="group absolute inset-y-0 left-0 z-10 w-3 cursor-col-resize"
            onMouseDown={handleResizeStart}
            role="separator"
            tabIndex={0}
          >
            {/* Hover indicator */}
            <div className="absolute inset-y-0 left-0 w-1 bg-transparent transition-colors group-hover:bg-blue-500 group-active:bg-blue-600" />
            {/* Collapse button - hidden while resizing */}
            {!(isDraggingResize || panelCollapsed) && (
              <button
                className="absolute top-1/2 left-0 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-background opacity-0 shadow-sm transition-opacity hover:bg-muted group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsPanelAnimating(true);
                  setPanelCollapsed(true);
                  setTimeout(() => setIsPanelAnimating(false), 350);
                }}
                onMouseDown={(e) => e.stopPropagation()}
                type="button"
              >
                <ChevronRight className="size-4" />
              </button>
            )}
          </div>
          <NodeConfigPanel />
        </div>
      )}

      {/* Mobile: NodeConfigPanel renders the overlay trigger button */}
      {isMobile && <NodeConfigPanel />}
    </div>
  );
};

const WorkflowPage = ({ params }: WorkflowPageProps) => (
  <WorkflowEditor params={params} />
);

export default WorkflowPage;
