"use client";

import { format } from "date-fns";
import {
	AlertTriangle,
	Bot,
	ChevronDown,
	ChevronRight,
	ExternalLink,
	Info,
	Square,
	Workflow,
} from "lucide-react";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/lib/api-client";
import type { AgentType, DiscoveredAgent } from "@/lib/types/discovered-agent";

function formatTimestamp(iso: string | null): string {
	if (!iso) return "-";
	try {
		return format(new Date(iso), "dd MMM yyyy h:mm:ss a");
	} catch {
		return iso;
	}
}

function TypeBadge({ type }: { type: AgentType }) {
	return (
		<Badge
			variant="outline"
			className="border-emerald-600 text-emerald-600 dark:border-emerald-400 dark:text-emerald-400"
		>
			{type === "Durable agent" ? (
				<Workflow className="mr-1 size-3" />
			) : (
				<Bot className="mr-1 size-3" />
			)}
			{type}
		</Badge>
	);
}

export default function AgentDetailPage() {
	const params = useParams<{ appId: string; agentName: string }>();
	const appId = decodeURIComponent(params.appId);
	const agentName = decodeURIComponent(params.agentName);

	const [agent, setAgent] = useState<DiscoveredAgent | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [instructionsOpen, setInstructionsOpen] = useState(false);

	const fetchAgent = useCallback(async () => {
		try {
			const result = await api.discoveredAgent.get(appId, agentName);
			setAgent(result);
		} catch (err) {
			console.error("Failed to fetch agent:", err);
			setError(err instanceof Error ? err.message : "Failed to load agent");
		} finally {
			setLoading(false);
		}
	}, [appId, agentName]);

	useEffect(() => {
		fetchAgent();
	}, [fetchAgent]);

	const copyInstructions = () => {
		if (!agent?.instructions) return;
		navigator.clipboard.writeText(agent.instructions.join("\n"));
		toast.success("Copied to clipboard");
	};

	if (loading) {
		return (
			<div className="pointer-events-auto mx-auto max-w-4xl p-6">
				<Skeleton className="mb-4 h-4 w-48" />
				<Skeleton className="mb-8 h-8 w-64" />
				<Skeleton className="mb-4 h-40 w-full" />
				<Skeleton className="h-32 w-full" />
			</div>
		);
	}

	if (error || !agent) {
		return (
			<div className="pointer-events-auto mx-auto max-w-4xl p-6">
				<Link
					href="/agents"
					className="mb-4 inline-block text-sm text-muted-foreground hover:text-foreground"
				>
					&larr; Agents
				</Link>
				<div className="py-12 text-center">
					<Bot className="mx-auto mb-4 size-12 text-muted-foreground/50" />
					<p className="text-muted-foreground text-sm">
						{error ?? "Agent not found"}
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="pointer-events-auto mx-auto max-w-4xl p-6">
			{/* Breadcrumb */}
			<div className="mb-4 text-sm">
				<Link
					href="/agents"
					className="text-muted-foreground hover:text-foreground"
				>
					Agents
				</Link>
				<span className="mx-2 text-muted-foreground">/</span>
				<span>{agent.name}</span>
			</div>

			{/* Header */}
			<div className="mb-8 border-l-[5px] border-emerald-600 pl-4">
				<div className="flex items-center gap-3">
					<h1 className="font-semibold text-2xl">{agent.name}</h1>
					<TypeBadge type={agent.type} />
				</div>
				<div className="mt-1">
					<Link
						href="/dapr"
						className="inline-flex items-center gap-1 text-sm text-emerald-600 hover:underline dark:text-emerald-400"
					>
						App ID: {agent.appId}
						<ExternalLink className="size-3" />
					</Link>
				</div>
				<div className="mt-0.5">
					<Link
						href="/agents"
						className="text-sm text-emerald-600 hover:underline dark:text-emerald-400"
					>
						Agents
					</Link>
				</div>
			</div>

			{/* Agent configuration */}
			<div className="mb-6 rounded-xl border bg-muted/20 p-6">
				<h2 className="mb-4 font-semibold text-lg">Agent configuration</h2>

				{/* Label-value row */}
				<div className="mb-6 flex gap-12">
					<div>
						<div className="mb-1 text-sm font-bold uppercase text-muted-foreground">
							Role
						</div>
						<div className="text-sm">{agent.role ?? "Not set"}</div>
					</div>
					<div>
						<div className="mb-1 text-sm font-bold uppercase text-muted-foreground">
							Registered
						</div>
						{agent.registered && (
							<div className="text-sm">{formatTimestamp(agent.registered)}</div>
						)}
					</div>
					<div>
						<div className="mb-1 text-sm font-bold uppercase text-muted-foreground">
							Updated
						</div>
						{agent.updated && (
							<div className="text-sm">{formatTimestamp(agent.updated)}</div>
						)}
					</div>
				</div>

				{/* Goal */}
				{agent.goal && (
					<div className="mb-6">
						<div className="mb-1 text-sm font-bold uppercase text-muted-foreground">
							Goal
						</div>
						<p className="text-sm">{agent.goal}</p>
					</div>
				)}

				{/* System instructions */}
				{agent.instructions && agent.instructions.length > 0 && (
					<div className="mb-6">
						<button
							type="button"
							className="flex w-full items-center justify-between rounded-md border px-4 py-3 text-left hover:bg-muted/50"
							onClick={() => setInstructionsOpen(!instructionsOpen)}
						>
							<span className="text-sm font-medium">System instructions</span>
							{instructionsOpen ? (
								<ChevronDown className="size-4 text-muted-foreground" />
							) : (
								<ChevronRight className="size-4 text-muted-foreground" />
							)}
						</button>
						{instructionsOpen && (
							<div className="mt-2 px-4 py-2">
								<div className="mb-2 flex justify-end">
									<button
										type="button"
										className="text-sm text-emerald-600 hover:underline dark:text-emerald-400"
										onClick={copyInstructions}
									>
										Copy
									</button>
								</div>
								{agent.instructions.map((line, i) => (
									<p key={i} className="mb-1 font-mono text-sm">
										{line}
									</p>
								))}
							</div>
						)}
					</div>
				)}

				{/* Available tools */}
				<div>
					<div className="mb-2 text-sm font-bold uppercase text-muted-foreground">
						Available tools
					</div>
					{agent.tools.length > 0 ? (
						<div className="flex flex-wrap gap-2">
							{agent.tools.map((tool) => (
								<Badge key={tool} variant="secondary" className="text-xs">
									{tool}
								</Badge>
							))}
						</div>
					) : (
						<div className="flex items-center gap-2 text-sm text-amber-600">
							<AlertTriangle className="size-4" />
							No tools configured
						</div>
					)}
				</div>
			</div>

			{/* Model configuration */}
			<div className="border-t pt-6">
				<div className="flex items-start justify-between">
					<div>
						<h2 className="mb-4 font-semibold text-lg">Model configuration</h2>

						<div className="flex gap-12">
							<div>
								<div className="mb-1 text-sm font-bold uppercase text-muted-foreground">
									Client
								</div>
								<div className="flex items-center gap-2 text-sm">
									<Square className="size-3.5 fill-blue-500 text-blue-500" />
									{agent.modelClient ?? "DaprChatClient"} ( )
								</div>
							</div>
							<div>
								<div className="mb-1 flex items-center gap-1 text-sm font-bold uppercase text-muted-foreground">
									Max Iterations
									<TooltipProvider>
										<Tooltip>
											<TooltipTrigger>
												<Info className="size-3" />
											</TooltipTrigger>
											<TooltipContent>
												Maximum number of ReAct loop iterations before the agent
												stops.
											</TooltipContent>
										</Tooltip>
									</TooltipProvider>
								</div>
								<div className="text-sm">{agent.maxIterations ?? 0}</div>
							</div>
						</div>
					</div>

					<Link href="/dapr">
						<Button
							variant="outline"
							size="sm"
							className="border-emerald-500/50 text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400"
						>
							View API logs
							<ExternalLink className="ml-2 size-3" />
						</Button>
					</Link>
				</div>
			</div>
		</div>
	);
}
