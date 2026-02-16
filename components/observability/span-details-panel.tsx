"use client";

import Link from "next/link";
import { Check, Copy } from "lucide-react";
import { useMemo, useState } from "react";
import { SyntaxHighlightedJson } from "@/components/monitor/json-panel";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ObservabilitySpan } from "@/lib/types/observability";

type SpanDetailsPanelProps = {
	span: ObservabilitySpan | null;
	fallbackExecutionId?: string | null;
	fallbackWorkflowId?: string | null;
};

function extractExecutionId(span: ObservabilitySpan | null): string | null {
	if (!span) {
		return null;
	}

	const candidates = [
		"workflow.db_execution_id",
		"workflow.dbExecutionId",
		"db.execution_id",
		"dbExecutionId",
		"workflow.instance_id",
		"workflow.instanceId",
	];

	for (const key of candidates) {
		const value = span.attributes[key];
		if (typeof value === "string" && value.trim()) {
			return value;
		}
	}

	return null;
}

function extractWorkflowId(span: ObservabilitySpan | null): string | null {
	if (!span) {
		return null;
	}

	const candidates = ["workflow.id", "workflow_id", "workflowId"];
	for (const key of candidates) {
		const value = span.attributes[key];
		if (typeof value === "string" && value.trim()) {
			return value;
		}
	}

	return null;
}

export function SpanDetailsPanel({
	span,
	fallbackExecutionId,
	fallbackWorkflowId,
}: SpanDetailsPanelProps) {
	const [copied, setCopied] = useState(false);

	const attributes = useMemo(() => {
		if (!span) {
			return [];
		}

		return Object.entries(span.attributes).sort(([a], [b]) =>
			a.localeCompare(b),
		);
	}, [span]);

	const executionId = extractExecutionId(span) ?? fallbackExecutionId ?? null;
	const workflowId = extractWorkflowId(span) ?? fallbackWorkflowId ?? null;

	if (!span) {
		return (
			<div className="rounded-lg border p-6 text-muted-foreground text-sm">
				Select a span to inspect its metadata and attributes.
			</div>
		);
	}

	return (
		<div className="overflow-hidden rounded-lg border bg-background">
			<div className="border-b px-4 py-3">
				<p className="truncate font-semibold text-sm">{span.name}</p>
				<p className="mt-1 font-mono text-muted-foreground text-xs">
					{span.spanId}
				</p>
			</div>

			<Tabs className="w-full" defaultValue="details">
				<div className="border-b px-4 pt-2">
					<TabsList className="h-9">
						<TabsTrigger value="details">Details</TabsTrigger>
						<TabsTrigger value="attributes">Attributes</TabsTrigger>
						<TabsTrigger value="raw">Raw</TabsTrigger>
					</TabsList>
				</div>

				<div className="max-h-[560px] overflow-auto p-4">
					<TabsContent className="mt-0 space-y-4" value="details">
						<div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
							<div>
								<p className="text-muted-foreground text-xs">Service</p>
								<p>{span.serviceName ?? "-"}</p>
							</div>
							<div>
								<p className="text-muted-foreground text-xs">Kind</p>
								<p>{span.kind ?? "-"}</p>
							</div>
							<div>
								<p className="text-muted-foreground text-xs">Status</p>
								<p>{span.statusCode ?? "-"}</p>
							</div>
							<div>
								<p className="text-muted-foreground text-xs">Duration</p>
								<p>{span.durationMs} ms</p>
							</div>
							<div>
								<p className="text-muted-foreground text-xs">Start</p>
								<p>{new Date(span.startedAt).toLocaleString()}</p>
							</div>
							<div>
								<p className="text-muted-foreground text-xs">End</p>
								<p>
									{span.endedAt ? new Date(span.endedAt).toLocaleString() : "-"}
								</p>
							</div>
							<div className="sm:col-span-2">
								<p className="text-muted-foreground text-xs">Parent Span</p>
								<p className="font-mono text-xs">{span.parentSpanId ?? "-"}</p>
							</div>
						</div>

						{(executionId || workflowId) && (
							<div className="flex flex-wrap gap-2 border-t pt-3">
								{executionId && (
									<Button asChild size="sm" variant="outline">
										<Link href={`/monitor/${executionId}`}>Open monitor</Link>
									</Button>
								)}
								{executionId && workflowId && (
									<Button asChild size="sm" variant="outline">
										<Link href={`/workflows/${workflowId}/runs/${executionId}`}>
											Open workflow run
										</Link>
									</Button>
								)}
							</div>
						)}
					</TabsContent>

					<TabsContent className="mt-0" value="attributes">
						{attributes.length === 0 ? (
							<div className="text-muted-foreground text-sm">
								No attributes.
							</div>
						) : (
							<div className="space-y-2">
								{attributes.map(([key, value]) => (
									<div
										className="rounded border bg-muted/30 px-3 py-2"
										key={key}
									>
										<p className="font-mono text-xs">{key}</p>
										<p className="mt-1 break-all text-sm">
											{typeof value === "string"
												? value
												: JSON.stringify(value, null, 2)}
										</p>
									</div>
								))}
							</div>
						)}
					</TabsContent>

					<TabsContent className="mt-0 space-y-3" value="raw">
						<div className="flex justify-end">
							<Button
								onClick={async () => {
									await navigator.clipboard.writeText(
										JSON.stringify(span, null, 2),
									);
									setCopied(true);
									setTimeout(() => setCopied(false), 1500);
								}}
								size="sm"
								variant="outline"
							>
								{copied ? (
									<>
										<Check className="mr-2 h-4 w-4" />
										Copied
									</>
								) : (
									<>
										<Copy className="mr-2 h-4 w-4" />
										Copy JSON
									</>
								)}
							</Button>
						</div>
						<div className="overflow-hidden rounded-lg border p-3">
							<SyntaxHighlightedJson data={span} fontSize="0.75rem" />
						</div>
					</TabsContent>
				</div>
			</Tabs>
		</div>
	);
}
