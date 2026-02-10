"use client";

import { formatDistanceToNow } from "date-fns";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
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
import { IntegrationIcon } from "@/components/ui/integration-icon";
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
import { AddConnectionOverlay } from "@/components/overlays/add-connection-overlay";
import { RenameConnectionDialog } from "@/components/connections/rename-connection-dialog";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { type AppConnection, api } from "@/lib/api-client";
import {
	clearOAuth2Pending,
	clearOAuth2Result,
	loadOAuth2Pending,
	loadOAuth2Result,
} from "@/lib/app-connections/oauth2-resume-client";
import { AppConnectionType } from "@/lib/types/app-connection";

function getStatusBadge(status: string) {
	switch (status) {
		case "ACTIVE":
			return (
				<Badge className="border-transparent bg-emerald-500/10 text-emerald-600">
					Active
				</Badge>
			);
		case "ERROR":
			return <Badge variant="destructive">Error</Badge>;
		default:
			return <Badge variant="secondary">Missing</Badge>;
	}
}

function isOAuth2Connection(conn: AppConnection): boolean {
	return (
		conn.type === AppConnectionType.OAUTH2 ||
		conn.type === AppConnectionType.PLATFORM_OAUTH2
	);
}

function getPieceDisplayName(pieceName: string): string {
	return pieceName
		.replace("@activepieces/piece-", "")
		.split("-")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

export default function ConnectionsPage() {
	const { open } = useOverlay();
	const [connections, setConnections] = useState<AppConnection[]>([]);
	const [loading, setLoading] = useState(true);
	const [deleteTarget, setDeleteTarget] = useState<AppConnection | null>(null);
	const [deleting, setDeleting] = useState(false);
	const [renameTarget, setRenameTarget] = useState<AppConnection | null>(null);
	// Map of pieceName (full or short) → logoUrl for IntegrationIcon
	const [pieceLogos, setPieceLogos] = useState<Map<string, string>>(new Map());

	const fetchConnections = useCallback(async () => {
		try {
			const result = await api.appConnection.list();
			setConnections(result.data);
		} catch (error) {
			console.error("Failed to fetch connections:", error);
			toast.error("Failed to load connections");
		} finally {
			setLoading(false);
		}
	}, []);

	// Fetch piece metadata for logo URLs
	useEffect(() => {
		api.piece
			.list()
			.then((pieces) => {
				const map = new Map<string, string>();
				for (const p of pieces) {
					if (p.logoUrl) {
						map.set(p.name, p.logoUrl);
						// Also map the short name
						const short = p.name.replace(/^@activepieces\/piece-/, "");
						map.set(short, p.logoUrl);
					}
				}
				setPieceLogos(map);
			})
			.catch(() => {});
	}, []);

	useEffect(() => {
		fetchConnections();
	}, [fetchConnections]);

	// Same-tab OAuth2 fallback: when popups are blocked, we navigate the current tab
	// to the provider and then return to /connections to finish creating the connection.
	useEffect(() => {
		if (typeof window === "undefined") return;

		const url = new URL(window.location.href);
		const resume = url.searchParams.get("oauth2_resume");
		const state = url.searchParams.get("state");
		if (resume !== "1" || !state) return;

		// Remove query params immediately to avoid re-processing on refresh.
		url.searchParams.delete("oauth2_resume");
		url.searchParams.delete("state");
		const nextUrl = `${url.pathname}${url.searchParams.toString() ? `?${url.searchParams.toString()}` : ""}`;
		window.history.replaceState(null, "", nextUrl);

		const pending = loadOAuth2Pending(state);
		const result = loadOAuth2Result(state);

		// Always clear stored state to avoid stale retries.
		clearOAuth2Pending(state);
		clearOAuth2Result(state);

		if (!pending || !result) {
			toast.error(
				"Authorization could not be resumed. Please try connecting again.",
				{
					description: `Missing ${!pending ? "pending state" : "callback"} data.`,
				},
			);
			return;
		}

		if ("error" in result) {
			toast.error(`OAuth2 failed: ${result.errorDescription || result.error}`);
			return;
		}

		if (!result.code) {
			toast.error("OAuth2 callback missing code. Please try again.");
			return;
		}

		void (async () => {
			try {
				const code = decodeURIComponent(result.code);
				await api.appConnection.upsert({
					externalId: pending.displayName
						.toLowerCase()
						.replace(/[^a-z0-9]+/g, "-"),
					displayName: pending.displayName,
					pieceName: pending.pieceName,
					projectId: "default",
					type: AppConnectionType.PLATFORM_OAUTH2,
					value: {
						type: AppConnectionType.PLATFORM_OAUTH2,
						client_id: pending.clientId,
						redirect_url: pending.redirectUrl,
						code,
						scope: pending.scope,
						code_verifier: pending.codeVerifier || undefined,
						props: pending.props,
						authorization_method: pending.authorizationMethod,
					},
				});
				toast.success("Connection created via OAuth2");
				await fetchConnections();
			} catch (error) {
				console.error("Failed to resume OAuth2 connection:", error);
				toast.error(
					error instanceof Error
						? error.message
						: "Failed to create connection",
				);
			}
		})();
	}, [fetchConnections]);

	const handleAddConnection = () => {
		open(AddConnectionOverlay, {
			onSuccess: () => {
				fetchConnections();
			},
		});
	};

	const handleReconnect = (conn: AppConnection) => {
		open(AddConnectionOverlay, {
			preselectedPieceName: conn.pieceName,
			onSuccess: () => {
				fetchConnections();
			},
		});
	};

	const handleDelete = async () => {
		if (!deleteTarget) return;
		try {
			setDeleting(true);
			await api.appConnection.delete(deleteTarget.id);
			toast.success("Connection deleted");
			setDeleteTarget(null);
			fetchConnections();
		} catch (error) {
			console.error("Failed to delete connection:", error);
			toast.error("Failed to delete connection");
		} finally {
			setDeleting(false);
		}
	};

	const handleRenameSuccess = () => {
		setRenameTarget(null);
		fetchConnections();
	};

	return (
		<div className="pointer-events-auto mx-auto max-w-5xl p-6">
			<div className="mb-6 flex items-center justify-between">
				<div>
					<h1 className="font-semibold text-2xl">Connections</h1>
					<p className="text-muted-foreground text-sm">
						Manage your app connections and credentials
					</p>
				</div>
				<Button onClick={handleAddConnection}>
					<Plus className="mr-2 size-4" />
					New Connection
				</Button>
			</div>

			{loading ? (
				<div className="py-12 text-center text-muted-foreground text-sm">
					Loading connections...
				</div>
			) : connections.length === 0 ? (
				<div className="py-12 text-center">
					<p className="text-muted-foreground text-sm">
						No connections yet. Add one to get started.
					</p>
				</div>
			) : (
				<div className="rounded-md border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>App</TableHead>
								<TableHead>Name</TableHead>
								<TableHead>Status</TableHead>
								<TableHead>Updated</TableHead>
								<TableHead className="w-[120px]" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{connections.map((conn) => (
								<TableRow key={conn.id}>
									<TableCell>
										<div className="flex items-center gap-2">
											<IntegrationIcon
												className="size-5 shrink-0"
												integration={conn.pieceName}
												logoUrl={pieceLogos.get(conn.pieceName)}
											/>
											<span className="text-sm">
												{getPieceDisplayName(conn.pieceName)}
											</span>
										</div>
									</TableCell>
									<TableCell className="font-medium">
										{conn.displayName}
									</TableCell>
									<TableCell>{getStatusBadge(conn.status)}</TableCell>
									<TableCell className="text-muted-foreground text-sm">
										{conn.updatedAt
											? formatDistanceToNow(new Date(conn.updatedAt), {
													addSuffix: true,
												})
											: "—"}
									</TableCell>
									<TableCell>
										<TooltipProvider delayDuration={300}>
											<div className="flex items-center gap-1">
												<Tooltip>
													<TooltipTrigger asChild>
														<Button
															onClick={() => setRenameTarget(conn)}
															size="icon"
															variant="ghost"
														>
															<Pencil className="size-4" />
														</Button>
													</TooltipTrigger>
													<TooltipContent>Rename</TooltipContent>
												</Tooltip>

												{isOAuth2Connection(conn) && (
													<Tooltip>
														<TooltipTrigger asChild>
															<Button
																onClick={() => handleReconnect(conn)}
																size="icon"
																variant="ghost"
															>
																<RefreshCw className="size-4" />
															</Button>
														</TooltipTrigger>
														<TooltipContent>Reconnect</TooltipContent>
													</Tooltip>
												)}

												<Tooltip>
													<TooltipTrigger asChild>
														<Button
															className="text-destructive hover:text-destructive"
															onClick={() => setDeleteTarget(conn)}
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

			<AlertDialog
				onOpenChange={(open) => !open && setDeleteTarget(null)}
				open={!!deleteTarget}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete Connection</AlertDialogTitle>
						<AlertDialogDescription>
							Are you sure you want to delete{" "}
							<strong>{deleteTarget?.displayName}</strong>? Any flows currently
							using this connection <strong>will break immediately</strong>.
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

			{renameTarget && (
				<RenameConnectionDialog
					connectionId={renameTarget.id}
					currentName={renameTarget.displayName}
					onOpenChange={(open) => !open && setRenameTarget(null)}
					onSuccess={handleRenameSuccess}
					open={!!renameTarget}
				/>
			)}
		</div>
	);
}
