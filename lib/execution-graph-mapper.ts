/**
 * Execution Graph Mapper
 *
 * Transforms DaprExecutionEvent[] into React Flow nodes and edges
 * for visualization in the ExecutionFlow component.
 */

import type { DaprExecutionEvent } from "@/lib/types/workflow-ui";
import type {
  ExecutionFlowNode,
  ExecutionFlowEdge,
  ExecutionGraph,
} from "@/lib/types/execution-graph";

// ============================================================================
// Constants
// ============================================================================

const NODE_WIDTH = 280;
const NODE_HEIGHT = 80;
const NODE_GAP_Y = 40;

// ============================================================================
// Mapper Function
// ============================================================================

/**
 * Maps execution events to a React Flow graph structure.
 * Creates a vertical layout (top to bottom) with sequential connections.
 */
export function mapExecutionEventsToGraph(
  events: DaprExecutionEvent[]
): ExecutionGraph {
  if (events.length === 0) {
    return { nodes: [], edges: [] };
  }

  // Sort events by eventId (chronological order)
  const sortedEvents = [...events].sort((a, b) => {
    const aId = a.eventId ?? 0;
    const bId = b.eventId ?? 0;
    return aId - bId;
  });

  // Create nodes
  const nodes: ExecutionFlowNode[] = sortedEvents.map((event, index) => ({
    id: `event-${event.eventId ?? index}`,
    type: "executionEvent",
    position: {
      x: 0,
      y: index * (NODE_HEIGHT + NODE_GAP_Y),
    },
    data: {
      eventId: event.eventId,
      eventType: event.eventType,
      name: event.name,
      timestamp: event.timestamp,
      elapsed: event.metadata?.elapsed,
      status: event.metadata?.status,
    },
  }));

  // Create edges (sequential connections)
  const edges: ExecutionFlowEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({
      id: `edge-${nodes[i].id}-${nodes[i + 1].id}`,
      source: nodes[i].id,
      target: nodes[i + 1].id,
      type: "smoothstep",
    });
  }

  return { nodes, edges };
}

/**
 * Groups events by task name for hierarchical display.
 * Useful for showing task-level grouping in complex workflows.
 */
export function groupEventsByTask(
  events: DaprExecutionEvent[]
): Map<string, DaprExecutionEvent[]> {
  const groups = new Map<string, DaprExecutionEvent[]>();

  for (const event of events) {
    const taskId = event.metadata?.taskId ?? "root";
    const existing = groups.get(taskId) ?? [];
    existing.push(event);
    groups.set(taskId, existing);
  }

  return groups;
}

/**
 * Calculates execution duration between start and end events.
 */
export function calculateDuration(
  startEvent: DaprExecutionEvent,
  endEvent: DaprExecutionEvent
): string {
  const start = new Date(startEvent.timestamp).getTime();
  const end = new Date(endEvent.timestamp).getTime();
  const durationMs = end - start;

  if (durationMs < 1000) {
    return `${durationMs}ms`;
  } else if (durationMs < 60000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  } else {
    const minutes = Math.floor(durationMs / 60000);
    const seconds = ((durationMs % 60000) / 1000).toFixed(0);
    return `${minutes}m ${seconds}s`;
  }
}
