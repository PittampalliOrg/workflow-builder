"use client";

import { formatDistanceToNow } from "date-fns";
import {
	AlertCircle,
	Bot,
	Boxes,
	RefreshCw,
	Server,
	Wrench,
	Workflow,
} from "lucide-react";
import { useEffect, useState } from "react";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api-client";
import type {
	DaprDebugAppDetailResponse,
	DaprDebugOverviewResponse,
	DaprRuntimeIntrospection,
} from "@/lib/types/dapr-debug";
import { cn } from "@/lib/utils";

function formatRelative(value?: string | null): string {
	if (!value) return "-";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return formatDistanceToNow(date, { addSuffix: true });
}

function formatJson(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2);
}

function getInstanceRowKey(
	instance: DaprDebugOverviewResponse["instances"][number],
) {
	return [
		instance.appId,
		instance.scope,
		instance.created,
		instance.appPort,
		instance.httpPort,
		instance.grpcPort,
		instance.replicas,
	]
		.map((value) => String(value ?? ""))
		.join(":");
}

function SourceBadge({ ok, label }: { ok: boolean; label: string }) {
	return (
		<Badge
			className={cn(
				"border-transparent",
				ok
					? "bg-emerald-500/10 text-emerald-700"
					: "bg-amber-500/10 text-amber-700",
			)}
		>
			{label}
		</Badge>
	);
}

function StatusBadge({ value }: { value: string }) {
	const normalized = value.toUpperCase();
	const className =
		normalized === "RUNNING" || normalized === "READY"
			? "bg-amber-500/10 text-amber-700"
			: normalized === "COMPLETED" || normalized === "TRUE"
				? "bg-emerald-500/10 text-emerald-700"
				: normalized === "FAILED" || normalized === "FALSE"
					? "bg-red-500/10 text-red-700"
					: "bg-slate-500/10 text-slate-700";

	return <Badge className={cn("border-transparent", className)}>{value}</Badge>;
}

function OverviewCard({
	title,
	description,
	value,
	icon: Icon,
}: {
	title: string;
	description: string;
	value: string | number;
	icon: typeof Server;
}) {
	return (
		<Card>
			<CardHeader className="pb-2">
				<div className="flex items-center justify-between gap-3">
					<div>
						<CardTitle className="text-sm">{title}</CardTitle>
						<CardDescription>{description}</CardDescription>
					</div>
					<Icon className="size-4 text-muted-foreground" />
				</div>
			</CardHeader>
			<CardContent>
				<div className="font-semibold text-2xl">{value}</div>
			</CardContent>
		</Card>
	);
}

function RegistrationTable({
	title,
	rows,
}: {
	title: string;
	rows: Array<{ name: string; version?: string | null; aliases?: string[] }>;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>{title}</CardTitle>
			</CardHeader>
			<CardContent>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Name</TableHead>
							<TableHead>Version</TableHead>
							<TableHead>Aliases</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.length === 0 ? (
							<TableRow>
								<TableCell className="text-muted-foreground" colSpan={3}>
									No registrations reported.
								</TableCell>
							</TableRow>
						) : (
							rows.map((row) => (
								<TableRow key={`${row.name}-${row.version ?? "none"}`}>
									<TableCell className="font-medium">{row.name}</TableCell>
									<TableCell>{row.version ?? "-"}</TableCell>
									<TableCell>{row.aliases?.join(", ") || "-"}</TableCell>
								</TableRow>
							))
						)}
					</TableBody>
				</Table>
			</CardContent>
		</Card>
	);
}

