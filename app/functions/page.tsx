"use client";

import { ArrowLeft, Box, Cloud, Code, Globe, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api, type FunctionSummary } from "@/lib/api-client";

type ExecutionType = "builtin" | "oci" | "http";

const executionTypeIcons: Record<ExecutionType, React.ReactNode> = {
	builtin: <Code className="h-4 w-4" />,
	oci: <Box className="h-4 w-4" />,
	http: <Globe className="h-4 w-4" />,
};

const executionTypeLabels: Record<ExecutionType, string> = {
	builtin: "Builtin",
	oci: "Container",
	http: "Webhook",
};

export default function FunctionsPage() {
	const [functions, setFunctions] = useState<FunctionSummary[]>([]);
	const [loading, setLoading] = useState(true);
	const [search, setSearch] = useState("");
	const [executionTypeFilter, setExecutionTypeFilter] = useState<string>("all");

	const loadFunctions = useCallback(async () => {
		try {
			setLoading(true);
			const response = await api.functions.getAll({
				search: search || undefined,
				executionType:
					executionTypeFilter === "all"
						? undefined
						: (executionTypeFilter as ExecutionType),
			});
			setFunctions(response.functions);
		} catch (error) {
			console.error("Failed to load functions:", error);
			toast.error("Failed to load functions");
		} finally {
			setLoading(false);
		}
	}, [search, executionTypeFilter]);

	useEffect(() => {
		loadFunctions();
	}, [loadFunctions]);

	// Group functions by plugin
	const groupedFunctions = functions.reduce(
		(acc, fn) => {
			const plugin = fn.pluginId || "other";
			if (!acc[plugin]) {
				acc[plugin] = [];
			}
			acc[plugin].push(fn);
			return acc;
		},
		{} as Record<string, FunctionSummary[]>,
	);

	const pluginIds = Object.keys(groupedFunctions).sort();

	return (
		<div className="container mx-auto max-w-6xl py-8">
			<div className="mb-8 flex items-center justify-between">
				<div className="flex items-center gap-4">
					<Link href="/workflows">
						<Button size="icon" variant="ghost">
							<ArrowLeft className="h-4 w-4" />
						</Button>
					</Link>
					<div>
						<h1 className="font-bold text-2xl">Functions</h1>
						<p className="text-muted-foreground">
							Manage function definitions for workflow execution
						</p>
					</div>
				</div>
				<Link href="/functions/new">
					<Button>
						<Plus className="mr-2 h-4 w-4" />
						Create Function
					</Button>
				</Link>
			</div>

			<Card className="mb-6">
				<CardHeader>
					<CardTitle>Filters</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="flex gap-4">
						<div className="flex-1">
							<div className="relative">
								<Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
								<Input
									className="pl-10"
									onChange={(e) => setSearch(e.target.value)}
									placeholder="Search functions..."
									value={search}
								/>
							</div>
						</div>
						<Select
							onValueChange={setExecutionTypeFilter}
							value={executionTypeFilter}
						>
							<SelectTrigger className="w-[180px]">
								<SelectValue placeholder="Execution Type" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All Types</SelectItem>
								<SelectItem value="builtin">
									<div className="flex items-center gap-2">
										<Code className="h-4 w-4" />
										Builtin
									</div>
								</SelectItem>
								<SelectItem value="oci">
									<div className="flex items-center gap-2">
										<Box className="h-4 w-4" />
										Container (OCI)
									</div>
								</SelectItem>
								<SelectItem value="http">
									<div className="flex items-center gap-2">
										<Globe className="h-4 w-4" />
										Webhook (HTTP)
									</div>
								</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</CardContent>
			</Card>

			{loading ? (
				<div className="flex items-center justify-center py-12">
					<div className="text-muted-foreground">Loading functions...</div>
				</div>
			) : functions.length === 0 ? (
				<Card>
					<CardContent className="flex flex-col items-center justify-center py-12">
						<Cloud className="mb-4 h-12 w-12 text-muted-foreground" />
						<h3 className="mb-2 font-semibold text-lg">No functions found</h3>
						<p className="mb-4 text-center text-muted-foreground">
							{search || executionTypeFilter !== "all"
								? "Try adjusting your filters"
								: "Create your first function to get started"}
						</p>
						{!search && executionTypeFilter === "all" && (
							<Link href="/functions/new">
								<Button>
									<Plus className="mr-2 h-4 w-4" />
									Create Function
								</Button>
							</Link>
						)}
					</CardContent>
				</Card>
			) : (
				<div className="space-y-6">
					{pluginIds.map((pluginId) => (
						<Card key={pluginId}>
							<CardHeader>
								<CardTitle className="capitalize">{pluginId}</CardTitle>
								<CardDescription>
									{groupedFunctions[pluginId].length} function
									{groupedFunctions[pluginId].length !== 1 ? "s" : ""}
								</CardDescription>
							</CardHeader>
							<CardContent>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Name</TableHead>
											<TableHead>Slug</TableHead>
											<TableHead>Type</TableHead>
											<TableHead>Integration</TableHead>
											<TableHead>Status</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{groupedFunctions[pluginId].map((fn) => (
											<TableRow key={fn.id}>
												<TableCell>
													<div>
														<div className="font-medium">{fn.name}</div>
														{fn.description && (
															<div className="text-muted-foreground text-sm">
																{fn.description}
															</div>
														)}
													</div>
												</TableCell>
												<TableCell>
													<code className="rounded bg-muted px-2 py-1 text-sm">
														{fn.slug}
													</code>
												</TableCell>
												<TableCell>
													<Badge className="gap-1" variant="secondary">
														{executionTypeIcons[fn.executionType]}
														{executionTypeLabels[fn.executionType]}
													</Badge>
												</TableCell>
												<TableCell>
													{fn.integrationType ? (
														<Badge variant="outline">
															{fn.integrationType}
														</Badge>
													) : (
														<span className="text-muted-foreground">-</span>
													)}
												</TableCell>
												<TableCell>
													<div className="flex items-center gap-2">
														{fn.isBuiltin && (
															<Badge variant="default">Builtin</Badge>
														)}
														{fn.isEnabled ? (
															<Badge
																className="border-green-500 text-green-500"
																variant="outline"
															>
																Enabled
															</Badge>
														) : (
															<Badge
																className="border-red-500 text-red-500"
																variant="outline"
															>
																Disabled
															</Badge>
														)}
													</div>
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</CardContent>
						</Card>
					))}
				</div>
			)}
		</div>
	);
}
