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
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		async function fetchSandbox() {
			try {
				const response = await api.workflow.getExecutionSandbox(workflowId, executionId);
				if (response.error) {
					setError(response.error);
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

	if (!podIp) {
		return <div className="p-4 text-sm text-muted-foreground">Waiting for sandbox allocation...</div>;
	}

	if (templateName === "aio-browser") {
		const vncUrl = `/api/sandbox-aio/${podIp}/vnc/index.html?autoconnect=true`;

		return (
			<Tabs defaultValue="vnc" className="h-[calc(100vh-12rem)] min-h-[600px] flex flex-col">
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
