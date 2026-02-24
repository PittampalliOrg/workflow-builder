"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { Card, CardContent } from "@/components/ui/card";

export function RunSandboxTab({
	workflowId,
	executionId,
}: {
	workflowId: string;
	executionId: string;
}) {
	const [podIp, setPodIp] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		async function fetchSandbox() {
			try {
				const response = await api.workflow.getExecutionSandbox(workflowId, executionId);
				if (response.error) {
					setError(response.error);
				} else if (response.podIp) {
					setPodIp(response.podIp);
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

	const vncUrl = `/api/sandbox-vnc/${podIp}/vnc.html?autoconnect=true&resize=remote`;

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