function IntrospectionCard({
	title,
	introspection,
	sourceOk,
}: {
	title: string;
	introspection: DaprRuntimeIntrospection | null;
	sourceOk: boolean;
}) {
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between gap-3">
					<div>
						<CardTitle>{title}</CardTitle>
						<CardDescription>
							Service-reported runtime registrations and feature flags.
						</CardDescription>
					</div>
					<SourceBadge label="service introspection" ok={sourceOk} />
				</div>
			</CardHeader>
			<CardContent className="space-y-4">
				{!introspection ? (
					<div className="text-muted-foreground text-sm">
						Service introspection unavailable.
					</div>
				) : (
					<>
						<div className="grid gap-3 md:grid-cols-2">
							<div className="rounded-lg border p-3">
								<div className="mb-1 text-muted-foreground text-xs uppercase">
									Runtime
								</div>
								<div className="font-medium">
									{introspection.runtime} v{introspection.version}
								</div>
							</div>
							<div className="rounded-lg border p-3">
								<div className="mb-1 text-muted-foreground text-xs uppercase">
									Ready
								</div>
								<StatusBadge
									value={introspection.ready ? "READY" : "NOT_READY"}
								/>
							</div>
						</div>
						<RegistrationTable
							rows={introspection.registeredWorkflows}
							title="Registered Workflows"
						/>
						<Card>
							<CardHeader>
								<CardTitle>Registered Activities</CardTitle>
							</CardHeader>
							<CardContent>
								<div className="flex flex-wrap gap-2">
									{introspection.registeredActivities.map((activity) => (
										<Badge
											className="border-transparent bg-slate-500/10 text-slate-700"
											key={activity.name}
										>
											{activity.name}
										</Badge>
									))}
								</div>
							</CardContent>
						</Card>
						<Card>
							<CardHeader>
								<CardTitle>Runtime Status</CardTitle>
							</CardHeader>
							<CardContent>
								<pre className="max-h-80 overflow-auto rounded-lg bg-muted p-3 text-xs">
									{formatJson(introspection.runtimeStatus)}
								</pre>
							</CardContent>
						</Card>
					</>
				)}
			</CardContent>
		</Card>
	);
}

