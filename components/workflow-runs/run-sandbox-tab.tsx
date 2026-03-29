"use client";

import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";

export function RunSandboxTab({
	workflowId,
	executionId,
}: {
	workflowId: string;
	executionId: string;
}) {
	const [templateName, setTemplateName] = useState<string>("openshell");
	const [actionType, setActionType] = useState<string | null>(null);
	const [sandboxName, setSandboxName] = useState<string | null>(null);
	const [repoPath, setRepoPath] = useState<string | null>(null);
	const [agentRunId, setAgentRunId] = useState<string | null>(null);
	const [sandboxStatus, setSandboxStatus] = useState<string | null>(null);
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [resumeCommand, setResumeCommand] = useState<string | null>(null);
	const [initialPrompt, setInitialPrompt] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const copyValue = async (label: string, value: string | null) => {
		if (!value) {
			toast.error(`${label} unavailable`);
			return;
		}
		try {
			await navigator.clipboard.writeText(value);
			toast.success(`${label} copied`);
		} catch {
			toast.error(`Failed to copy ${label.toLowerCase()}`);
		}
	};

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
					setActionType(response.actionType ?? null);
					setSandboxName(response.sandboxName);
					setRepoPath(response.repoPath ?? null);
					setAgentRunId(response.agentRunId ?? null);
					setSandboxStatus(response.status ?? null);
					setSessionId(response.sessionId ?? null);
					setResumeCommand(response.resumeCommand ?? null);
					setInitialPrompt(response.initialPrompt ?? null);
				} else if (response.templateName) {
					setTemplateName(response.templateName);
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
		const isSessionStart = actionType === "openshell/session-start";
		return (
			<Card>
				<CardContent className="space-y-4 p-4">
					<div>
						<div className="font-medium text-sm">
							{isSessionStart
								? "OpenShell Claude Session"
								: "OpenShell Sandbox"}
						</div>
						<p className="mt-1 text-muted-foreground text-sm">
							{isSessionStart
								? "This execution initialized a resumable Claude session inside an OpenShell sandbox."
								: "This execution ran in an OpenShell sandbox. OpenShell review is metadata-first here rather than VNC-based."}
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
						{isSessionStart && (
							<div className="rounded-md border bg-muted/20 p-3">
								<div className="text-muted-foreground text-xs uppercase tracking-wide">
									Claude Session
								</div>
								<div className="mt-1 break-all font-mono text-sm">
									{sessionId ?? "Unavailable"}
								</div>
							</div>
						)}
						{isSessionStart && (
							<div className="rounded-md border bg-muted/20 p-3">
								<div className="text-muted-foreground text-xs uppercase tracking-wide">
									Resume Command
								</div>
								<div className="mt-1 break-all font-mono text-sm">
									{resumeCommand ?? "Unavailable"}
								</div>
							</div>
						)}
					</div>

					{isSessionStart && initialPrompt && (
						<div className="rounded-md border bg-muted/20 p-3">
							<div className="text-muted-foreground text-xs uppercase tracking-wide">
								Initial Prompt
							</div>
							<pre className="mt-2 whitespace-pre-wrap break-words font-mono text-sm">
								{initialPrompt}
							</pre>
						</div>
					)}

					{isSessionStart && (
						<div className="flex flex-wrap gap-2">
							<Button
								onClick={() => copyValue("Sandbox name", sandboxName)}
								size="sm"
								variant="outline"
							>
								<Copy className="mr-2 size-3.5" />
								Copy sandbox
							</Button>
							<Button
								onClick={() => copyValue("Claude session", sessionId)}
								size="sm"
								variant="outline"
							>
								<Copy className="mr-2 size-3.5" />
								Copy session
							</Button>
							<Button
								onClick={() => copyValue("Resume command", resumeCommand)}
								size="sm"
								variant="outline"
							>
								<Copy className="mr-2 size-3.5" />
								Copy resume command
							</Button>
						</div>
					)}

					<div className="rounded-md border border-sky-500/30 bg-sky-500/10 p-3 text-sky-800 text-sm dark:text-sky-300">
						{isSessionStart ? (
							<>
								Use the <span className="font-medium">Activities</span> and{" "}
								<span className="font-medium">Child Runs</span> tabs for launch
								details. This workflow hands off a persistent Claude session
								rather than rendering a browser or VNC sandbox.
							</>
						) : (
							<>
								Use the <span className="font-medium">Activities</span>,{" "}
								<span className="font-medium">Child Runs</span>,{" "}
								<span className="font-medium">Artifacts</span>, and{" "}
								<span className="font-medium">Changes</span> tabs for in-app
								review. The OpenShell runtime does not expose the legacy VNC
								sandbox view used by the workspace runtime.
							</>
						)}
					</div>
				</CardContent>
			</Card>
		);
	}

	return (
		<Card>
			<CardContent className="p-4 text-muted-foreground text-sm">
				This execution did not expose a live OpenShell sandbox handoff. Review
				the <span className="font-medium">Activities</span>,{" "}
				<span className="font-medium">Artifacts</span>, and{" "}
				<span className="font-medium">Changes</span> tabs for the recorded
				result.
			</CardContent>
		</Card>
	);
}
