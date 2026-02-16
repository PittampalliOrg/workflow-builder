"use client";

import {
	AlertCircle,
	ChevronDown,
	ChevronRight,
	RefreshCcw,
	Search,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ObservabilitySpan } from "@/lib/types/observability";
import { cn } from "@/lib/utils";

type TraceTimelineProps = {
	spans: ObservabilitySpan[];
	selectedSpanId?: string;
	onSelectSpan?: (spanId: string) => void;
};

type SpanNode = {
	span: ObservabilitySpan;
	children: SpanNode[];
};

type FlattenedNode = {
	span: ObservabilitySpan;
	depth: number;
	hasChildren: boolean;
};

function getSpanTimeBounds(spans: ObservabilitySpan[]): {
	startMs: number;
	endMs: number;
	totalMs: number;
} {
	const startMs = Math.min(
		...spans.map((span) => new Date(span.startedAt).getTime()),
	);

	const endMs = Math.max(
		...spans.map((span) => {
			const ended = span.endedAt
				? new Date(span.endedAt).getTime()
				: new Date(span.startedAt).getTime() + span.durationMs;
			return ended;
		}),
	);

	return {
		startMs,
		endMs,
		totalMs: Math.max(1, endMs - startMs),
	};
}

function buildSpanTree(spans: ObservabilitySpan[]): SpanNode[] {
	const sorted = [...spans].sort(
		(a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
	);

	const nodeById = new Map<string, SpanNode>();
	for (const span of sorted) {
		nodeById.set(span.spanId, { span, children: [] });
	}

	const roots: SpanNode[] = [];
	for (const span of sorted) {
		const node = nodeById.get(span.spanId);
		if (!node) {
			continue;
		}

		if (span.parentSpanId && nodeById.has(span.parentSpanId)) {
			nodeById.get(span.parentSpanId)?.children.push(node);
		} else {
			roots.push(node);
		}
	}

	return roots;
}

function collectAllNodeIds(nodes: SpanNode[]): Set<string> {
	const ids = new Set<string>();

	function walk(node: SpanNode): void {
		ids.add(node.span.spanId);
		for (const child of node.children) {
			walk(child);
		}
	}

	for (const node of nodes) {
		walk(node);
	}

	return ids;
}

function flattenNodes(
	nodes: SpanNode[],
	expandedIds: Set<string>,
	fullyExpanded: boolean,
): FlattenedNode[] {
	const flattened: FlattenedNode[] = [];

	function walk(node: SpanNode, depth: number): void {
		const hasChildren = node.children.length > 0;
		flattened.push({ span: node.span, depth, hasChildren });

		if (!hasChildren) {
			return;
		}

		if (fullyExpanded || expandedIds.has(node.span.spanId)) {
			for (const child of node.children) {
				walk(child, depth + 1);
			}
		}
	}

	for (const node of nodes) {
		walk(node, 0);
	}

	return flattened;
}

function filterTreeByPredicate(
	nodes: SpanNode[],
	predicate: (span: ObservabilitySpan) => boolean,
): SpanNode[] {
	const filtered: SpanNode[] = [];

	for (const node of nodes) {
		const children = filterTreeByPredicate(node.children, predicate);
		if (predicate(node.span) || children.length > 0) {
			filtered.push({ span: node.span, children });
		}
	}

	return filtered;
}

function statusTone(statusCode: string | null): string {
	const status = statusCode?.toLowerCase() ?? "";
	if (status.includes("error")) {
		return "bg-red-500/70";
	}
	if (status.includes("ok") || status.includes("unset")) {
		return "bg-emerald-500/70";
	}
	return "bg-slate-500/60";
}

export function TraceTimeline({
	spans,
	selectedSpanId,
	onSelectSpan,
}: TraceTimelineProps) {
	const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
	const [searchPhrase, setSearchPhrase] = useState("");
	const [errorsOnly, setErrorsOnly] = useState(false);

	const tree = useMemo(() => buildSpanTree(spans), [spans]);
	const allNodeIds = useMemo(() => collectAllNodeIds(tree), [tree]);
	const bounds = useMemo(() => getSpanTimeBounds(spans), [spans]);

	const filteredTree = useMemo(() => {
		const normalizedSearch = searchPhrase.trim().toLowerCase();
		if (!normalizedSearch && !errorsOnly) {
			return tree;
		}

		return filterTreeByPredicate(tree, (span) => {
			const matchesSearch =
				!normalizedSearch ||
				span.name.toLowerCase().includes(normalizedSearch) ||
				(span.serviceName?.toLowerCase().includes(normalizedSearch) ?? false);
			const matchesError =
				!errorsOnly ||
				(span.statusCode?.toLowerCase().includes("error") ?? false);
			return matchesSearch && matchesError;
		});
	}, [errorsOnly, searchPhrase, tree]);

	const visibleRows = useMemo(
		() =>
			flattenNodes(
				filteredTree,
				expandedIds,
				searchPhrase.trim().length > 0 || errorsOnly,
			),
		[errorsOnly, expandedIds, filteredTree, searchPhrase],
	);

	const toggleSpanExpanded = (spanId: string) => {
		setExpandedIds((prev) => {
			const next = new Set(prev);
			if (next.has(spanId)) {
				next.delete(spanId);
			} else {
				next.add(spanId);
			}
			return next;
		});
	};

	if (spans.length === 0) {
		return (
			<div className="rounded-lg border p-6 text-muted-foreground text-sm">
				No spans found for this trace.
			</div>
		);
	}

	return (
		<div className="overflow-hidden rounded-lg border bg-background">
			<div className="flex flex-wrap items-center gap-2 border-b p-3">
				<div className="relative min-w-[220px] flex-1 md:max-w-sm">
					<Search className="-translate-y-1/2 absolute top-1/2 left-3 h-4 w-4 text-muted-foreground" />
					<Input
						className="pl-9"
						onChange={(event) => setSearchPhrase(event.target.value)}
						placeholder="Search spans..."
						value={searchPhrase}
					/>
				</div>
				<Button
					onClick={() => setErrorsOnly((prev) => !prev)}
					size="sm"
					variant={errorsOnly ? "default" : "outline"}
				>
					<AlertCircle className="mr-2 h-4 w-4" />
					Errors only
				</Button>
				<Button
					onClick={() => setExpandedIds(new Set(allNodeIds))}
					size="sm"
					variant="outline"
				>
					Expand all
				</Button>
				<Button
					onClick={() => setExpandedIds(new Set())}
					size="sm"
					variant="outline"
				>
					Collapse all
				</Button>
				<Button
					onClick={() => {
						setSearchPhrase("");
						setErrorsOnly(false);
					}}
					size="sm"
					variant="ghost"
				>
					<RefreshCcw className="mr-2 h-4 w-4" />
					Reset
				</Button>
			</div>

			<div className="grid grid-cols-[minmax(18rem,1fr)_minmax(16rem,2fr)] border-b bg-muted/30 px-3 py-2 text-muted-foreground text-xs">
				<div>Name</div>
				<div>Timeline</div>
			</div>

			<div className="max-h-[560px] overflow-auto">
				{visibleRows.length === 0 ? (
					<div className="p-4 text-muted-foreground text-sm">
						No spans match the current filters.
					</div>
				) : (
					visibleRows.map((row) => {
						const startedMs = new Date(row.span.startedAt).getTime();
						const endedMs = row.span.endedAt
							? new Date(row.span.endedAt).getTime()
							: startedMs + row.span.durationMs;
						const left = ((startedMs - bounds.startMs) / bounds.totalMs) * 100;
						const width = Math.max(
							0.6,
							((endedMs - startedMs) / bounds.totalMs) * 100,
						);
						const isSelected = selectedSpanId === row.span.spanId;
						const isExpanded = expandedIds.has(row.span.spanId);

						return (
							<button
								className={cn(
									"grid w-full grid-cols-[minmax(18rem,1fr)_minmax(16rem,2fr)] border-b text-left hover:bg-muted/40",
									isSelected && "bg-primary/10",
								)}
								key={row.span.spanId}
								onClick={() => onSelectSpan?.(row.span.spanId)}
								type="button"
							>
								<div
									className="flex min-w-0 items-center gap-2 px-3 py-2"
									style={{ paddingLeft: `${12 + row.depth * 20}px` }}
								>
									{row.hasChildren ? (
										<span
											className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-muted"
											onClick={(event) => {
												event.stopPropagation();
												toggleSpanExpanded(row.span.spanId);
											}}
										>
											{isExpanded ? (
												<ChevronDown className="h-4 w-4 text-muted-foreground" />
											) : (
												<ChevronRight className="h-4 w-4 text-muted-foreground" />
											)}
										</span>
									) : (
										<span className="inline-block h-5 w-5" />
									)}

									<div className="min-w-0">
										<div className="truncate font-medium text-sm">
											{row.span.name}
										</div>
										<div className="truncate text-muted-foreground text-xs">
											{row.span.serviceName ?? "unknown service"} •{" "}
											{row.span.durationMs} ms
										</div>
									</div>
								</div>

								<div className="flex items-center px-3 py-2">
									<div className="relative h-6 w-full rounded bg-muted/30">
										<div
											className={cn(
												"absolute top-1/2 h-3 -translate-y-1/2 rounded",
												statusTone(row.span.statusCode),
											)}
											style={{
												left: `${Math.max(0, Math.min(100, left))}%`,
												width: `${Math.max(
													0.6,
													Math.min(100 - Math.max(0, left), width),
												)}%`,
											}}
										/>
									</div>
								</div>
							</button>
						);
					})
				)}
			</div>
		</div>
	);
}