export function DaprDebugPage() {
	const [overview, setOverview] = useState<DaprDebugOverviewResponse | null>(
		null,
	);
	const [selectedAppId, setSelectedAppId] = useState<string>(
		"workflow-orchestrator",
	);
	const [selectedApp, setSelectedApp] =
		useState<DaprDebugAppDetailResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [detailLoading, setDetailLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function loadOverview() {
		try {
			setLoading(true);
			setError(null);
			const data = await api.daprDebug.getOverview();
			setOverview(data);
			const firstApp = data.instances[0]?.appId || "workflow-orchestrator";
			setSelectedAppId((current) =>
				data.instances.some((instance) => instance.appId === current)
					? current
					: firstApp,
			);
		} catch (loadError) {
			setError(
				loadError instanceof Error ? loadError.message : String(loadError),
			);
		} finally {
			setLoading(false);
		}
	}

	async function loadAppDetail(appId: string) {
		try {
			setDetailLoading(true);
			const data = await api.daprDebug.getApp(appId);
			setSelectedApp(data);
		} catch {
			setSelectedApp(null);
		} finally {
			setDetailLoading(false);
		}
	}

	useEffect(() => {
		void loadOverview();
	}, []);

	useEffect(() => {
		if (!selectedAppId) return;
		void loadAppDetail(selectedAppId);
	}, [selectedAppId]);

	if (loading) {
		return (
			<div className="container mx-auto space-y-6 py-6">
				<div className="flex items-center gap-4">
					<SidebarToggle />
					<div className="space-y-2">
						<Skeleton className="h-8 w-40" />
						<Skeleton className="h-4 w-96" />
					</div>
				</div>
				<div className="grid gap-4 md:grid-cols-4">
					{["1", "2", "3", "4"].map((key) => (
						<Skeleton className="h-32" key={key} />
					))}
				</div>
				<Skeleton className="h-[520px]" />
			</div>
		);
	}

	if (error || !overview) {
		return (
			<div className="container mx-auto space-y-6 py-6">
				<div className="flex items-center gap-4">
					<SidebarToggle />
					<div>
						<h1 className="font-bold text-3xl">Dapr Debug</h1>
						<p className="text-muted-foreground">
							Inspect Dapr runtime state, registrations, and workflow services.
						</p>
					</div>
				</div>
				<Alert variant="destructive">
					<AlertCircle />
					<AlertTitle>Failed to load Dapr debug data</AlertTitle>
					<AlertDescription>{error || "Unknown error"}</AlertDescription>
				</Alert>
			</div>
		);
	}

	return (
		<div className="container mx-auto space-y-6 py-6">
			<div className="flex items-start justify-between gap-4">
				<div className="flex items-start gap-4">
					<SidebarToggle />
					<div>
						<div className="flex items-center gap-2">
							<h1 className="font-bold text-3xl">Dapr Debug</h1>
							<Badge className="border-transparent bg-slate-500/10 text-slate-700">
								workflow-builder focused
							</Badge>
						</div>
						<p className="text-muted-foreground">
							Read-only runtime inspection for Dapr dashboard data, service
							registrations, components, configs, and workflow runs.
						</p>
					</div>
				</div>
				<Button
					disabled={loading || detailLoading}
					onClick={() => {
						void loadOverview();
						void loadAppDetail(selectedAppId);
					}}
					variant="outline"
				>
					<RefreshCw
						className={cn(
							"mr-2 size-4",
							(loading || detailLoading) && "animate-spin",
						)}
					/>
					Refresh
				</Button>
			</div>

			<div className="grid gap-4 md:grid-cols-4">
				<OverviewCard
					description="Dapr-enabled apps in workflow-builder"
					icon={Server}
					title="Apps"
					value={overview.instances.length}
				/>
				<OverviewCard
					description="Control plane services reported by dashboard"
					icon={Boxes}
					title="Control Plane"
					value={overview.dashboard.controlPlane.length}
				/>
				<OverviewCard
					description="Dapr components in workflow-builder"
					icon={Wrench}
					title="Components"
					value={overview.components.length}
				/>
				<OverviewCard
					description="Recent workflow runtime instances"
					icon={Workflow}
					title="Workflow Runs"
					value={overview.workflowRuntime.recentRuns.length}
				/>
			</div>

			<div className="flex flex-wrap gap-2">
				<SourceBadge label="dashboard" ok={overview.sources.dashboard.ok} />
				<SourceBadge
					label="workflow-orchestrator"
					ok={overview.sources.workflowOrchestrator.ok}
				/>
				<SourceBadge
					label="durable-agent"
					ok={overview.sources.durableAgent.ok}
				/>
				<SourceBadge
					label="application agents"
					ok={overview.sources.applicationAgents.ok}
				/>
				<Badge className="border-transparent bg-slate-500/10 text-slate-700">
					platform: {overview.dashboard.platform}
				</Badge>
			</div>

			<Tabs className="space-y-4" defaultValue="apps">
				<TabsList>
					<TabsTrigger value="apps">Apps</TabsTrigger>
					<TabsTrigger value="runtime">Workflow Runtime</TabsTrigger>
					<TabsTrigger value="agents">Agents</TabsTrigger>
					<TabsTrigger value="components">Components</TabsTrigger>
					<TabsTrigger value="configs">Configs</TabsTrigger>
				</TabsList>

				<TabsContent className="space-y-4" value="apps">
					<Card>
						<CardHeader>
							<CardTitle>Dapr Apps</CardTitle>
							<CardDescription>
								Instances discovered through the live Dapr dashboard API.
							</CardDescription>
						</CardHeader>
						<CardContent>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>App</TableHead>
										<TableHead>Status</TableHead>
										<TableHead>Ports</TableHead>
										<TableHead>Replicas</TableHead>
										<TableHead>Config</TableHead>
										<TableHead>Created</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{overview.instances.map((instance) => (
										<TableRow
											className="cursor-pointer"
											key={getInstanceRowKey(instance)}
											onClick={() => setSelectedAppId(instance.appId)}
										>
											<TableCell>
												<div className="font-medium">{instance.appId}</div>
												<div className="text-muted-foreground text-xs">
													{instance.scope}
												</div>
											</TableCell>
											<TableCell>
												<StatusBadge value={instance.status} />
											</TableCell>
											<TableCell className="font-mono text-xs">
												app:{instance.appPort} http:{instance.httpPort} grpc:
												{instance.grpcPort}
											</TableCell>
											<TableCell>{instance.replicas}</TableCell>
											<TableCell>{instance.config || "-"}</TableCell>
											<TableCell>{instance.created}</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</CardContent>
					</Card>

					<Card>
						<CardHeader>
							<div className="flex items-center justify-between gap-3">
								<div>
									<CardTitle>Selected App Detail</CardTitle>
									<CardDescription>
										{selectedAppId} sidecar metadata and service introspection.
									</CardDescription>
								</div>
								{detailLoading ? (
									<Badge className="border-transparent bg-slate-500/10 text-slate-700">
										Loading
									</Badge>
								) : null}
							</div>
						</CardHeader>
						<CardContent className="space-y-4">
							{selectedApp ? (
								<>
									<div className="flex flex-wrap gap-2">
										<SourceBadge
											label="dashboard metadata"
											ok={selectedApp.sourceStatus.dashboard.ok}
										/>
										<SourceBadge
											label="service introspection"
											ok={selectedApp.sourceStatus.introspection.ok}
										/>
									</div>

									<div className="grid gap-4 md:grid-cols-2">
										<Card className="gap-4 py-4">
											<CardHeader className="pb-0">
												<CardTitle className="text-base">
													Sidecar Metadata
												</CardTitle>
											</CardHeader>
											<CardContent className="space-y-3">
												<div className="text-sm">
													Runtime version:{" "}
													<span className="font-medium">
														{selectedApp.metadata?.runtimeVersion || "-"}
													</span>
												</div>
												<div className="text-sm">
													Components:{" "}
													{selectedApp.metadata?.components.length || 0}
												</div>
												<div className="text-sm">
													Subscriptions:{" "}
													{selectedApp.metadata?.subscriptions.length || 0}
												</div>
												<div className="text-sm">
													Actors: {selectedApp.metadata?.actors.length || 0}
												</div>
												<pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs">
													{formatJson(selectedApp.metadata)}
												</pre>
											</CardContent>
										</Card>

										<Card className="gap-4 py-4">
											<CardHeader className="pb-0">
												<CardTitle className="text-base">
													Deployment Manifest
												</CardTitle>
											</CardHeader>
											<CardContent>
												<pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs">
													{selectedApp.instance?.manifest ||
														"No manifest available"}
												</pre>
											</CardContent>
										</Card>
									</div>

									{selectedApp.introspection ? (
										<IntrospectionCard
											introspection={selectedApp.introspection}
											sourceOk={selectedApp.sourceStatus.introspection.ok}
											title="Service Runtime"
										/>
									) : null}
								</>
							) : (
								<div className="text-muted-foreground text-sm">
									Select a Dapr app to inspect.
								</div>
							)}
						</CardContent>
					</Card>
				</TabsContent>

				<TabsContent className="space-y-4" value="runtime">
					<div className="grid gap-4 xl:grid-cols-2">
						<IntrospectionCard
							introspection={overview.workflowRuntime.orchestrator}
							sourceOk={overview.sources.workflowOrchestrator.ok}
							title="Workflow Orchestrator"
						/>
						<IntrospectionCard
							introspection={overview.workflowRuntime.durableAgent}
							sourceOk={overview.sources.durableAgent.ok}
							title="Durable Agent"
						/>
					</div>

					<Card>
						<CardHeader>
							<CardTitle>Recent Workflow Runs</CardTitle>
							<CardDescription>
								Latest instances from the orchestrator workflow management API.
							</CardDescription>
						</CardHeader>
						<CardContent>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Workflow</TableHead>
										<TableHead>Status</TableHead>
										<TableHead>Phase</TableHead>
										<TableHead>Progress</TableHead>
										<TableHead>Started</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{overview.workflowRuntime.recentRuns.map((run) => (
										<TableRow key={run.instanceId}>
											<TableCell>
												<div className="font-medium">
													{run.workflowNameVersioned ||
														run.workflowName ||
														run.workflowId}
												</div>
												<div className="font-mono text-muted-foreground text-xs">
													{run.instanceId}
												</div>
											</TableCell>
											<TableCell>
												<StatusBadge value={run.runtimeStatus} />
											</TableCell>
											<TableCell>{run.phase || "-"}</TableCell>
											<TableCell>{run.progress}%</TableCell>
											<TableCell>{formatRelative(run.startedAt)}</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
				</TabsContent>

				<TabsContent className="space-y-4" value="agents">
					<div className="grid gap-4 xl:grid-cols-2">
						<Card>
							<CardHeader>
								<div className="flex items-center justify-between gap-3">
									<div>
										<CardTitle>Application Agents</CardTitle>
										<CardDescription>
											Reusable agent configs stored in workflow-builder.
										</CardDescription>
									</div>
									<SourceBadge
										label="app database"
										ok={overview.sources.applicationAgents.ok}
									/>
								</div>
							</CardHeader>
							<CardContent>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Name</TableHead>
											<TableHead>Type</TableHead>
											<TableHead>Model</TableHead>
											<TableHead>Updated</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{overview.agents.application.map((agent) => (
											<TableRow key={agent.id}>
												<TableCell className="font-medium">
													{agent.name}
												</TableCell>
												<TableCell>{agent.agentType}</TableCell>
												<TableCell className="font-mono text-xs">
													{agent.model.provider}/{agent.model.name}
												</TableCell>
												<TableCell>{formatRelative(agent.updatedAt)}</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</CardContent>
						</Card>

						<Card>
							<CardHeader>
								<div className="flex items-center justify-between gap-3">
									<div>
										<CardTitle>Runtime Registry Agents</CardTitle>
										<CardDescription>
											Dapr runtime registry data reported by services.
										</CardDescription>
									</div>
									<SourceBadge
										label="runtime registry"
										ok={overview.agents.runtimeRegistry.length > 0}
									/>
								</div>
							</CardHeader>
							<CardContent>
								{overview.agents.runtimeRegistry.length === 0 ? (
									<div className="flex items-center gap-2 text-muted-foreground text-sm">
										<Bot className="size-4" />
										No runtime agent registrations are currently being
										published.
									</div>
								) : (
									<div className="space-y-3">
										{overview.agents.runtimeRegistry.map((entry) => (
											<div
												className="rounded-lg border p-3"
												key={`${entry.sourceApp}:${entry.name}`}
											>
												<div className="mb-2 flex items-center justify-between gap-3">
													<div className="font-medium">{entry.name}</div>
													<Badge className="border-transparent bg-slate-500/10 text-slate-700">
														{entry.sourceApp}
													</Badge>
												</div>
												<pre className="max-h-40 overflow-auto rounded-lg bg-muted p-3 text-xs">
													{formatJson(entry.metadata)}
												</pre>
											</div>
										))}
									</div>
								)}
							</CardContent>
						</Card>
					</div>
				</TabsContent>

				<TabsContent className="space-y-4" value="components">
					<Card>
						<CardHeader>
							<CardTitle>Dapr Components</CardTitle>
							<CardDescription>
								Components discovered through the dashboard in the
								`workflow-builder` namespace.
							</CardDescription>
						</CardHeader>
						<CardContent>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Name</TableHead>
										<TableHead>Type</TableHead>
										<TableHead>Scopes</TableHead>
										<TableHead>Age</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{overview.components.map((component) => (
										<TableRow key={component.name}>
											<TableCell className="font-medium">
												{component.name}
											</TableCell>
											<TableCell>{component.type}</TableCell>
											<TableCell>
												{component.scopes.join(", ") || "-"}
											</TableCell>
											<TableCell>{component.age}</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
				</TabsContent>

				<TabsContent className="space-y-4" value="configs">
					<Card>
						<CardHeader>
							<CardTitle>Dapr Configurations</CardTitle>
							<CardDescription>
								Configuration CRs exposed by the dashboard.
							</CardDescription>
						</CardHeader>
						<CardContent>
							{overview.configurations.length === 0 ? (
								<div className="text-muted-foreground text-sm">
									No configuration records returned by dashboard.
								</div>
							) : (
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Name</TableHead>
											<TableHead>Tracing</TableHead>
											<TableHead>Metrics</TableHead>
											<TableHead>mTLS</TableHead>
											<TableHead>Age</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{overview.configurations.map((config) => (
											<TableRow key={config.name}>
												<TableCell className="font-medium">
													{config.name}
												</TableCell>
												<TableCell>
													{config.tracingEnabled ? "on" : "off"}
												</TableCell>
												<TableCell>
													{config.metricsEnabled ? "on" : "off"}
												</TableCell>
												<TableCell>
													{config.mtlsEnabled ? "on" : "off"}
												</TableCell>
												<TableCell>{config.age}</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							)}
						</CardContent>
					</Card>
				</TabsContent>
			</Tabs>
		</div>
	);
}
