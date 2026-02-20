"use client";

import {
	Check,
	Copy,
	ExternalLink,
	Eye,
	EyeOff,
	RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { SettingsSubnav } from "@/components/settings/settings-subnav";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { api, type PopulatedMcpServer } from "@/lib/api-client";
import { useSession } from "@/lib/auth-client";
import { buildHostedMcpServerUrl } from "@/lib/mcp-gateway/url";

function maskToken(token: string): string {
	if (!token) {
		return "••••••••";
	}
	if (token.length <= 8) {
		return "••••••••";
	}
	return `••••••••${token.slice(-4)}`;
}

function CopyButton({ value }: { value: string }) {
	const [copied, setCopied] = useState(false);

	const onCopy = async () => {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			toast.error("Failed to copy");
		}
	};

	return (
		<Button onClick={onCopy} size="icon" type="button" variant="outline">
			{copied ? <Check className="size-4" /> : <Copy className="size-4" />}
		</Button>
	);
}

export default function McpSettingsPage() {
	const { data: session, isPending } = useSession();
	const projectId = session?.user.projectId;

	const [loading, setLoading] = useState(true);
	const [server, setServer] = useState<PopulatedMcpServer | null>(null);
	const [showToken, setShowToken] = useState(false);
	const [updating, setUpdating] = useState(false);
	const [rotating, setRotating] = useState(false);

	const serverUrl = useMemo(() => {
		if (!projectId) {
			return "";
		}
		const fallbackOrigin =
			typeof window !== "undefined" ? window.location.origin : "";
		return (
			buildHostedMcpServerUrl(projectId, { fallbackOrigin }) ??
			`${fallbackOrigin}/api/v1/projects/${projectId}/mcp-server/http`
		);
	}, [projectId]);

	const jsonConfig = useMemo(
		() => ({
			mcpServers: {
				"workflow-builder": {
					url: serverUrl,
					headers: {
						Authorization: `Bearer ${server?.token ?? ""}`,
					},
				},
			},
		}),
		[server?.token, serverUrl],
	);

	const load = useCallback(async () => {
		if (!projectId) {
			return;
		}
		try {
			setLoading(true);
			const data = await api.mcpServer.get(projectId);
			setServer(data);
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to load MCP settings",
			);
		} finally {
			setLoading(false);
		}
	}, [projectId]);

	useEffect(() => {
		if (!isPending && projectId) {
			load();
		}
	}, [isPending, projectId, load]);

	const setEnabled = async (enabled: boolean) => {
		if (!projectId) {
			return;
		}
		try {
			setUpdating(true);
			const updated = await api.mcpServer.update(projectId, {
				status: enabled ? "ENABLED" : "DISABLED",
			});
			setServer(updated);
			toast.success("MCP server updated");
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to update MCP server",
			);
		} finally {
			setUpdating(false);
		}
	};

	const rotate = async () => {
		if (!projectId) {
			return;
		}
		try {
			setRotating(true);
			const updated = await api.mcpServer.rotate(projectId);
			setServer(updated);
			toast.success("Token rotated");
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to rotate token",
			);
		} finally {
			setRotating(false);
		}
	};

	if (loading) {
		return (
			<div className="pointer-events-auto flex h-full flex-col bg-background">
				<div className="flex items-center gap-2 border-b px-6 py-4">
					<SidebarToggle />
					<div>
						<h1 className="font-semibold text-xl">MCP</h1>
						<p className="text-muted-foreground text-sm">
							Create and manage your hosted MCP server
						</p>
					</div>
				</div>
				<SettingsSubnav />
				<div className="p-6 text-muted-foreground text-sm">Loading…</div>
			</div>
		);
	}

	const enabled = server?.status === "ENABLED";

	return (
		<div className="pointer-events-auto flex h-full flex-col bg-background">
			<div className="flex items-center gap-2 border-b px-6 py-4">
				<SidebarToggle />
				<div>
					<h1 className="font-semibold text-xl">MCP</h1>
					<p className="text-muted-foreground text-sm">
						Allow external MCP clients to list and call your MCP tools securely.
					</p>
				</div>
			</div>
			<SettingsSubnav />

			<div className="flex-1 space-y-8 overflow-auto p-6">
				<div className="flex items-center justify-between rounded-md border p-4">
					<div>
						<div className="font-medium">Enable MCP Access</div>
						<div className="text-muted-foreground text-sm">
							This controls whether the hosted MCP endpoint accepts requests.
						</div>
					</div>
					<Switch
						checked={enabled}
						disabled={updating}
						onCheckedChange={setEnabled}
					/>
				</div>

				{enabled && server ? (
					<>
						<div className="space-y-3">
							<h2 className="font-semibold">Connection Details</h2>

							<div className="space-y-4 rounded-md border p-4">
								<div className="space-y-2">
									<div className="font-medium text-muted-foreground text-xs">
										Server URL
									</div>
									<div className="flex items-center gap-2">
										<div className="flex-1 overflow-x-auto rounded bg-muted px-3 py-2 font-mono text-xs">
											{serverUrl}
										</div>
										<CopyButton value={serverUrl} />
									</div>
								</div>

								<div className="space-y-2">
									<div className="font-medium text-muted-foreground text-xs">
										Token
									</div>
									<div className="flex items-center gap-2">
										<div className="flex-1 overflow-x-auto rounded bg-muted px-3 py-2 font-mono text-xs">
											{showToken ? server.token : maskToken(server.token)}
										</div>
										<Button
											onClick={() => setShowToken((v) => !v)}
											size="icon"
											type="button"
											variant="outline"
										>
											{showToken ? (
												<EyeOff className="size-4" />
											) : (
												<Eye className="size-4" />
											)}
										</Button>
										<Button
											disabled={rotating}
											onClick={rotate}
											size="icon"
											type="button"
											variant="outline"
										>
											<RefreshCw className="size-4" />
										</Button>
										<CopyButton value={server.token} />
									</div>
									<div className="text-muted-foreground text-xs">
										Use this token in the <code>Authorization: Bearer</code>{" "}
										header.
									</div>
								</div>

								<div className="space-y-2">
									<div className="font-medium text-muted-foreground text-xs">
										MCP Client Configuration (JSON)
									</div>
									<div className="relative">
										<pre className="max-h-56 overflow-auto rounded bg-muted p-3 font-mono text-xs">
											{JSON.stringify(jsonConfig, null, 2)}
										</pre>
										<div className="absolute top-2 right-2">
											<CopyButton value={JSON.stringify(jsonConfig, null, 2)} />
										</div>
									</div>
									<div className="text-muted-foreground text-xs">
										Copy this into your MCP client settings (Cursor, Claude
										Desktop, etc.).
									</div>
								</div>
							</div>
						</div>

						<div className="space-y-3">
							<h2 className="font-semibold">Available Flows</h2>
							<div className="text-muted-foreground text-sm">
								Workflows with the MCP trigger enabled will appear here.
							</div>

							{(server.flows?.length ?? 0) === 0 ? (
								<div className="text-muted-foreground text-sm">
									No MCP flows available.
								</div>
							) : (
								<div className="divide-y rounded-md border">
									{server.flows.map((flow) => (
										<div
											className="flex items-center justify-between p-3"
											key={flow.id}
										>
											<div className="min-w-0">
												<div className="truncate font-medium text-sm">
													{flow.name}
												</div>
												<div className="truncate text-muted-foreground text-xs">
													Tool: {flow.trigger.toolName}
												</div>
											</div>
											<div className="flex items-center gap-2">
												<div className="text-muted-foreground text-xs">
													{flow.enabled ? "On" : "Off"}
												</div>
												<Button
													onClick={() =>
														window.open(
															`/workflows/${flow.id}`,
															"_blank",
															"noopener,noreferrer",
														)
													}
													size="icon"
													type="button"
													variant="outline"
												>
													<ExternalLink className="size-4" />
												</Button>
											</div>
										</div>
									))}
								</div>
							)}
						</div>
					</>
				) : (
					<div className="text-muted-foreground text-sm">
						Enable MCP access to view connection details and available tools.
					</div>
				)}
			</div>
		</div>
	);
}
