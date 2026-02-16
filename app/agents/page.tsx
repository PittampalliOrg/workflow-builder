"use client";

import { formatDistanceToNow } from "date-fns";
import { Bot, Copy, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { AgentEditor } from "@/components/agents/agent-editor";
import {
	type AgentData,
	type CreateAgentBody,
	type UpdateAgentBody,
	api,
} from "@/lib/api-client";

function getTypeBadge(agentType: string) {
	const colors: Record<string, string> = {
		general: "bg-blue-500/10 text-blue-600",
		"code-assistant": "bg-violet-500/10 text-violet-600",
		research: "bg-amber-500/10 text-amber-600",
		planning: "bg-emerald-500/10 text-emerald-600",
		custom: "bg-gray-500/10 text-gray-600",
	};

	const labels: Record<string, string> = {
		general: "General",
		"code-assistant": "Code",
		research: "Research",
		planning: "Planning",
		custom: "Custom",
	};

	return (
		<Badge className={`border-transparent ${colors[agentType] ?? colors.custom}`}>
			{labels[agentType] ?? agentType}
		</Badge>
	);
}

export default function AgentsPage() {
	const [agents, setAgents] = useState<AgentData[]>([]);
	const [loading, setLoading] = useState(true);
	const [editorOpen, setEditorOpen] = useState(false);
	const [editTarget, setEditTarget] = useState<AgentData | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<AgentData | null>(null);
	const [deleting, setDeleting] = useState(false);

	const fetchAgents = useCallback(async () => {
		try {
			const result = await api.agent.list();
			setAgents(result);
		} catch (error) {
			console.error("Failed to fetch agents:", error);
			toast.error("Failed to load agents");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchAgents();
	}, [fetchAgents]);

	const handleCreate = () => {
		setEditTarget(null);
		setEditorOpen(true);
	};

	const handleEdit = (agent: AgentData) => {
		setEditTarget(agent);
		setEditorOpen(true);
	};

	const handleSave = async (data: CreateAgentBody | UpdateAgentBody) => {
		if (editTarget) {
			await api.agent.update(editTarget.id, data);
			toast.success("Agent updated");
		} else {
			await api.agent.create(data as CreateAgentBody);
			toast.success("Agent created");
		}
		fetchAgents();
	};

	const handleDuplicate = async (agent: AgentData) => {
		try {
			await api.agent.duplicate(agent.id);
			toast.success("Agent duplicated");
			fetchAgents();
		} catch (error) {
			toast.error("Failed to duplicate agent");
		}
	};

	const handleDelete = async () => {
		if (!deleteTarget) return;
		try {
			setDeleting(true);
			await api.agent.delete(deleteTarget.id);
			toast.success("Agent deleted");
			setDeleteTarget(null);
			fetchAgents();
		} catch (error) {
			toast.error("Failed to delete agent");
		} finally {
			setDeleting(false);
		}
	};

	return (
		<div className="pointer-events-auto mx-auto max-w-5xl p-6">
			<div className="mb-6 flex items-center justify-between">
				<div>
					<h1 className="font-semibold text-2xl">Agents</h1>
					<p className="text-muted-foreground text-sm">
						Create and manage reusable agent configurations
					</p>
				</div>
				<Button onClick={handleCreate}>
					<Plus className="mr-2 size-4" />
					New Agent
				</Button>
			</div>

			{loading ? (
				<div className="py-12 text-center text-muted-foreground text-sm">
					Loading agents...
				</div>
			) : agents.length === 0 ? (
				<div className="py-12 text-center">
					<Bot className="mx-auto mb-4 size-12 text-muted-foreground/50" />
					<p className="text-muted-foreground text-sm">
						No agents yet. Create one to get started.
					</p>
					<Button className="mt-4" onClick={handleCreate} variant="outline">
						<Plus className="mr-2 size-4" />
						Create your first agent
					</Button>
				</div>
			) : (
				<div className="rounded-md border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Name</TableHead>
								<TableHead>Type</TableHead>
								<TableHead>Model</TableHead>
								<TableHead>Tools</TableHead>
								<TableHead>Updated</TableHead>
								<TableHead className="w-[140px]" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{agents.map((agent) => (
								<TableRow key={agent.id}>
									<TableCell>
										<div className="flex items-center gap-2">
											<span className="font-medium">{agent.name}</span>
											{agent.isDefault && (
												<Star className="size-3 text-amber-500 fill-amber-500" />
											)}
											{!agent.isEnabled && (
												<Badge variant="secondary" className="text-xs">
													Disabled
												</Badge>
											)}
										</div>
										{agent.description && (
											<p className="text-xs text-muted-foreground truncate max-w-[300px]">
												{agent.description}
											</p>
										)}
									</TableCell>
									<TableCell>{getTypeBadge(agent.agentType)}</TableCell>
									<TableCell>
										<code className="text-xs">
											{agent.model.provider}/{agent.model.name}
										</code>
									</TableCell>
									<TableCell>
										<span className="text-sm text-muted-foreground">
											{agent.tools.length} tool
											{agent.tools.length !== 1 ? "s" : ""}
										</span>
									</TableCell>
									<TableCell className="text-muted-foreground text-sm">
										{formatDistanceToNow(new Date(agent.updatedAt), {
											addSuffix: true,
										})}
									</TableCell>
									<TableCell>
										<TooltipProvider delayDuration={300}>
											<div className="flex items-center gap-1">
												<Tooltip>
													<TooltipTrigger asChild>
														<Button
															onClick={() => handleEdit(agent)}
															size="icon"
															variant="ghost"
														>
															<Pencil className="size-4" />
														</Button>
													</TooltipTrigger>
													<TooltipContent>Edit</TooltipContent>
												</Tooltip>

												<Tooltip>
													<TooltipTrigger asChild>
														<Button
															onClick={() => handleDuplicate(agent)}
															size="icon"
															variant="ghost"
														>
															<Copy className="size-4" />
														</Button>
													</TooltipTrigger>
													<TooltipContent>Duplicate</TooltipContent>
												</Tooltip>

												<Tooltip>
													<TooltipTrigger asChild>
														<Button
															className="text-destructive hover:text-destructive"
															onClick={() => setDeleteTarget(agent)}
															size="icon"
															variant="ghost"
														>
															<Trash2 className="size-4" />
														</Button>
													</TooltipTrigger>
													<TooltipContent>Delete</TooltipContent>
												</Tooltip>
											</div>
										</TooltipProvider>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}

			<AgentEditor
				key={editTarget?.id ?? "new"}
				open={editorOpen}
				onOpenChange={setEditorOpen}
				agent={editTarget}
				onSave={handleSave}
			/>

			<AlertDialog
				onOpenChange={(open) => !open && setDeleteTarget(null)}
				open={!!deleteTarget}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete Agent</AlertDialogTitle>
						<AlertDialogDescription>
							Are you sure you want to delete{" "}
							<strong>{deleteTarget?.name}</strong>? Workflows using this
							agent will fall back to inline configuration.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
							disabled={deleting}
							onClick={handleDelete}
						>
							{deleting ? "Deleting..." : "Delete"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
