"use client";

import { Check, Minus, Plus } from "lucide-react";
import { useState } from "react";
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
import { formatTimestamp } from "@/lib/transforms/workflow-ui";
import {
  type DaprExecutionEvent,
  getEventTypeColor,
} from "@/lib/types/workflow-ui";
import { cn } from "@/lib/utils";

type ExecutionHistoryTableProps = {
  events: DaprExecutionEvent[];
};

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
      await navigator.clipboard.writeText(
        JSON.stringify(event.output, null, 2)
      );
      setCopiedOutput(true);
      setTimeout(() => setCopiedOutput(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const hasInput = event.input !== undefined && event.input !== null;
  const hasOutput = event.output !== undefined && event.output !== null;

  return (
    <div className="space-y-3 rounded-lg bg-[#1e2433] p-4">
      {/* Input section */}
      {hasInput && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-medium text-gray-400 text-xs">Input</span>
            <Button
              className="h-auto px-0 py-0 text-teal-400 hover:bg-transparent hover:text-teal-300"
              onClick={(e) => {
                e.stopPropagation();
                handleCopyInput();
              }}
              size="sm"
              variant="ghost"
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
          <pre className="max-h-40 overflow-auto rounded border border-gray-700 bg-[#151922] p-3 font-mono text-gray-300 text-xs">
            {JSON.stringify(event.input, null, 2)}
          </pre>
        </div>
      )}

      {/* Output section */}
      {hasOutput && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-medium text-gray-400 text-xs">Output</span>
            <Button
              className="h-auto px-0 py-0 text-teal-400 hover:bg-transparent hover:text-teal-300"
              onClick={(e) => {
                e.stopPropagation();
                handleCopyOutput();
              }}
              size="sm"
              variant="ghost"
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
          <pre className="max-h-40 overflow-auto rounded border border-gray-700 bg-[#151922] p-3 font-mono text-gray-300 text-xs">
            {JSON.stringify(event.output, null, 2)}
          </pre>
        </div>
      )}

      {/* Metadata cards - Diagrid style */}
      {event.metadata && (
        <div className="flex flex-wrap gap-3">
          {event.metadata.elapsed && (
            <div className="flex flex-col gap-1 rounded border border-gray-700 bg-[#151922] px-3 py-2">
              <span className="text-gray-500 text-xs uppercase">Elapsed</span>
              <span className="font-medium text-sm text-white">
                {event.metadata.elapsed}
              </span>
            </div>
          )}
          {event.metadata.executionDuration && (
            <div className="flex flex-col gap-1 rounded border border-gray-700 bg-[#151922] px-3 py-2">
              <span className="text-gray-500 text-xs uppercase">Duration</span>
              <span className="font-medium text-sm text-white">
                {event.metadata.executionDuration}
              </span>
            </div>
          )}
          {event.metadata.status && (
            <div className="flex flex-col gap-1 rounded border border-gray-700 bg-[#151922] px-3 py-2">
              <span className="text-gray-500 text-xs uppercase">Status</span>
              <Badge
                className={cn(
                  "w-fit text-xs",
                  event.metadata.status === "completed" &&
                    "border-green-600 text-green-400",
                  event.metadata.status === "failed" &&
                    "border-red-600 text-red-400"
                )}
                variant="outline"
              >
                {event.metadata.status}
              </Badge>
            </div>
          )}
          {event.metadata.taskId && !event.metadata.status && (
            <div className="flex flex-col gap-1 rounded border border-gray-700 bg-[#151922] px-3 py-2">
              <span className="text-gray-500 text-xs uppercase">Task ID</span>
              <span className="font-medium text-sm text-white">
                {event.metadata.taskId}
              </span>
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
  const hasMetadata =
    event.metadata &&
    (event.metadata.elapsed ||
      event.metadata.executionDuration ||
      event.metadata.status ||
      event.metadata.taskId);
  const hasExpandableContent = hasInput || hasOutput || hasMetadata;

  return (
    <>
      <TableRow
        className={cn(
          "border-gray-700 border-b",
          hasExpandableContent && "cursor-pointer hover:bg-[#252c3d]",
          expanded && "bg-[#1e2433]"
        )}
        onClick={() => hasExpandableContent && setExpanded(!expanded)}
      >
        <TableCell className="w-10">
          {hasExpandableContent ? (
            <Button
              className="h-6 w-6 text-teal-400 hover:bg-transparent hover:text-teal-300"
              size="icon"
              variant="ghost"
            >
              {expanded ? (
                <Minus className="h-4 w-4" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
            </Button>
          ) : (
            <span className="inline-block h-6 w-6" />
          )}
        </TableCell>
        <TableCell>
          <span
            className={cn("font-medium", getEventTypeColor(event.eventType))}
          >
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
        <TableRow className="border-gray-700 border-b">
          <TableCell className="bg-[#151922] p-0" colSpan={5}>
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
      <div className="py-8 text-center text-gray-400">No execution events</div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-gray-700 bg-[#1a1f2e]">
      <Table>
        <TableHeader>
          <TableRow className="border-gray-700 border-b bg-[#1e2433] hover:bg-[#1e2433]">
            <TableHead className="w-8 text-gray-400" />
            <TableHead className="font-medium text-gray-400">Event</TableHead>
            <TableHead className="w-20 font-medium text-gray-400">
              Event ID
            </TableHead>
            <TableHead className="font-medium text-gray-400">Name</TableHead>
            <TableHead className="w-40 font-medium text-gray-400">
              Timestamp
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((event, index) => (
            <EventRow event={event} key={`${event.eventType}-${index}`} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
