"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BrowserScreenshotView } from "./browser-screenshot-view";

export function RunSandboxTab({
	workflowId,
	executionId,
}: {
	workflowId: string;
	executionId: string;
}) {
	const [podIp, setPodIp] = useState<string | null>(null);
	const [templateName, setTemplateName] = useState<string>("dapr-agent");
	const [sandboxName, setSandboxName] = useState<string | null>(null);
	const [repoPath, setRepoPath] = useState<string | null>(null);
	const [agentRunId, setAgentRunId] = useState<string | null>(null);
	const [sandboxStatus, setSandboxStatus] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		async function fetchSandbox() {
			try {
				const response = await api.workflow.getExecutionSandbox(
					workflowId,
					executionId,
				);
				if (response.error) {
					setError(response.error);
				} else if (
					response.templateName === "openshell" &&
					response.sandboxName
				) {
					setTemplateName("openshell");
					setSandboxName(response.sandboxName);
					setRepoPath(response.repoPath ?? null);
					setAgentRunId(response.agentRunId ?? null);
					setSandboxStatus(response.status ?? null);
				} else if (response.podIp) {
					setPodIp(response.podIp);
					if (response.templateName) {
						setTemplateName(response.templateName);
					}
				}
			} catch (err: any) {
				setError(err.message || "Failed to load sandbox");
			}
		}
		fetchSandbox();
	}, [workflowId, executionId]);

	if (error) {
		return <div className="p-4 text-sm text-destructive">{error}</div>;
	}

	if (templateName === "openshell" && sandboxName) {
		return (
			<Card>
				<CardContent className="space-y-4 p-4">
					<div>
						<div className="font-medium text-sm">OpenShell Sandbox</div>
						<p className="mt-1 text-muted-foreground text-sm">
							This execution ran in an OpenShell sandbox. OpenShell review is
							metadata-first here rather than VNC-based.
						</p>
					</div>

					<div className="grid gap-3 md:grid-cols-2">
						<div className="rounded-md border bg-muted/20 p-3">
							<div className="text-muted-foreground text-xs uppercase tracking-wide">
								Sandbox
							</div>
							<div className="mt-1 break-all font-mono text-sm">
								{sandboxName}
							</div>
						</div>
						<div className="rounded-md border bg-muted/20 p-3">
							<div className="text-muted-foreground text-xs uppercase tracking-wide">
								Status
							</div>
							<div className="mt-1 text-sm">{sandboxStatus ?? "unknown"}</div>
						</div>
						<div className="rounded-md border bg-muted/20 p-3">
							<div className="text-muted-foreground text-xs uppercase tracking-wide">
								Repository Path
							</div>
							<div className="mt-1 break-all font-mono text-sm">
								{repoPath ?? "Unavailable"}
							</div>
						</div>
						<div className="rounded-md border bg-muted/20 p-3">
							<div className="text-muted-foreground text-xs uppercase tracking-wide">
								Agent Run
							</div>
							<div className="mt-1 break-all font-mono text-sm">
								{agentRunId ?? "Unavailable"}
							</div>
						</div>
					</div>

					<div className="rounded-md border border-sky-500/30 bg-sky-500/10 p-3 text-sky-800 text-sm dark:text-sky-300">
						Use the <span className="font-medium">Activities</span>,{" "}
						<span className="font-medium">Child Runs</span>,{" "}
						<span className="font-medium">Artifacts</span>, and{" "}
						<span className="font-medium">Changes</span> tabs for in-app review.
						The OpenShell runtime does not expose the legacy VNC sandbox view
						used by the workspace runtime.
					</div>
				</CardContent>
			</Card>
		);
	}

	if (!podIp) {
		return (
			<div className="p-4 text-sm text-muted-foreground">
				Waiting for sandbox allocation...
			</div>
		);
	}

	if (templateName === "aio-browser") {
		const vncUrl = `/api/sandbox-aio/${podIp}/vnc/index.html?autoconnect=true&resize=remote&path=api/sandbox-aio/${podIp}/websockify`;

		return (
			<Tabs
				defaultValue="vnc"
				className="h-[calc(100vh-12rem)] min-h-[600px] flex flex-col"
			>
				<TabsList className="mx-4 mt-2 w-fit">
					<TabsTrigger value="vnc">VNC Desktop</TabsTrigger>
					<TabsTrigger value="screenshot">Browser Screenshot</TabsTrigger>
				</TabsList>
				<TabsContent value="vnc" className="flex-1 overflow-hidden m-0">
					<Card className="h-full overflow-hidden border-0 rounded-none">
						<CardContent className="h-full p-0">
							<iframe
								src={vncUrl}
								className="h-full w-full border-0"
								title="AIO Sandbox VNC"
							/>
						</CardContent>
					</Card>
				</TabsContent>
				<TabsContent value="screenshot" className="flex-1 overflow-hidden m-0">
					<BrowserScreenshotView podIp={podIp} />
				</TabsContent>
			</Tabs>
		);
	}

	// Default: dapr-agent template (existing behavior)
	const vncUrl = `/api/sandbox-vnc/${podIp}/vnc.html?autoconnect=true&resize=remote&path=api/sandbox-vnc/${podIp}/websockify`;

	return (
		<Card className="h-[calc(100vh-12rem)] min-h-[600px] overflow-hidden">
			<CardContent className="h-full p-0">
				<iframe
					src={vncUrl}
					className="h-full w-full border-0"
					title="Sandbox VNC"
				/>
			</CardContent>
		</Card>
	);
}
