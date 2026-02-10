"use client";

import { ExternalLink, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { IntegrationIcon } from "@/components/ui/integration-icon";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useIsMobile } from "@/hooks/use-mobile";
import {
	api,
	type OAuthAppSummary,
	type PieceMetadataSummary,
} from "@/lib/api-client";
import {
	AppConnectionType,
	type UpsertAppConnectionRequestBody,
} from "@/lib/types/app-connection";
import {
	type PieceAuthConfig,
	type PieceAuthProperty,
	PieceAuthType,
	PiecePropertyType,
	parsePieceAuthAll,
} from "@/lib/types/piece-auth";
import { ConfirmOverlay } from "./confirm-overlay";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";

/**
 * Renders piece auth setup instructions from markdown description.
 * Safely parses basic markdown (bold, links, numbered lists) into React elements.
 */
function AuthSetupInstructions({ description }: { description: string }) {
	const lines = description.split("\n").filter((l) => l.trim());

	return (
		<details className="rounded-md border bg-muted/30 text-sm">
			<summary className="cursor-pointer px-3 py-2 font-medium text-muted-foreground hover:text-foreground">
				Setup instructions
			</summary>
			<div className="space-y-1 border-t px-3 py-2">
				{lines.map((line, i) => (
					<MarkdownLine key={i} text={line.trim()} />
				))}
			</div>
		</details>
	);
}

/** Parse a single line of simple markdown into React elements */
function MarkdownLine({ text }: { text: string }) {
	// Split text into segments: plain text, **bold**, and [link](url)
	const parts: React.ReactNode[] = [];
	const regex = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = regex.exec(text)) !== null) {
		// Text before this match
		if (match.index > lastIndex) {
			parts.push(text.slice(lastIndex, match.index));
		}
		if (match[1]) {
			// Bold
			parts.push(
				<strong className="font-semibold text-foreground" key={match.index}>
					{match[1]}
				</strong>,
			);
		} else if (match[2] && match[3]) {
			// Link
			parts.push(
				<a
					className="text-primary underline"
					href={match[3]}
					key={match.index}
					rel="noopener noreferrer"
					target="_blank"
				>
					{match[2]}
				</a>,
			);
		}
		lastIndex = match.index + match[0].length;
	}
	if (lastIndex < text.length) {
		parts.push(text.slice(lastIndex));
	}

	return (
		<p className="my-0.5 text-muted-foreground text-xs leading-relaxed">
			{parts}
		</p>
	);
}

type AddConnectionOverlayProps = {
	overlayId: string;
	onSuccess?: (connectionId: string, externalId?: string) => void;
	preselectedPieceName?: string;
};

/**
 * Overlay for selecting a connection type to add
 */
export function AddConnectionOverlay({
	overlayId,
	onSuccess,
	preselectedPieceName,
}: AddConnectionOverlayProps) {
	const { push } = useOverlay();
	const [searchQuery, setSearchQuery] = useState("");
	const isMobile = useIsMobile();

	const [pieces, setPieces] = useState<PieceMetadataSummary[]>([]);
	const [loadingPieces, setLoadingPieces] = useState(true);
	const pushedPreselectedRef = useRef(false);

	useEffect(() => {
		let cancelled = false;
		const trimmed = searchQuery.trim();
		const limit = trimmed ? 200 : 50;

		setLoadingPieces(true);

		const timer = setTimeout(() => {
			api.piece
				.list({ searchQuery: trimmed || undefined, limit })
				.then((result) => {
					if (cancelled) return;
					setPieces(result);
				})
				.catch((error) => {
					if (cancelled) return;
					console.error("Failed to load pieces:", error);
					toast.error("Failed to load integrations");
					setPieces([]);
				})
				.finally(() => {
					if (!cancelled) setLoadingPieces(false);
				});
		}, 200);

		return () => {
			clearTimeout(timer);
			cancelled = true;
		};
	}, [searchQuery]);

	useEffect(() => {
		if (!preselectedPieceName) return;
		if (pushedPreselectedRef.current) return;
		pushedPreselectedRef.current = true;

		// Fetch directly instead of relying on the list query.
		api.piece
			.get(preselectedPieceName)
			.then((piece) => {
				if (piece) {
					push(ConfigureConnectionOverlay, { piece, onSuccess });
				} else {
					toast.error("Integration not found");
				}
			})
			.catch(() => {
				toast.error("Failed to load integration");
			});
	}, [onSuccess, preselectedPieceName, push]);

	const handleSelectPiece = (piece: PieceMetadataSummary) => {
		push(ConfigureConnectionOverlay, { piece, onSuccess });
	};

	return (
		<Overlay overlayId={overlayId} title="Add Connection">
			<p className="-mt-2 mb-4 text-muted-foreground text-sm">
				Select a service to connect
			</p>

			<div className="space-y-3">
				<div className="relative">
					<Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						autoFocus={!isMobile}
						className="pl-9"
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder="Search services..."
						value={searchQuery}
					/>
				</div>
				{!searchQuery.trim() && (
					<p className="text-muted-foreground text-xs">
						Showing a limited list. Search to find any integration.
					</p>
				)}
				<div className="max-h-[300px] space-y-1 overflow-y-auto">
					{loadingPieces ? (
						<p className="py-4 text-center text-muted-foreground text-sm">
							Loading services...
						</p>
					) : pieces.length === 0 ? (
						<p className="py-4 text-center text-muted-foreground text-sm">
							No services found
						</p>
					) : (
						pieces.map((piece) => {
							const description = piece.description ?? "";
							return (
								<button
									className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50"
									key={piece.id}
									onClick={() => handleSelectPiece(piece)}
									type="button"
								>
									<IntegrationIcon
										className="size-5 shrink-0"
										integration={piece.name}
										logoUrl={piece.logoUrl}
									/>
									<span className="min-w-0 flex-1 truncate">
										<span className="font-medium">{piece.displayName}</span>
										{description && (
											<span className="text-muted-foreground text-xs">
												{" "}
												- {description}
											</span>
										)}
									</span>
								</button>
							);
						})
					)}
				</div>
			</div>
		</Overlay>
	);
}

