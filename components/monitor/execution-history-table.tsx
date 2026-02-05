"use client";

import { useState } from "react";
import { Plus, Minus, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  getEventTypeColor,
  type DaprExecutionEvent,
} from "@/lib/types/workflow-ui";
import { formatTimestamp } from "@/lib/transforms/workflow-ui";
import { cn } from "@/lib/utils";

interface ExecutionHistoryTableProps {
  events: DaprExecutionEvent[];
}

function EventDetailRow({ event }: { event: DaprExecutionEvent }) {
  const [copiedInput, setCopiedInput] = useState(false);
  const [copiedOutput, setCopiedOutput] = useState(false);

  const handleCopyInput = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(event.input, null, 2));
      setCopiedInput(true);
      setTimeout(() => setCopiedInput(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const handleCopyOutput = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(event.output, null, 2));
      setCopiedOutput(true);
      setTimeout(() => setCopiedOutput(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const hasInput = event.input !== undefined && event.input !== null;
  const hasOutput = event.output !== undefined && event.output !== null;

  return (
    <div className="p-4 bg-[#1e2433] rounded-lg space-y-3">
      {/* Input section */}
      {hasInput && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-gray-400">
              Input
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-auto py-0 px-0 text-teal-400 hover:text-teal-300 hover:bg-transparent"
              onClick={(e) => {
                e.stopPropagation();
                handleCopyInput();
              }}
            >
              {copiedInput ? (
                <span className="flex items-center gap-1">
                  <Check className="h-3.5 w-3.5" />
                  Copied
                </span>
              ) : (
                "Copy"
              )}
            </Button>
          </div>
          <pre className="text-xs font-mono bg-[#151922] p-3 rounded border border-gray-700 overflow-auto max-h-40 text-gray-300">
            {JSON.stringify(event.input, null, 2)}
          </pre>
        </div>
      )}

      {/* Output section */}
      {hasOutput && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-gray-400">
              Output
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-auto py-0 px-0 text-teal-400 hover:text-teal-300 hover:bg-transparent"
              onClick={(e) => {
                e.stopPropagation();
                handleCopyOutput();
              }}
            >
              {copiedOutput ? (
                <span className="flex items-center gap-1">
                  <Check className="h-3.5 w-3.5" />
                  Copied
                </span>
              ) : (
                "Copy"
              )}
            </Button>
          </div>
          <pre className="text-xs font-mono bg-[#151922] p-3 rounded border border-gray-700 overflow-auto max-h-40 text-gray-300">
            {JSON.stringify(event.output, null, 2)}
          </pre>
        </div>
      )}

      {/* Metadata cards - Diagrid style */}
      {event.metadata && (
        <div className="flex flex-wrap gap-3">
          {event.metadata.elapsed && (
            <div className="flex flex-col gap-1 px-3 py-2 bg-[#151922] rounded border border-gray-700">
              <span className="text-xs text-gray-500 uppercase">Elapsed</span>
              <span className="text-sm font-medium text-white">{event.metadata.elapsed}</span>
            </div>
          )}
          {event.metadata.executionDuration && (
            <div className="flex flex-col gap-1 px-3 py-2 bg-[#151922] rounded border border-gray-700">
              <span className="text-xs text-gray-500 uppercase">Duration</span>
              <span className="text-sm font-medium text-white">
                {event.metadata.executionDuration}
              </span>
            </div>
          )}
          {event.metadata.status && (
            <div className="flex flex-col gap-1 px-3 py-2 bg-[#151922] rounded border border-gray-700">
              <span className="text-xs text-gray-500 uppercase">Status</span>
              <Badge
                variant="outline"
                className={cn(
                  "text-xs w-fit",
                  event.metadata.status === "completed" && "border-green-600 text-green-400",
                  event.metadata.status === "failed" && "border-red-600 text-red-400"
                )}
              >
                {event.metadata.status}
              </Badge>
            </div>
          )}
          {event.metadata.taskId && !event.metadata.status && (
            <div className="flex flex-col gap-1 px-3 py-2 bg-[#151922] rounded border border-gray-700">
              <span className="text-xs text-gray-500 uppercase">Task ID</span>
              <span className="text-sm font-medium text-white">{event.metadata.taskId}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EventRow({ event }: { event: DaprExecutionEvent }) {
  const [expanded, setExpanded] = useState(false);

  // Check if there's any expandable content
  const hasInput = event.input !== undefined && event.input !== null;
  const hasOutput = event.output !== undefined && event.output !== null;
  const hasMetadata = event.metadata && (
    event.metadata.elapsed ||
    event.metadata.executionDuration ||
    event.metadata.status ||
    event.metadata.taskId
  );
  const hasExpandableContent = hasInput || hasOutput || hasMetadata;

  return (
    <>
      <TableRow
        className={cn(
          "border-b border-gray-700",
          hasExpandableContent && "cursor-pointer hover:bg-[#252c3d]",
          expanded && "bg-[#1e2433]"
        )}
        onClick={() => hasExpandableContent && setExpanded(!expanded)}
      >
        <TableCell className="w-10">
          {hasExpandableContent ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-teal-400 hover:text-teal-300 hover:bg-transparent"
            >
              {expanded ? (
                <Minus className="h-4 w-4" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
            </Button>
          ) : (
            <span className="w-6 h-6 inline-block" />
          )}
        </TableCell>
        <TableCell>
          <span className={cn("font-medium", getEventTypeColor(event.eventType))}>
            {event.eventType}
          </span>
        </TableCell>
        <TableCell className="font-mono text-gray-400">
          {event.eventId ?? "-"}
        </TableCell>
        <TableCell className="text-gray-300">{event.name ?? "-"}</TableCell>
        <TableCell className="text-gray-400">
          {formatTimestamp(event.timestamp)}
        </TableCell>
      </TableRow>
      {expanded && hasExpandableContent && (
        <TableRow className="border-b border-gray-700">
          <TableCell colSpan={5} className="p-0 bg-[#151922]">
            <div className="px-4 py-3">
              <EventDetailRow event={event} />
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export function ExecutionHistoryTable({ events }: ExecutionHistoryTableProps) {
  if (!events.length) {
    return (
      <div className="text-center py-8 text-gray-400">
        No execution events
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-700 bg-[#1a1f2e] overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="border-b border-gray-700 bg-[#1e2433] hover:bg-[#1e2433]">
            <TableHead className="w-8 text-gray-400"></TableHead>
            <TableHead className="text-gray-400 font-medium">Event</TableHead>
            <TableHead className="w-20 text-gray-400 font-medium">Event ID</TableHead>
            <TableHead className="text-gray-400 font-medium">Name</TableHead>
            <TableHead className="w-40 text-gray-400 font-medium">Timestamp</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((event, index) => (
            <EventRow key={`${event.eventType}-${index}`} event={event} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
