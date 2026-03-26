"use client";

import {
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Loader2,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// ============================================================================
// Types
// ============================================================================

type AgentEvent = {
  eventId: number;
  eventType: string;
  phase: string | null;
  toolName: string | null;
  payload: Record<string, unknown>;
  ts: string;
};

type Turn = {
  turn: number;
  phase: string | null;
  events: AgentEvent[];
};

type AgentRunInfo = {
  daprInstanceId: string;
  nodeId: string;
  status: string;
  mode?: string | null;
  totalTurns?: number | null;
  currentTurn?: number | null;
};

type AgentProgressPanelProps = {
  executionId: string;
  agentRuns: AgentRunInfo[];
};

// ============================================================================
// Helpers
// ============================================================================

function getTurnDuration(events: AgentEvent[]): string {
  if (events.length < 2) return "-";
  const first = new Date(events[0].ts).getTime();
  const last = new Date(events[events.length - 1].ts).getTime();
  const ms = last - first;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function getToolCalls(events: AgentEvent[]): { name: string; durationMs: number | null }[] {
  const tools: { name: string; durationMs: number | null }[] = [];
  const starts = new Map<string, number>();

  for (const event of events) {
    if (event.eventType === "tool_call_start" && event.toolName) {
      starts.set(event.toolName, new Date(event.ts).getTime());
    }
    if (event.eventType === "tool_call_end" && event.toolName) {
      const startTime = starts.get(event.toolName);
      const durationMs = startTime ? new Date(event.ts).getTime() - startTime : null;
      tools.push({ name: event.toolName, durationMs });
      starts.delete(event.toolName);
    }
  }

  // Add any started but not-yet-finished tools
  for (const [name] of starts) {
    tools.push({ name, durationMs: null });
  }

  return tools;
}

function getLlmActivity(events: AgentEvent[]): { tokens: number | null; isActive: boolean } {
  let tokens: number | null = null;
  let isActive = false;

  for (const event of events) {
    if (event.eventType === "llm_start") {
      isActive = true;
    }
    if (event.eventType === "llm_complete") {
      isActive = false;
      const payload = event.payload;
      if (typeof payload.total_tokens === "number") {
        tokens = (tokens ?? 0) + payload.total_tokens;
      }
    }
  }

  return { tokens, isActive };
}

// ============================================================================
// Turn Row
// ============================================================================

function TurnRow({ turn, isLast }: { turn: Turn; isLast: boolean }) {
  const [expanded, setExpanded] = useState(isLast);
  const duration = getTurnDuration(turn.events);
  const tools = getToolCalls(turn.events);
  const llm = getLlmActivity(turn.events);
  const isActive = isLast && llm.isActive;

  return (
    <div className="border-b border-gray-700/50 last:border-0">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-800/30"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-500" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-gray-500" />
        )}
        <span className="font-medium text-gray-300 text-xs">
          Turn {turn.turn}
        </span>
        {isActive && (
          <Badge className="bg-teal-500/20 text-teal-400 text-[10px]" variant="outline">
            active
          </Badge>
        )}
        <span className="ml-auto font-mono text-gray-500 text-xs">{duration}</span>
      </button>

      {expanded && (
        <div className="space-y-1 px-3 pb-2 pl-8">
          {llm.isActive && (
            <div className="flex items-center gap-2 text-xs text-amber-400/80">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>LLM thinking...</span>
            </div>
          )}
          {llm.tokens !== null && (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <Cpu className="h-3 w-3" />
              <span>{llm.tokens.toLocaleString()} tokens</span>
            </div>
          )}
          {tools.map((tool, i) => (
            <div
              className="flex items-center gap-2 text-xs text-gray-400"
              key={`${tool.name}-${i}`}
            >
              <Wrench className="h-3 w-3 text-gray-600" />
              <span className="font-mono">{tool.name}</span>
              {tool.durationMs !== null ? (
                <span className="ml-auto text-gray-600">{tool.durationMs}ms</span>
              ) : (
                <Loader2 className="ml-auto h-3 w-3 animate-spin text-gray-600" />
              )}
            </div>
          ))}
          {tools.length === 0 && !llm.isActive && llm.tokens === null && (
            <div className="text-gray-600 text-xs">No tool calls in this turn</div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Agent Run Section
// ============================================================================

function AgentRunSection({
  run,
  executionId,
}: {
  run: AgentRunInfo;
  executionId: string;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchEvents = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/workflows/executions/${encodeURIComponent(executionId)}/agent-events?daprInstanceId=${encodeURIComponent(run.daprInstanceId)}`,
      );
      if (!res.ok) return;
      const data = await res.json();
      setTurns(data.turns ?? []);
    } catch {
      // Silently fail - events may not be available yet
    } finally {
      setLoading(false);
    }
  }, [executionId, run.daprInstanceId]);

  useEffect(() => {
    fetchEvents();
    // Poll for active runs
    if (!["completed", "failed", "error", "terminated"].includes(run.status)) {
      const interval = setInterval(fetchEvents, 5000);
      return () => clearInterval(interval);
    }
  }, [fetchEvents, run.status]);

  const isRunning = !["completed", "failed", "error", "terminated"].includes(run.status);
  const totalTurns = run.totalTurns ?? turns.length;
  const currentTurn = run.currentTurn ?? turns.length;

  const progressPct = totalTurns > 0 ? Math.min((currentTurn / totalTurns) * 100, 100) : 0;

  return (
    <div className="overflow-hidden rounded-lg border border-gray-700 bg-[#1e2433]">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-gray-700 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-medium text-gray-200 text-sm">
            {run.mode === "plan_mode" ? "Agent Plan" : "Agent Execute"}
          </span>
          <Badge
            className={cn(
              "text-[10px]",
              isRunning
                ? "bg-teal-500/20 text-teal-400"
                : run.status === "completed"
                  ? "bg-green-500/20 text-green-400"
                  : "bg-red-500/20 text-red-400",
            )}
            variant="outline"
          >
            {run.status}
          </Badge>
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs text-gray-500">
          <Clock className="h-3 w-3" />
          <span>
            Turn {currentTurn}/{totalTurns || "?"}
          </span>
        </div>
      </div>

      {/* Progress bar */}
      {totalTurns > 0 && (
        <div className="h-1 bg-gray-800">
          <div
            className={cn(
              "h-full transition-all duration-500",
              isRunning ? "bg-teal-500" : run.status === "completed" ? "bg-green-500" : "bg-red-500",
            )}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}

      {/* Turns */}
      <div className="max-h-[400px] overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-4 text-gray-500 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading agent events...
          </div>
        ) : turns.length === 0 ? (
          <div className="p-4 text-center text-gray-500 text-sm">
            No turn events recorded yet
          </div>
        ) : (
          turns.map((turn, i) => (
            <TurnRow
              isLast={i === turns.length - 1}
              key={turn.turn}
              turn={turn}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function AgentProgressPanel({
  executionId,
  agentRuns,
}: AgentProgressPanelProps) {
  if (agentRuns.length === 0) return null;

  return (
    <div className="space-y-3">
      <h3 className="font-medium text-gray-300 text-sm">Agent Progress</h3>
      {agentRuns.map((run) => (
        <AgentRunSection
          executionId={executionId}
          key={run.daprInstanceId}
          run={run}
        />
      ))}
    </div>
  );
}