type ConfigureConnectionOverlayProps = {
	overlayId: string;
	/** Preferred: pass the selected piece summary from the selector overlay. */
	piece?: PieceMetadataSummary;
	/** Back-compat: callers that only have a piece name. */
	pieceName?: string;
	/** Legacy: old callers used `type` (plugin type). We treat it as a piece name. */
	type?: string;
	onSuccess?: (connectionId: string, externalId?: string) => void;
};

/**
 * Secret field component for password inputs
 */
function SecretField({
	fieldId,
	label,
	configKey,
	placeholder,
	helpText,
	helpLink,
	value,
	onChange,
}: {
	fieldId: string;
	label: string;
	configKey: string;
	placeholder?: string;
	helpText?: string;
	helpLink?: { url: string; text: string };
	value: string;
	onChange: (key: string, value: string) => void;
}) {
	return (
		<div className="space-y-2">
			<Label htmlFor={fieldId}>{label}</Label>
			<Input
				className="flex-1"
				id={fieldId}
				onChange={(e) => onChange(configKey, e.target.value)}
				placeholder={placeholder}
				type="password"
				value={value}
			/>
			{(helpText || helpLink) && (
				<p className="text-muted-foreground text-xs">
					{helpText}
					{helpLink && (
						<a
							className="underline hover:text-foreground"
							href={helpLink.url}
							rel="noopener noreferrer"
							target="_blank"
						>
							{helpLink.text}
						</a>
					)}
				</p>
			)}
		</div>
	);
}

/**
 * Hook to fetch piece auth config from synced metadata
 */
