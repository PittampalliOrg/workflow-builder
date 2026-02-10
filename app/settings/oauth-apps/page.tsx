"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Lock, LockOpen, Trash2, Copy, Check } from "lucide-react";
import { toast } from "sonner";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogFooter,
	DialogDescription,
} from "@/components/ui/dialog";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
	api,
	type OAuthAppSummary,
	type PieceMetadataSummary,
} from "@/lib/api-client";
import { parsePieceAuthAll, PieceAuthType } from "@/lib/types/piece-auth";

type OAuthPieceRow = {
	piece: PieceMetadataSummary;
	oauthApp: OAuthAppSummary | null;
};

export default function OAuthAppsSettingsPage() {
	const [pieces, setPieces] = useState<PieceMetadataSummary[]>([]);
	const [oauthApps, setOauthApps] = useState<OAuthAppSummary[]>([]);
	const [loading, setLoading] = useState(true);

	// Configure dialog
	const [configPiece, setConfigPiece] = useState<PieceMetadataSummary | null>(
		null,
	);
	const [clientId, setClientId] = useState("");
	const [clientSecret, setClientSecret] = useState("");
	const [saving, setSaving] = useState(false);

	// Redirect URI copy state
	const [copied, setCopied] = useState(false);

	const redirectUri =
		typeof window !== "undefined" ? `${window.location.origin}/redirect` : "";

	const fetchData = useCallback(async () => {
		try {
			setLoading(true);
			const [piecesResult, appsResult] = await Promise.all([
				api.piece.list(),
				api.oauthApp.list(),
			]);
			setPieces(piecesResult);
			setOauthApps(appsResult);
		} catch {
			toast.error("Failed to load data");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchData();
	}, [fetchData]);

	// Filter pieces that have OAuth2 auth
	const oauthPieceRows: OAuthPieceRow[] = useMemo(() => {
		return pieces
			.filter((p) => {
				if (!p.auth) return false;
				const configs = parsePieceAuthAll(p.auth);
				return configs.some((c) => c.type === PieceAuthType.OAUTH2);
			})
			.map((piece) => ({
				piece,
				oauthApp: oauthApps.find((a) => a.pieceName === piece.name) ?? null,
			}))
			.sort((a, b) => {
				// Configured first, then alphabetical
				if (a.oauthApp && !b.oauthApp) return -1;
				if (!a.oauthApp && b.oauthApp) return 1;
				return a.piece.displayName.localeCompare(b.piece.displayName);
			});
	}, [pieces, oauthApps]);

	const handleConfigure = (piece: PieceMetadataSummary) => {
		const existing = oauthApps.find((a) => a.pieceName === piece.name);
		setConfigPiece(piece);
		setClientId(existing?.clientId ?? "");
		setClientSecret("");
	};

	const handleSave = async () => {
		if (!configPiece) return;
		if (!clientId.trim() || !clientSecret.trim()) {
			toast.error("Both Client ID and Client Secret are required");
			return;
		}
		try {
			setSaving(true);
			await api.oauthApp.upsert({
				pieceName: configPiece.name,
				clientId: clientId.trim(),
				clientSecret: clientSecret.trim(),
			});
			toast.success(`OAuth app configured for ${configPiece.displayName}`);
			setConfigPiece(null);
			fetchData();
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to save OAuth app",
			);
		} finally {
			setSaving(false);
		}
	};

	const handleRemove = async (pieceName: string, displayName: string) => {
		try {
			await api.oauthApp.delete(pieceName);
			toast.success(`OAuth app removed for ${displayName}`);
			fetchData();
		} catch {
			toast.error("Failed to remove OAuth app");
		}
	};

	const handleCopyRedirectUri = async () => {
		try {
			await navigator.clipboard.writeText(redirectUri);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			toast.error("Failed to copy");
		}
	};

	return (
		<div className="pointer-events-auto flex h-full flex-col bg-background">
			<div className="flex items-center gap-2 border-b px-6 py-4">
				<SidebarToggle />
				<div>
					<h1 className="text-xl font-semibold">OAuth Apps</h1>
					<p className="text-sm text-muted-foreground">
						Configure platform OAuth credentials for pieces
					</p>
				</div>
			</div>

			<div className="flex-1 overflow-auto p-6">
				{/* Redirect URI helper */}
				<div className="mb-6 rounded-md border bg-muted/30 p-4">
					<Label className="text-sm font-medium">Redirect URI</Label>
					<p className="mb-2 text-xs text-muted-foreground">
						Use this as the redirect/callback URI when registering OAuth apps
						with providers.
					</p>
					<div className="flex items-center gap-2">
						<code className="flex-1 rounded bg-muted px-3 py-1.5 text-xs font-mono">
							{redirectUri}
						</code>
						<Button onClick={handleCopyRedirectUri} size="sm" variant="outline">
							{copied ? (
								<Check className="size-4" />
							) : (
								<Copy className="size-4" />
							)}
						</Button>
					</div>
				</div>

				{loading ? (
					<div className="flex items-center justify-center py-12">
						<Loader2 className="size-6 animate-spin text-muted-foreground" />
					</div>
				) : oauthPieceRows.length === 0 ? (
					<p className="py-12 text-center text-muted-foreground text-sm">
						No OAuth2 pieces found. Sync piece metadata first.
					</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Piece</TableHead>
								<TableHead>Client ID</TableHead>
								<TableHead>Status</TableHead>
								<TableHead className="text-right">Actions</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{oauthPieceRows.map(({ piece, oauthApp }) => (
								<TableRow key={piece.name}>
									<TableCell>
										<div className="flex items-center gap-2">
											{piece.logoUrl ? (
												<img
													alt=""
													className="size-6 rounded"
													src={piece.logoUrl}
												/>
											) : (
												<div className="flex size-6 items-center justify-center rounded bg-muted text-xs font-medium">
													{piece.displayName.charAt(0)}
												</div>
											)}
											<span className="font-medium text-sm">
												{piece.displayName}
											</span>
										</div>
									</TableCell>
									<TableCell className="font-mono text-xs text-muted-foreground">
										{oauthApp ? oauthApp.clientId : "—"}
									</TableCell>
									<TableCell>
										{oauthApp ? (
											<Badge variant="default" className="gap-1">
												<Lock className="size-3" />
												Configured
											</Badge>
										) : (
											<Badge variant="secondary" className="gap-1">
												<LockOpen className="size-3" />
												Not configured
											</Badge>
										)}
									</TableCell>
									<TableCell className="text-right">
										<div className="flex items-center justify-end gap-1">
											<Button
												onClick={() => handleConfigure(piece)}
												size="sm"
												variant="outline"
											>
												{oauthApp ? "Update" : "Configure"}
											</Button>
											{oauthApp && (
												<Button
													onClick={() =>
														handleRemove(piece.name, piece.displayName)
													}
													size="sm"
													variant="ghost"
													className="text-destructive hover:text-destructive"
												>
													<Trash2 className="size-4" />
												</Button>
											)}
										</div>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</div>

			{/* Configure Dialog */}
			<Dialog
				open={!!configPiece}
				onOpenChange={(open) => !open && setConfigPiece(null)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							{configPiece?.logoUrl && (
								<img
									alt=""
									className="size-5 rounded"
									src={configPiece.logoUrl}
								/>
							)}
							Configure {configPiece?.displayName}
						</DialogTitle>
						<DialogDescription>
							Enter the OAuth2 credentials from your app registration with the
							provider.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4 py-2">
						<div className="space-y-2">
							<Label htmlFor="oauth-client-id">Client ID</Label>
							<Input
								disabled={saving}
								id="oauth-client-id"
								onChange={(e) => setClientId(e.target.value)}
								placeholder="Your OAuth2 Client ID"
								value={clientId}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="oauth-client-secret">Client Secret</Label>
							<Input
								disabled={saving}
								id="oauth-client-secret"
								onChange={(e) => setClientSecret(e.target.value)}
								placeholder="Your OAuth2 Client Secret"
								type="password"
								value={clientSecret}
							/>
						</div>
					</div>
					<DialogFooter>
						<Button
							disabled={saving}
							onClick={() => setConfigPiece(null)}
							variant="outline"
						>
							Cancel
						</Button>
						<Button disabled={saving} onClick={handleSave}>
							{saving && <Loader2 className="mr-2 size-4 animate-spin" />}
							Save
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