function usePieceAuth(pieceName: string) {
	type ParsedAuthConfig = Exclude<PieceAuthConfig, null | undefined>;
	const [authConfigs, setAuthConfigs] = useState<ParsedAuthConfig[]>([]);
	const [selectedAuthIndex, setSelectedAuthIndex] = useState(0);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState(false);
	const [piece, setPiece] = useState<{
		name: string;
		displayName: string;
		description?: string | null;
		logoUrl?: string;
	} | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setLoadError(false);
		api.piece
			.get(pieceName)
			.then((piece) => {
				if (!cancelled) {
					setPiece({
						name: piece.name,
						displayName: piece.displayName,
						description: piece.description,
						logoUrl: piece.logoUrl,
					});
					const configs = parsePieceAuthAll(piece?.auth) as ParsedAuthConfig[];
					setAuthConfigs(configs);
					setSelectedAuthIndex(0);
				}
			})
			.catch((error) => {
				console.error("Failed to load piece auth:", error);
				if (!cancelled) {
					setAuthConfigs([]);
					setSelectedAuthIndex(0);
					setPiece(null);
					setLoadError(true);
				}
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [pieceName]);

	const selectedAuthConfig = authConfigs[selectedAuthIndex] ?? null;

	return {
		authConfigs,
		selectedAuthConfig,
		selectedAuthIndex,
		setSelectedAuthIndex,
		loading,
		loadError,
		piece,
	};
}

/**
 * Overlay for configuring a new connection.
 * Dynamically renders SECRET_TEXT or OAuth2 form based on piece metadata.
 */
export function ConfigureConnectionOverlay({
	overlayId,
	piece,
	pieceName: pieceNameProp,
	type,
	onSuccess,
}: ConfigureConnectionOverlayProps) {
	const { push, closeAll } = useOverlay();
	const [saving, setSaving] = useState(false);
	const [testing, setTesting] = useState(false);
	const [displayName, setDisplayName] = useState("");
	const [config, setConfig] = useState<Record<string, string>>({});
	const [oauthConnecting, setOauthConnecting] = useState(false);
	const [oauthProps, setOauthProps] = useState<Record<string, unknown>>({});
	const [customProps, setCustomProps] = useState<Record<string, unknown>>({});

	const pieceName = piece?.name ?? pieceNameProp ?? type ?? "";
	const pieceDisplayName = piece?.displayName ?? pieceName;

	if (!pieceName) {
		return (
			<Overlay overlayId={overlayId} title="Add Connection">
				<p className="py-8 text-center text-muted-foreground text-sm">
					Missing integration name. Please refresh and try again.
				</p>
			</Overlay>
		);
	}

	// Platform OAuth apps
	const [oauthApps, setOauthApps] = useState<OAuthAppSummary[]>([]);
	useEffect(() => {
		api.oauthApp
			.list()
			.then(setOauthApps)
			.catch(() => {});
	}, []);
	const platformOAuthApp = useMemo(
		() => oauthApps.find((a) => a.pieceName === pieceName) ?? null,
		[oauthApps, pieceName],
	);

	// Fetch piece auth config from synced metadata
	const {
		authConfigs,
		selectedAuthConfig,
		selectedAuthIndex,
		setSelectedAuthIndex,
		loading: authLoading,
		loadError: authLoadError,
		piece: fetchedPiece,
	} = usePieceAuth(pieceName);
	const isOAuth2 = selectedAuthConfig?.type === PieceAuthType.OAUTH2;
	const oauth2AuthConfig = isOAuth2
		? (selectedAuthConfig as Extract<
				Exclude<PieceAuthConfig, null | undefined>,
				{ type: PieceAuthType.OAUTH2 }
			>)
		: null;

	const updateConfig = (key: string, value: string) => {
		setConfig((prev) => ({ ...prev, [key]: value }));
	};

	const connectionLabel =
		displayName.trim() ||
		piece?.displayName ||
		fetchedPiece?.displayName ||
		pieceDisplayName;
	const connectionExternalId = useMemo(
		() => connectionLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
		[connectionLabel],
	);

	const getFirstNonEmptyConfigValue = (): string =>
		Object.values(config).find((v) => v && v.length > 0) || "";

	const buildUpsertBody = (): UpsertAppConnectionRequestBody | null => {
		const base = {
			externalId: connectionExternalId,
			displayName: connectionLabel,
			pieceName,
			projectId: "default",
		} as const;

		// If the piece doesn't declare auth, treat it as NO_AUTH (common in AP).
		if (!selectedAuthConfig) {
			if (authConfigs.length === 0 && !authLoadError) {
				return {
					...base,
					type: AppConnectionType.NO_AUTH,
					value: {
						type: AppConnectionType.NO_AUTH,
					},
				};
			}
			return null;
		}

		switch (selectedAuthConfig.type) {
			case PieceAuthType.SECRET_TEXT: {
				const secret_text =
					config.secret_text?.trim() || getFirstNonEmptyConfigValue();
				if (!secret_text) return null;
				return {
					...base,
					type: AppConnectionType.SECRET_TEXT,
					value: {
						type: AppConnectionType.SECRET_TEXT,
						secret_text,
					},
				};
			}
			case PieceAuthType.BASIC_AUTH: {
				const username = config.username?.trim() || "";
				const password = config.password?.trim() || "";
				if (!(username && password)) return null;
				return {
					...base,
					type: AppConnectionType.BASIC_AUTH,
					value: {
						type: AppConnectionType.BASIC_AUTH,
						username,
						password,
					},
				};
			}
			case PieceAuthType.CUSTOM_AUTH: {
				const requiredKeys = Object.entries(selectedAuthConfig.props ?? {})
					.filter(([, prop]) => (prop as { required?: boolean }).required)
					.map(([k]) => k);
				const missingRequired = requiredKeys.filter(
					(k) => customProps[k] == null || customProps[k] === "",
				);
				if (missingRequired.length > 0) {
					return null;
				}
				return {
					...base,
					type: AppConnectionType.CUSTOM_AUTH,
					value: {
						type: AppConnectionType.CUSTOM_AUTH,
						props: customProps,
					},
				};
			}
			default:
				return null;
		}
	};

	// --- Non-OAuth save/test flow ---
	const doSaveNonOAuth = async (body: UpsertAppConnectionRequestBody) => {
		try {
			setSaving(true);
			const newConnection = await api.appConnection.upsert({
				...body,
			});
			toast.success("Connection created");
			onSuccess?.(newConnection.id, newConnection.externalId);
			closeAll();
		} catch (error) {
			console.error("Failed to save connection:", error);
			toast.error("Failed to save connection");
		} finally {
			setSaving(false);
		}
	};

	const handleSaveNonOAuth = async () => {
		const body = buildUpsertBody();
		if (!body) {
			toast.error("Please enter credentials");
			return;
		}

		try {
			setSaving(true);

			const result = await api.appConnection.test(body);

			if (result.status === "error") {
				push(ConfirmOverlay, {
					title: "Connection Test Failed",
					message: `The test failed: ${result.message}\n\nDo you want to save anyway?`,
					confirmLabel: "Save Anyway",
					onConfirm: async () => {
						await doSaveNonOAuth(body);
					},
				});
				setSaving(false);
				return;
			}

			await doSaveNonOAuth(body);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to test connection";
			push(ConfirmOverlay, {
				title: "Connection Test Failed",
				message: `${message}\n\nDo you want to save anyway?`,
				confirmLabel: "Save Anyway",
				onConfirm: async () => {
					const body = buildUpsertBody();
					if (body) {
						await doSaveNonOAuth(body);
					}
				},
			});
			setSaving(false);
		}
	};

	const handleTest = async () => {
		const body = buildUpsertBody();
		if (!body) {
			toast.error("Please enter credentials first");
			return;
		}

		try {
			setTesting(true);
			const result = await api.appConnection.test(body);
			if (result.status === "success") {
				toast.success(result.message || "Connection successful");
			} else {
				toast.error(result.message || "Connection failed");
			}
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Connection test failed";
			toast.error(message);
		} finally {
			setTesting(false);
		}
	};

	// --- OAuth2 flow (postMessage approach, matching Activepieces) ---
	// AP stores popup ref at module level; we use ref since overlay unmounts on close
	const popupRef = useRef<Window | null>(null);
	const messageHandlerRef = useRef<((e: MessageEvent) => void) | null>(null);
	const popupCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const processingRef = useRef(false);
	const popupNavigatedRef = useRef(false);
	// Store OAuth state across popup lifecycle (AP uses React Hook Form for this)
	const oauthStateRef = useRef<{
		clientId: string;
		redirectUrl: string;
		codeVerifier: string;
		state: string;
		storageKey: string;
		scope: string;
	} | null>(null);

	const storageHandlerRef = useRef<((e: StorageEvent) => void) | null>(null);
	const broadcastRef = useRef<BroadcastChannel | null>(null);

	const closeOAuthPopup = useCallback(() => {
		try {
			if (popupRef.current && !popupRef.current.closed) {
				popupRef.current.close();
			}
		} catch {
			// COOP may block access to popup.closed
		}
		popupRef.current = null;
		popupNavigatedRef.current = false;
	}, []);

	const cleanupOAuthListeners = useCallback(() => {
		if (messageHandlerRef.current) {
			window.removeEventListener("message", messageHandlerRef.current);
			messageHandlerRef.current = null;
		}
		if (storageHandlerRef.current) {
			window.removeEventListener("storage", storageHandlerRef.current);
			storageHandlerRef.current = null;
		}
		if (broadcastRef.current) {
			try {
				broadcastRef.current.close();
			} catch {
				/* ignore */
			}
			broadcastRef.current = null;
		}
		if (popupCheckRef.current) {
			clearInterval(popupCheckRef.current);
			popupCheckRef.current = null;
		}
	}, []);

	useEffect(
		() => () => {
			cleanupOAuthListeners();
			closeOAuthPopup();
			processingRef.current = false;
		},
		[cleanupOAuthListeners, closeOAuthPopup],
	);

	const handleOAuth2Connect = async () => {
		try {
			setOauthConnecting(true);
			processingRef.current = false;
			popupNavigatedRef.current = false;

			const redirectUrl = `${window.location.origin}/redirect`;

			// Open synchronously to avoid popup blockers; navigate after the async start call.
			closeOAuthPopup();
			const popup = window.open(
				`${window.location.origin}/oauth2/popup`,
				"_blank",
			);

			if (!popup) {
				toast.error("Popup blocked. Please allow popups for this site.");
				setOauthConnecting(false);
				return;
			}

			popupRef.current = popup;

			// Give the user immediate feedback inside the popup. If the OAuth2 start
			// request fails, we keep the popup open and show the error instead of
			// opening then immediately closing (which looks like a popup blocker).
			try {
				popup.document.open();
				popup.document.write(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Connecting...</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 0; }
      .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; color: #334155; background: #fff; }
      .card { max-width: 520px; width: 100%; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px 16px; }
      .title { font-size: 14px; font-weight: 600; margin: 0 0 6px; color: #0f172a; }
      .desc { font-size: 13px; margin: 0; color: #475569; line-height: 1.45; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; color: #475569; margin-top: 10px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <p class="title">Starting authorization</p>
        <p class="desc">If this window closes immediately, check your browser's popup settings and confirm OAuth is configured for this environment.</p>
        <div class="mono">${redirectUrl.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</div>
      </div>
    </div>
  </body>
</html>`);
				popup.document.close();
			} catch {
				// ignore - some browsers restrict writing to the popup
			}

			// Start OAuth2 flow - server fetches platform clientId from oauth_apps table
			let startResult;
			try {
				startResult = await api.appConnection.oauth2Start({
					pieceName,
					props: oauthProps,
					redirectUrl,
				});
			} catch (err) {
				const message =
					err instanceof Error ? err.message : "Failed to start OAuth2 flow";
				toast.error(message);
				try {
					popup.document.open();
					popup.document.write(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Authorization Failed</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 0; }
      .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; color: #334155; background: #fff; }
      .card { max-width: 520px; width: 100%; border: 1px solid #fecaca; background: #fff1f2; border-radius: 12px; padding: 18px 16px; }
      .title { font-size: 14px; font-weight: 600; margin: 0 0 6px; color: #7f1d1d; }
      .desc { font-size: 13px; margin: 0; color: #7f1d1d; line-height: 1.45; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; color: #7f1d1d; margin-top: 10px; white-space: pre-wrap; word-break: break-word; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <p class="title">Authorization could not start</p>
        <p class="desc">This window will stay open so you can read the error.</p>
        <div class="mono">${message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</div>
      </div>
    </div>
  </body>
</html>`);
					popup.document.close();
				} catch {
					/* ignore */
				}
				setOauthConnecting(false);
				return;
			}

			const storageKey = `oauth2_callback_result:${startResult.state}`;

			// Store OAuth state in ref so it survives across the async popup flow
			oauthStateRef.current = {
				clientId: startResult.clientId,
				redirectUrl: startResult.redirectUrl,
				codeVerifier: startResult.codeVerifier,
				state: startResult.state,
				storageKey,
				scope: startResult.scope,
			};

			try {
				popup.location.href = startResult.authorizationUrl;
				popupNavigatedRef.current = true;
			} catch {
				try {
					popup.document.open();
					popup.document.write(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Authorization Failed</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 0; }
      .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; color: #334155; background: #fff; }
      .card { max-width: 520px; width: 100%; border: 1px solid #fecaca; background: #fff1f2; border-radius: 12px; padding: 18px 16px; }
      .title { font-size: 14px; font-weight: 600; margin: 0 0 6px; color: #7f1d1d; }
      .desc { font-size: 13px; margin: 0; color: #7f1d1d; line-height: 1.45; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; color: #7f1d1d; margin-top: 10px; white-space: pre-wrap; word-break: break-word; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <p class="title">Could not navigate to provider</p>
        <p class="desc">This window will stay open so you can read the error.</p>
        <div class="mono">Failed to navigate OAuth popup. Try again, and check popup settings if it closes immediately.</div>
      </div>
    </div>
  </body>
</html>`);
					popup.document.close();
				} catch {
					/* ignore */
				}

				toast.error("Failed to navigate OAuth popup. Please try again.");
				setOauthConnecting(false);
				return;
			}

			// Clear any stale localStorage result from a previous attempt
			try {
				localStorage.removeItem("oauth2_callback_result");
			} catch {
				/* ok */
			}
			try {
				localStorage.removeItem(storageKey);
			} catch {
				/* ok */
			}

			// Shared handler: processes the OAuth callback result from either channel
			const processCallbackResult = async (data: Record<string, unknown>) => {
				if (processingRef.current) return;

				if (data.error) {
					processingRef.current = true;
					cleanupOAuthListeners();
					closeOAuthPopup();
					const desc = (data.errorDescription ||
						data.error ||
						"Unknown error") as string;
					toast.error(`OAuth2 failed: ${desc}`);
					setOauthConnecting(false);
					processingRef.current = false;
					return;
				}

				if (!data.code) return;

				processingRef.current = true;
				cleanupOAuthListeners();
				closeOAuthPopup();

				// Clean up localStorage fallback key
				try {
					localStorage.removeItem("oauth2_callback_result");
				} catch {
					/* ok */
				}
				try {
					localStorage.removeItem(storageKey);
				} catch {
					/* ok */
				}

				const code = decodeURIComponent(data.code as string);
				const returnedState = typeof data.state === "string" ? data.state : "";
				const oauthState = oauthStateRef.current;
				if (!oauthState) {
					toast.error("OAuth state lost - please try again");
					setOauthConnecting(false);
					processingRef.current = false;
					return;
				}
				if (oauthState.state !== returnedState) {
					toast.error("OAuth state mismatch - please try again");
					setOauthConnecting(false);
					processingRef.current = false;
					return;
				}

				try {
					const name =
						displayName.trim() ||
						piece?.displayName ||
						fetchedPiece?.displayName ||
						pieceDisplayName;
					const newConnection = await api.appConnection.upsert({
						externalId: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
						displayName: name,
						pieceName,
						projectId: "default",
						type: AppConnectionType.PLATFORM_OAUTH2,
						value: {
							type: AppConnectionType.PLATFORM_OAUTH2,
							client_id: oauthState.clientId,
							redirect_url: oauthState.redirectUrl,
							code,
							scope: oauthState.scope,
							code_verifier: oauthState.codeVerifier || undefined,
							props: oauthProps,
							authorization_method: oauth2AuthConfig?.authorizationMethod,
						},
					});

					toast.success("Connection created via OAuth2");
					onSuccess?.(newConnection.id, newConnection.externalId);
					closeAll();
				} catch (err) {
					console.error("Failed to save OAuth2 connection:", err);
					toast.error(
						err instanceof Error ? err.message : "Failed to save connection",
					);
					setOauthConnecting(false);
					processingRef.current = false;
				}
			};

			// Channel 1: postMessage (works when COOP doesn't block window.opener)
			const messageHandler = (event: MessageEvent) => {
				if (event.origin !== window.location.origin) return;
				const data = event.data;
				if (!data || typeof data !== "object") return;
				if (!(data.code || data.error)) return;
				processCallbackResult(data);
			};
			messageHandlerRef.current = messageHandler;
			window.addEventListener("message", messageHandler);

			// Channel 1.5: BroadcastChannel (fallback when storage events are unreliable)
			try {
				if (typeof BroadcastChannel !== "undefined") {
					const bc = new BroadcastChannel(storageKey);
					bc.onmessage = (event) => {
						const data = event.data;
						if (!data || typeof data !== "object") return;
						if (!("code" in data) && !("error" in data)) return;
						processCallbackResult(data as Record<string, unknown>);
					};
					broadcastRef.current = bc;
				}
			} catch {
				/* ignore */
			}

			// Channel 2: localStorage (fallback for COOP - Google OAuth sets
			// Cross-Origin-Opener-Policy: same-origin which severs window.opener)
			const storageHandler = (event: StorageEvent) => {
				if (!event.newValue) return;
				if (event.key !== storageKey && event.key !== "oauth2_callback_result")
					return;
				try {
					const data = JSON.parse(event.newValue);
					processCallbackResult(data);
				} catch {
					// ignore malformed data
				}
			};
			storageHandlerRef.current = storageHandler;
			window.addEventListener("storage", storageHandler);

			// Poll localStorage with a grace period.
			// COOP (Cross-Origin-Opener-Policy) from OAuth providers can sever the popup
			// reference, making popup.closed unreliable. Rely on postMessage/storage/
			// BroadcastChannel delivery and an overall timeout instead.
			const POPUP_GRACE_PERIOD_MS = 10_000;
			const POPUP_OVERALL_TIMEOUT_MS = 2 * 60_000;
			const popupOpenedAt = Date.now();
			popupCheckRef.current = setInterval(() => {
				// If the popup closes before we even navigate to the provider, it's a real
				// popup blocker/user-close signal (not COOP). Fail fast with a clear message.
				try {
					if (!popupNavigatedRef.current && popup.closed) {
						cleanupOAuthListeners();
						toast.error(
							"Authorization popup was closed. Please allow popups for this site and try again.",
						);
						setOauthConnecting(false);
						return;
					}
				} catch {
					/* ignore */
				}

				// Always stop after an overall timeout to avoid an infinite spinner.
				if (Date.now() - popupOpenedAt >= POPUP_OVERALL_TIMEOUT_MS) {
					cleanupOAuthListeners();
					toast.error(
						"Authorization timed out. Ensure your OAuth app has the correct redirect URI configured.",
					);
					setOauthConnecting(false);
					return;
				}

				// During grace period, only check localStorage for early callbacks
				if (Date.now() - popupOpenedAt < POPUP_GRACE_PERIOD_MS) {
					try {
						const stored =
							localStorage.getItem(storageKey) ??
							localStorage.getItem("oauth2_callback_result");
						if (stored) {
							const data = JSON.parse(stored);
							processCallbackResult(data);
						}
					} catch {
						/* ok */
					}
					return;
				}

				// After grace period, keep polling localStorage in case storage events
				// or BroadcastChannel delivery are blocked by the environment.
				try {
					const stored =
						localStorage.getItem(storageKey) ??
						localStorage.getItem("oauth2_callback_result");
					if (stored) {
						const data = JSON.parse(stored);
						processCallbackResult(data);
					}
				} catch {
					/* ok */
				}
			}, 1000);
		} catch (error) {
			console.error("OAuth2 start failed:", error);
			cleanupOAuthListeners();
			toast.error(
				error instanceof Error ? error.message : "Failed to start OAuth2 flow",
			);
			setOauthConnecting(false);
		}
	};

	// Render config fields for SECRET_TEXT mode
	const renderSecretTextFields = () => {
		if (selectedAuthConfig?.type === PieceAuthType.SECRET_TEXT) {
			return (
				<SecretField
					configKey="secret_text"
					fieldId="secret_text"
					helpText={selectedAuthConfig.description}
					label={selectedAuthConfig.displayName || "API Key"}
					onChange={updateConfig}
					placeholder="Enter your API key"
					value={config.secret_text || ""}
				/>
			);
		}

		return null;
	};

	const renderAuthMethodSelect = () => {
		if (authConfigs.length <= 1) return null;

		return (
			<div className="space-y-2">
				<Label>Auth method</Label>
				<Select
					onValueChange={(val) => setSelectedAuthIndex(Number(val))}
					value={String(selectedAuthIndex)}
				>
					<SelectTrigger>
						<SelectValue placeholder="Select auth method" />
					</SelectTrigger>
					<SelectContent>
						{authConfigs.map((cfg, idx) => (
							<SelectItem key={`${cfg.type}-${idx}`} value={String(idx)}>
								{cfg.displayName
									? `${cfg.displayName} (${cfg.type})`
									: cfg.type}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
		);
	};

	const renderPiecePropertyField = (params: {
		propKey: string;
		property: PieceAuthProperty;
		value: unknown;
		onChange: (val: unknown) => void;
	}) => {
		const { propKey, property, value, onChange } = params;

		if (property.type === PiecePropertyType.MARKDOWN) {
			return (
				<div className="text-muted-foreground text-sm" key={propKey}>
					{"value" in property ? property.value : ""}
				</div>
			);
		}

		const displayName =
			"displayName" in property ? property.displayName : propKey;
		const description =
			"description" in property ? property.description : undefined;

		switch (property.type) {
			case PiecePropertyType.SECRET_TEXT:
				return (
					<SecretField
						configKey={propKey}
						fieldId={propKey}
						key={propKey}
						label={displayName}
						onChange={(_, v) => onChange(v)}
						placeholder={description || `Enter ${displayName.toLowerCase()}`}
						value={String(value ?? "")}
					/>
				);
			case PiecePropertyType.LONG_TEXT:
				return (
					<div className="space-y-2" key={propKey}>
						<Label htmlFor={propKey}>{displayName}</Label>
						<Textarea
							disabled={saving || oauthConnecting}
							id={propKey}
							onChange={(e) => onChange(e.target.value)}
							placeholder={description || `Enter ${displayName.toLowerCase()}`}
							rows={3}
							value={String(value ?? "")}
						/>
						{description && (
							<p className="text-muted-foreground text-xs">{description}</p>
						)}
					</div>
				);
			case PiecePropertyType.NUMBER:
				return (
					<div className="space-y-2" key={propKey}>
						<Label htmlFor={propKey}>{displayName}</Label>
						<Input
							id={propKey}
							onChange={(e) => onChange(Number(e.target.value))}
							placeholder={description || `Enter ${displayName.toLowerCase()}`}
							type="number"
							value={value !== undefined && value !== null ? String(value) : ""}
						/>
						{description && (
							<p className="text-muted-foreground text-xs">{description}</p>
						)}
					</div>
				);
			case PiecePropertyType.CHECKBOX:
				return (
					<div className="flex items-center gap-2" key={propKey}>
						<Checkbox
							checked={!!value}
							id={propKey}
							onCheckedChange={(checked) => onChange(checked)}
						/>
						<Label className="cursor-pointer" htmlFor={propKey}>
							{displayName}
						</Label>
						{description && (
							<p className="text-muted-foreground text-xs">{description}</p>
						)}
					</div>
				);
			case PiecePropertyType.STATIC_DROPDOWN:
				return (
					<div className="space-y-2" key={propKey}>
						<Label htmlFor={propKey}>{displayName}</Label>
						<Select
							onValueChange={(val) => onChange(val)}
							value={typeof value === "string" ? value : undefined}
						>
							<SelectTrigger id={propKey}>
								<SelectValue
									placeholder={
										property.options?.placeholder ||
										`Select ${displayName.toLowerCase()}`
									}
								/>
							</SelectTrigger>
							<SelectContent>
								{(property.options?.options || []).map((opt) => (
									<SelectItem key={opt.value} value={opt.value}>
										{opt.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						{description && (
							<p className="text-muted-foreground text-xs">{description}</p>
						)}
					</div>
				);
			case PiecePropertyType.SHORT_TEXT:
			default:
				return (
					<div className="space-y-2" key={propKey}>
						<Label htmlFor={propKey}>{displayName}</Label>
						<Input
							id={propKey}
							onChange={(e) => onChange(e.target.value)}
							placeholder={description || `Enter ${displayName.toLowerCase()}`}
							value={String(value ?? "")}
						/>
						{description && (
							<p className="text-muted-foreground text-xs">{description}</p>
						)}
					</div>
				);
		}
	};

	const renderBasicAuthFields = () => {
		if (
			!selectedAuthConfig ||
			selectedAuthConfig.type !== PieceAuthType.BASIC_AUTH
		) {
			return null;
		}
		return (
			<>
				<div className="space-y-2">
					<Label htmlFor="username">
						{selectedAuthConfig.username?.displayName || "Username"}
					</Label>
					<Input
						id="username"
						onChange={(e) => updateConfig("username", e.target.value)}
						placeholder={
							selectedAuthConfig.username?.description || "Enter username"
						}
						value={config.username || ""}
					/>
				</div>
				<SecretField
					configKey="password"
					fieldId="password"
					label={selectedAuthConfig.password?.displayName || "Password"}
					onChange={updateConfig}
					placeholder={
						selectedAuthConfig.password?.description || "Enter password"
					}
					value={config.password || ""}
				/>
			</>
		);
	};

	const renderCustomAuthFields = () => {
		if (
			!selectedAuthConfig ||
			selectedAuthConfig.type !== PieceAuthType.CUSTOM_AUTH
		) {
			return null;
		}

		const props = selectedAuthConfig.props ?? {};
		const entries = Object.entries(props);
		if (entries.length === 0) {
			return (
				<p className="text-muted-foreground text-sm">
					This integration requires custom auth props, but none were defined in
					piece metadata.
				</p>
			);
		}

		return (
			<div className="space-y-4">
				{entries.map(([key, prop]) =>
					renderPiecePropertyField({
						propKey: key,
						property: prop,
						value: customProps[key],
						onChange: (val) =>
							setCustomProps((prev) => ({ ...prev, [key]: val })),
					}),
				)}
			</div>
		);
	};

	const renderOAuth2PropsFields = () => {
		if (!oauth2AuthConfig?.props) {
			return null;
		}
		const entries = Object.entries(oauth2AuthConfig.props);
		if (entries.length === 0) return null;

		return (
			<div className="space-y-4">
				{entries.map(([key, prop]) =>
					renderPiecePropertyField({
						propKey: key,
						property: prop,
						value: oauthProps[key],
						onChange: (val) =>
							setOauthProps((prev) => ({ ...prev, [key]: val })),
					}),
				)}
			</div>
		);
	};

	// Render OAuth2 fields
	const renderOAuth2Fields = () => (
		<>
			{renderAuthMethodSelect()}
			{platformOAuthApp ? (
				<div className="rounded-md border bg-muted/30 px-3 py-2 text-muted-foreground text-sm">
					OAuth credentials configured by your administrator.
				</div>
			) : (
				<div className="rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200">
					OAuth app not configured for this piece. Ask your administrator to set
					it up in Settings.
				</div>
			)}
			{platformOAuthApp && renderOAuth2PropsFields()}
			{oauth2AuthConfig?.scope && oauth2AuthConfig.scope.length > 0 && (
				<div className="space-y-1">
					<Label className="text-muted-foreground text-xs">Scopes</Label>
					<p className="rounded-md bg-muted/50 px-3 py-2 font-mono text-xs">
						{oauth2AuthConfig.scope.join(", ")}
					</p>
				</div>
			)}
			<Button
				className="w-full"
				disabled={oauthConnecting || !platformOAuthApp}
				onClick={handleOAuth2Connect}
				size="lg"
			>
				<ExternalLink className="mr-2 size-4" />
				{oauthConnecting
					? "Waiting for authorization..."
					: `Connect with ${pieceDisplayName}`}
			</Button>
		</>
	);

	if (authLoading) {
		return (
			<Overlay overlayId={overlayId} title={`Add ${pieceDisplayName}`}>
				<p className="py-8 text-center text-muted-foreground text-sm">
					Loading...
				</p>
			</Overlay>
		);
	}

	if (authLoadError) {
		return (
			<Overlay overlayId={overlayId} title={`Add ${pieceDisplayName}`}>
				<p className="py-8 text-center text-muted-foreground text-sm">
					Failed to load integration metadata. Please refresh and try again.
				</p>
			</Overlay>
		);
	}

	// OAuth2 mode - no Test/Create buttons, just the Connect button
	if (isOAuth2) {
		return (
			<Overlay overlayId={overlayId} title={`Add ${pieceDisplayName}`}>
				<p className="-mt-2 mb-4 text-muted-foreground text-sm">
					Connect via OAuth2
				</p>
				<div className="space-y-4">
					{oauth2AuthConfig?.description && (
						<AuthSetupInstructions description={oauth2AuthConfig.description} />
					)}
					{renderOAuth2Fields()}
					<div className="space-y-2">
						<Label htmlFor="name">Label (Optional)</Label>
						<Input
							id="name"
							onChange={(e) => setDisplayName(e.target.value)}
							placeholder="e.g. Production, Personal, Work"
							value={displayName}
						/>
					</div>
				</div>
			</Overlay>
		);
	}

	// Non-OAuth mode (SECRET_TEXT / BASIC_AUTH / CUSTOM_AUTH / fallback)
	return (
		<Overlay
			actions={[
				{
					label: "Test",
					variant: "outline",
					onClick: handleTest,
					loading: testing,
					disabled: saving,
				},
				{ label: "Create", onClick: handleSaveNonOAuth, loading: saving },
			]}
			overlayId={overlayId}
			title={`Add ${pieceDisplayName}`}
		>
			<p className="-mt-2 mb-4 text-muted-foreground text-sm">
				Enter credentials
			</p>

			<div className="space-y-4">
				{renderAuthMethodSelect()}

				{selectedAuthConfig?.description && (
					<AuthSetupInstructions description={selectedAuthConfig.description} />
				)}

				{selectedAuthConfig?.type === PieceAuthType.BASIC_AUTH
					? renderBasicAuthFields()
					: selectedAuthConfig?.type === PieceAuthType.CUSTOM_AUTH
						? renderCustomAuthFields()
						: renderSecretTextFields()}

				<div className="space-y-2">
					<Label htmlFor="name">Label (Optional)</Label>
					<Input
						id="name"
						onChange={(e) => setDisplayName(e.target.value)}
						placeholder="e.g. Production, Personal, Work"
						value={displayName}
					/>
				</div>
			</div>
		</Overlay>
	);
}
