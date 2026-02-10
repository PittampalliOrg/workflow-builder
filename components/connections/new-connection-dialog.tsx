"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, ExternalLink, Loader2, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogFooter,
	DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	api,
	type OAuthAppSummary,
	type PieceMetadataSummary,
} from "@/lib/api-client";
import { saveOAuth2Pending } from "@/lib/app-connections/oauth2-resume-client";
import {
	type PieceAuthConfig,
	parsePieceAuthAll,
	PieceAuthType,
	type PieceAuthProperty,
	PiecePropertyType,
} from "@/lib/types/piece-auth";
import {
	AppConnectionType,
	type OAuth2AuthorizationMethod,
	OAuth2GrantType,
	type UpsertAppConnectionRequestBody,
} from "@/lib/types/app-connection";

type NewConnectionDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSuccess?: () => void;
	/** If provided, skip step 1 and go directly to auth form for this piece */
	preselectedPiece?: PieceMetadataSummary;
};

// ---------------------------------------------------------------------------
// usePieceAuth hook - fetches full piece auth config from synced metadata
// ---------------------------------------------------------------------------
type ParsedAuthConfig = Exclude<PieceAuthConfig, null | undefined>;

function usePieceAuth(pieceName: string | null) {
	const [authConfigs, setAuthConfigs] = useState<ParsedAuthConfig[]>([]);
	const [selectedAuthIndex, setSelectedAuthIndex] = useState(0);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		if (!pieceName) {
			setAuthConfigs([]);
			setSelectedAuthIndex(0);
			return;
		}
		let cancelled = false;
		setLoading(true);
		api.piece
			.get(pieceName)
			.then((piece) => {
				if (!cancelled) {
					const configs = parsePieceAuthAll(piece?.auth) as ParsedAuthConfig[];
					setAuthConfigs(configs);
					setSelectedAuthIndex(0);
				}
			})
			.catch(() => {})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [pieceName]);

	return {
		authConfigs,
		selectedAuthConfig: authConfigs[selectedAuthIndex] ?? null,
		selectedAuthIndex,
		setSelectedAuthIndex,
		loading,
	};
}

// ---------------------------------------------------------------------------
// AuthSetupInstructions
// ---------------------------------------------------------------------------
function AuthSetupInstructions({ description }: { description: string }) {
	const lines = description.split("\n").filter((l) => l.trim());
	return (
		<details className="rounded-md border bg-muted/30 text-sm">
			<summary className="cursor-pointer px-3 py-2 font-medium text-muted-foreground hover:text-foreground">
				Setup instructions
			</summary>
			<div className="border-t px-3 py-2 space-y-1">
				{lines.map((line, i) => (
					<p
						key={i}
						className="my-0.5 text-muted-foreground text-xs leading-relaxed"
					>
						{line.trim()}
					</p>
				))}
			</div>
		</details>
	);
}

// ---------------------------------------------------------------------------
// NewConnectionDialog
// ---------------------------------------------------------------------------
export function NewConnectionDialog({
	open,
	onOpenChange,
	onSuccess,
	preselectedPiece,
}: NewConnectionDialogProps) {
	// Step management
	const [step, setStep] = useState<1 | 2>(preselectedPiece ? 2 : 1);
	const [selectedPiece, setSelectedPiece] =
		useState<PieceMetadataSummary | null>(preselectedPiece ?? null);

	// Step 1 state
	const [pieces, setPieces] = useState<PieceMetadataSummary[]>([]);
	const [piecesLoading, setPiecesLoading] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");

	// Step 2 state
	const [displayName, setDisplayName] = useState("");
	const [config, setConfig] = useState<Record<string, string>>({});
	const [customProps, setCustomProps] = useState<Record<string, unknown>>({});
	const [oauthProps, setOauthProps] = useState<Record<string, unknown>>({});
	const [saving, setSaving] = useState(false);
	const [oauthConnecting, setOauthConnecting] = useState(false);
	const [oauthGrantType, setOauthGrantType] = useState<OAuth2GrantType>(
		OAuth2GrantType.AUTHORIZATION_CODE,
	);

	// Platform OAuth apps (fetched once)
	const [oauthApps, setOauthApps] = useState<OAuthAppSummary[]>([]);
	const [oauthAppsLoaded, setOauthAppsLoaded] = useState(false);

	const {
		authConfigs,
		selectedAuthConfig,
		selectedAuthIndex,
		setSelectedAuthIndex,
		loading: authLoading,
	} = usePieceAuth(selectedPiece?.name ?? null);

	const isOAuth2 = selectedAuthConfig?.type === PieceAuthType.OAUTH2;
	const oauth2AuthConfig = isOAuth2
		? (selectedAuthConfig as Extract<
				ParsedAuthConfig,
				{ type: PieceAuthType.OAUTH2 }
			>)
		: null;

	const supportsClientCredentials =
		oauth2AuthConfig?.grantType === OAuth2GrantType.CLIENT_CREDENTIALS ||
		oauth2AuthConfig?.grantType ===
			"both_client_credentials_and_authorization_code";
	const supportsAuthCode =
		oauth2AuthConfig?.grantType !== OAuth2GrantType.CLIENT_CREDENTIALS;

	// Sync grant type with piece config
	useEffect(() => {
		if (!oauth2AuthConfig) return;
		if (oauth2AuthConfig.grantType === OAuth2GrantType.CLIENT_CREDENTIALS) {
			setOauthGrantType(OAuth2GrantType.CLIENT_CREDENTIALS);
			return;
		}
		setOauthGrantType(OAuth2GrantType.AUTHORIZATION_CODE);
	}, [oauth2AuthConfig]);

	// Reset state when dialog opens/closes
	useEffect(() => {
		if (open) {
			setStep(preselectedPiece ? 2 : 1);
			setSelectedPiece(preselectedPiece ?? null);
			setDisplayName("");
			setConfig({});
			setCustomProps({});
			setOauthProps({});
			setSaving(false);
			setOauthConnecting(false);
			setSearchQuery("");
		}
	}, [open, preselectedPiece]);

	// Fetch platform OAuth apps
	useEffect(() => {
		if (!open) return;
		api.oauthApp
			.list()
			.then((apps) => {
				setOauthApps(apps);
				setOauthAppsLoaded(true);
			})
			.catch(() => {
				setOauthAppsLoaded(true);
			});
	}, [open]);

	const platformOAuthApp = useMemo(
		() =>
			selectedPiece
				? (oauthApps.find((a) => a.pieceName === selectedPiece.name) ?? null)
				: null,
		[oauthApps, selectedPiece],
	);

	// Fetch pieces for Step 1
	useEffect(() => {
		if (!open || preselectedPiece) return;
		const trimmed = searchQuery.trim();
		setPiecesLoading(true);
		let cancelled = false;
		const timer = setTimeout(() => {
			api.piece
				.list({ searchQuery: trimmed || undefined, limit: trimmed ? 200 : 50 })
				.then((result) => {
					if (!cancelled) {
						setPieces(result.filter((p) => p.auth != null));
					}
				})
				.catch(() => {
					if (!cancelled) toast.error("Failed to load pieces");
				})
				.finally(() => {
					if (!cancelled) setPiecesLoading(false);
				});
		}, 200);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [open, preselectedPiece, searchQuery]);

	const filteredPieces = pieces;

	const connectionLabel =
		displayName.trim() || `${selectedPiece?.displayName ?? ""} Connection`;
	const connectionExternalId = useMemo(
		() => connectionLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
		[connectionLabel],
	);

	const updateConfig = (key: string, value: string) => {
		setConfig((prev) => ({ ...prev, [key]: value }));
	};

	// ---------------------------------------------------------------------------
	// Non-OAuth save
	// ---------------------------------------------------------------------------
	const buildUpsertBody = (): UpsertAppConnectionRequestBody | null => {
		if (!selectedPiece) return null;
		const base = {
			externalId: connectionExternalId,
			displayName: connectionLabel,
			pieceName: selectedPiece.name,
			projectId: "default",
		} as const;

		if (!selectedAuthConfig) return null;

		switch (selectedAuthConfig.type) {
			case PieceAuthType.SECRET_TEXT: {
				const secret_text = config.secret_text?.trim();
				if (!secret_text) return null;
				return {
					...base,
					type: AppConnectionType.SECRET_TEXT,
					value: { type: AppConnectionType.SECRET_TEXT, secret_text },
				};
			}
			case PieceAuthType.BASIC_AUTH: {
				const username = config.username?.trim() || "";
				const password = config.password?.trim() || "";
				if (!username || !password) return null;
				return {
					...base,
					type: AppConnectionType.BASIC_AUTH,
					value: { type: AppConnectionType.BASIC_AUTH, username, password },
				};
			}
			case PieceAuthType.CUSTOM_AUTH: {
				const requiredKeys = Object.entries(selectedAuthConfig.props ?? {})
					.filter(([, prop]) => (prop as { required?: boolean }).required)
					.map(([k]) => k);
				const missingRequired = requiredKeys.filter(
					(k) => customProps[k] == null || customProps[k] === "",
				);
				if (missingRequired.length > 0) return null;
				return {
					...base,
					type: AppConnectionType.CUSTOM_AUTH,
					value: { type: AppConnectionType.CUSTOM_AUTH, props: customProps },
				};
			}
			default:
				return null;
		}
	};

	const handleSaveNonOAuth = async () => {
		const body = buildUpsertBody();
		if (!body) {
			toast.error("Please fill in all required fields");
			return;
		}
		try {
			setSaving(true);
			await api.appConnection.upsert(body);
			toast.success("Connection created");
			onSuccess?.();
			onOpenChange(false);
		} catch (error) {
			console.error("Failed to save connection:", error);
			toast.error(
				error instanceof Error ? error.message : "Failed to save connection",
			);
		} finally {
			setSaving(false);
		}
	};

	// ---------------------------------------------------------------------------
	// OAuth2 flow
	// ---------------------------------------------------------------------------
	const popupRef = useRef<Window | null>(null);
	const messageHandlerRef = useRef<((e: MessageEvent) => void) | null>(null);
	const storageHandlerRef = useRef<((e: StorageEvent) => void) | null>(null);
	const broadcastRef = useRef<BroadcastChannel | null>(null);
	const popupCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const processingRef = useRef(false);
	const popupNavigatedRef = useRef(false);
	const oauthStateRef = useRef<{
		clientId: string;
		redirectUrl: string;
		codeVerifier: string;
		state: string;
		storageKey: string;
		scope: string;
	} | null>(null);

	const closeOAuthPopup = useCallback(() => {
		try {
			if (popupRef.current && !popupRef.current.closed) {
				popupRef.current.close();
			}
		} catch {
			// COOP may block access
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

	useEffect(() => {
		return () => {
			cleanupOAuthListeners();
			closeOAuthPopup();
			processingRef.current = false;
		};
	}, [cleanupOAuthListeners, closeOAuthPopup]);

	const handleOAuth2Connect = async () => {
		if (!selectedPiece) return;

		try {
			setOauthConnecting(true);
			processingRef.current = false;
			popupNavigatedRef.current = false;

			const redirectUrl = `${window.location.origin}/redirect`;
			const resolvedDisplayName =
				displayName.trim() || `${selectedPiece.displayName} Connection`;

			const startSameTabOAuth = async () => {
				const startResult = await api.appConnection.oauth2Start({
					pieceName: selectedPiece.name,
					props: oauthProps,
					redirectUrl,
				});

				saveOAuth2Pending({
					state: startResult.state,
					pieceName: selectedPiece.name,
					displayName: resolvedDisplayName,
					clientId: startResult.clientId,
					redirectUrl: startResult.redirectUrl,
					codeVerifier: startResult.codeVerifier,
					scope: startResult.scope,
					props: oauthProps,
					authorizationMethod: oauth2AuthConfig?.authorizationMethod as
						| OAuth2AuthorizationMethod
						| undefined,
				});

				window.location.assign(startResult.authorizationUrl);
			};

			// Open synchronously to avoid popup blockers; navigate after the async start call.
			// Authorization code grant - start PKCE flow via server
			// Server fetches platform clientId from oauth_apps table
			closeOAuthPopup();
			const popup = window.open(
				`${window.location.origin}/oauth2/popup`,
				"_blank",
			);

			if (!popup) {
				toast.error("Popup blocked.", {
					description:
						"Please allow popups for this site, or continue authorization in this tab.",
					action: {
						label: "Continue in this tab",
						onClick: () => {
							void (async () => {
								try {
									await startSameTabOAuth();
								} catch (err) {
									const message =
										err instanceof Error
											? err.message
											: "Failed to start OAuth2 flow";
									toast.error(message);
								}
							})();
						},
					},
				});
				setOauthConnecting(false);
				return;
			}

			popupRef.current = popup;

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
				/* ignore */
			}

			let startResult;
			try {
				startResult = await api.appConnection.oauth2Start({
					pieceName: selectedPiece.name,
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

			oauthStateRef.current = {
				clientId: startResult.clientId,
				redirectUrl: startResult.redirectUrl,
				codeVerifier: startResult.codeVerifier,
				state: startResult.state,
				storageKey,
				scope: startResult.scope,
			};

			// If the popup was closed by the browser before navigation, fall back to
			// same-tab auth (state is still valid).
			try {
				if (popup.closed) {
					toast.error("Authorization popup was closed.", {
						description: "You can continue authorization in this tab instead.",
						action: {
							label: "Continue in this tab",
							onClick: () => {
								void (async () => {
									try {
										saveOAuth2Pending({
											state: startResult.state,
											pieceName: selectedPiece.name,
											displayName: resolvedDisplayName,
											clientId: startResult.clientId,
											redirectUrl: startResult.redirectUrl,
											codeVerifier: startResult.codeVerifier,
											scope: startResult.scope,
											props: oauthProps,
											authorizationMethod:
												oauth2AuthConfig?.authorizationMethod as
													| OAuth2AuthorizationMethod
													| undefined,
										});
										window.location.assign(startResult.authorizationUrl);
									} catch {
										/* ignore */
									}
								})();
							},
						},
					});
					setOauthConnecting(false);
					return;
				}
			} catch {
				/* ignore */
			}

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

				toast.error("Failed to navigate OAuth popup.", {
					description: "You can continue authorization in this tab instead.",
					action: {
						label: "Continue in this tab",
						onClick: () => {
							void (async () => {
								try {
									saveOAuth2Pending({
										state: startResult.state,
										pieceName: selectedPiece.name,
										displayName: resolvedDisplayName,
										clientId: startResult.clientId,
										redirectUrl: startResult.redirectUrl,
										codeVerifier: startResult.codeVerifier,
										scope: startResult.scope,
										props: oauthProps,
										authorizationMethod:
											oauth2AuthConfig?.authorizationMethod as
												| OAuth2AuthorizationMethod
												| undefined,
									});
									window.location.assign(startResult.authorizationUrl);
								} catch {
									/* ignore */
								}
							})();
						},
					},
				});
				setOauthConnecting(false);
				return;
			}
			try {
				localStorage.removeItem(storageKey);
			} catch {
				/* ok */
			}

			// Process callback from either postMessage or localStorage
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
						displayName.trim() || `${selectedPiece!.displayName} Connection`;
					await api.appConnection.upsert({
						externalId: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
						displayName: name,
						pieceName: selectedPiece!.name,
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
					onSuccess?.();
					onOpenChange(false);
				} catch (err) {
					console.error("Failed to save OAuth2 connection:", err);
					toast.error(
						err instanceof Error ? err.message : "Failed to save connection",
					);
					setOauthConnecting(false);
					processingRef.current = false;
				}
			};

			// Channel 1: postMessage
			const messageHandler = (event: MessageEvent) => {
				if (event.origin !== window.location.origin) return;
				const d = event.data;
				if (!d || typeof d !== "object") return;
				if (!d.code && !d.error) return;
				processCallbackResult(d);
			};
			messageHandlerRef.current = messageHandler;
			window.addEventListener("message", messageHandler);

			// Channel 1.5: BroadcastChannel (fallback when storage events are unreliable)
			try {
				if (typeof BroadcastChannel !== "undefined") {
					const bc = new BroadcastChannel(storageKey);
					bc.onmessage = (event) => {
						const d = event.data;
						if (!d || typeof d !== "object") return;
						if (!("code" in d) && !("error" in d)) return;
						processCallbackResult(d as Record<string, unknown>);
					};
					broadcastRef.current = bc;
				}
			} catch {
				/* ignore */
			}

			// Channel 2: localStorage (fallback for COOP)
			const storageHandler = (event: StorageEvent) => {
				if (!event.newValue) return;
				if (event.key !== storageKey) return;
				try {
					const d = JSON.parse(event.newValue);
					processCallbackResult(d);
				} catch {
					/* ignore */
				}
			};
			storageHandlerRef.current = storageHandler;
			window.addEventListener("storage", storageHandler);

			// Poll localStorage with a grace period.
			// Some OAuth providers set COOP and sever the popup reference, making
			// popup.closed unreliable. Rely on postMessage/storage/BroadcastChannel
			// delivery and an overall timeout instead.
			const POPUP_GRACE_PERIOD_MS = 10_000;
			const POPUP_OVERALL_TIMEOUT_MS = 2 * 60_000;
			const popupOpenedAt = Date.now();
			popupCheckRef.current = setInterval(() => {
				// If the popup closes before we even navigate to the provider, it's a real
				// popup blocker/user-close signal (not COOP). Fail fast with a clear message.
				try {
					if (!popupNavigatedRef.current && popup.closed) {
						cleanupOAuthListeners();
						toast.error("Authorization popup was closed.", {
							description:
								"Please allow popups for this site, or continue authorization in this tab.",
							action: {
								label: "Continue in this tab",
								onClick: () => {
									void (async () => {
										try {
											saveOAuth2Pending({
												state: startResult.state,
												pieceName: selectedPiece.name,
												displayName: resolvedDisplayName,
												clientId: startResult.clientId,
												redirectUrl: startResult.redirectUrl,
												codeVerifier: startResult.codeVerifier,
												scope: startResult.scope,
												props: oauthProps,
												authorizationMethod:
													oauth2AuthConfig?.authorizationMethod as
														| OAuth2AuthorizationMethod
														| undefined,
											});
											window.location.assign(startResult.authorizationUrl);
										} catch {
											/* ignore */
										}
									})();
								},
							},
						});
						setOauthConnecting(false);
						return;
					}
				} catch {
					/* ignore */
				}

				if (Date.now() - popupOpenedAt >= POPUP_OVERALL_TIMEOUT_MS) {
					cleanupOAuthListeners();
					toast.error(
						"Authorization timed out. Ensure your OAuth app has the correct redirect URI configured.",
					);
					setOauthConnecting(false);
					return;
				}

				if (Date.now() - popupOpenedAt < POPUP_GRACE_PERIOD_MS) {
					try {
						const stored = localStorage.getItem(storageKey);
						if (stored) {
							const d = JSON.parse(stored);
							processCallbackResult(d);
						}
					} catch {
						/* ok */
					}
					return;
				}

				// After grace period, keep polling localStorage in case storage events
				// or BroadcastChannel delivery are blocked by the environment.
				try {
					const stored = localStorage.getItem(storageKey);
					if (stored) {
						const d = JSON.parse(stored);
						processCallbackResult(d);
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

	// ---------------------------------------------------------------------------
	// Piece property field renderer
	// ---------------------------------------------------------------------------
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

		const dn = "displayName" in property ? property.displayName : propKey;
		const desc = "description" in property ? property.description : undefined;

		switch (property.type) {
			case PiecePropertyType.SECRET_TEXT:
				return (
					<div className="space-y-2" key={propKey}>
						<Label htmlFor={propKey}>{dn}</Label>
						<Input
							disabled={saving || oauthConnecting}
							id={propKey}
							onChange={(e) => onChange(e.target.value)}
							placeholder={desc || `Enter ${dn.toLowerCase()}`}
							type="password"
							value={String(value ?? "")}
						/>
						{desc && <p className="text-muted-foreground text-xs">{desc}</p>}
					</div>
				);
			case PiecePropertyType.LONG_TEXT:
				return (
					<div className="space-y-2" key={propKey}>
						<Label htmlFor={propKey}>{dn}</Label>
						<Textarea
							disabled={saving || oauthConnecting}
							id={propKey}
							onChange={(e) => onChange(e.target.value)}
							placeholder={desc || `Enter ${dn.toLowerCase()}`}
							rows={3}
							value={String(value ?? "")}
						/>
						{desc && <p className="text-muted-foreground text-xs">{desc}</p>}
					</div>
				);
			case PiecePropertyType.NUMBER:
				return (
					<div className="space-y-2" key={propKey}>
						<Label htmlFor={propKey}>{dn}</Label>
						<Input
							id={propKey}
							onChange={(e) => onChange(Number(e.target.value))}
							placeholder={desc || `Enter ${dn.toLowerCase()}`}
							type="number"
							value={value != null ? String(value) : ""}
						/>
						{desc && <p className="text-muted-foreground text-xs">{desc}</p>}
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
							{dn}
						</Label>
					</div>
				);
			case PiecePropertyType.STATIC_DROPDOWN:
				return (
					<div className="space-y-2" key={propKey}>
						<Label htmlFor={propKey}>{dn}</Label>
						<Select
							onValueChange={(val) => onChange(val)}
							value={typeof value === "string" ? value : undefined}
						>
							<SelectTrigger id={propKey}>
								<SelectValue
									placeholder={
										property.options?.placeholder ||
										`Select ${dn.toLowerCase()}`
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
						{desc && <p className="text-muted-foreground text-xs">{desc}</p>}
					</div>
				);
			case PiecePropertyType.SHORT_TEXT:
			default:
				return (
					<div className="space-y-2" key={propKey}>
						<Label htmlFor={propKey}>{dn}</Label>
						<Input
							id={propKey}
							onChange={(e) => onChange(e.target.value)}
							placeholder={desc || `Enter ${dn.toLowerCase()}`}
							value={String(value ?? "")}
						/>
						{desc && <p className="text-muted-foreground text-xs">{desc}</p>}
					</div>
				);
		}
	};

	// ---------------------------------------------------------------------------
	// Render helpers
	// ---------------------------------------------------------------------------
	const handleSelectPiece = (piece: PieceMetadataSummary) => {
		setSelectedPiece(piece);
		setDisplayName(`${piece.displayName} Connection`);
		setConfig({});
		setCustomProps({});
		setOauthProps({});
		setStep(2);
	};

	const handleBack = () => {
		if (preselectedPiece) {
			onOpenChange(false);
		} else {
			setStep(1);
			setSelectedPiece(null);
		}
	};

	// ---------------------------------------------------------------------------
	// Step 1: Piece Selector
	// ---------------------------------------------------------------------------
	const renderStep1 = () => (
		<>
			<DialogHeader>
				<DialogTitle>New Connection</DialogTitle>
				<DialogDescription>Select a service to connect</DialogDescription>
			</DialogHeader>
			<div className="space-y-3 py-2">
				<div className="relative">
					<Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						autoFocus
						className="pl-9"
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder="Search pieces..."
						value={searchQuery}
					/>
				</div>
				<div className="max-h-[400px] overflow-y-auto">
					{piecesLoading ? (
						<div className="flex items-center justify-center py-8">
							<Loader2 className="size-6 animate-spin text-muted-foreground" />
						</div>
					) : filteredPieces.length === 0 ? (
						<p className="py-8 text-center text-muted-foreground text-sm">
							No pieces found
						</p>
					) : (
						<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
							{filteredPieces.map((piece) => (
								<button
									className="flex flex-col items-center gap-2 rounded-lg border p-3 text-center text-sm transition-colors hover:bg-muted/50"
									key={piece.id}
									onClick={() => handleSelectPiece(piece)}
									type="button"
								>
									{piece.logoUrl ? (
										<img
											alt={piece.displayName}
											className="size-8 rounded"
											src={piece.logoUrl}
										/>
									) : (
										<div className="flex size-8 items-center justify-center rounded bg-muted text-xs font-medium">
											{piece.displayName.charAt(0)}
										</div>
									)}
									<span className="line-clamp-2 text-xs font-medium">
										{piece.displayName}
									</span>
								</button>
							))}
						</div>
					)}
				</div>
			</div>
		</>
	);

	// ---------------------------------------------------------------------------
	// Step 2: Auth Form
	// ---------------------------------------------------------------------------
	const renderStep2 = () => {
		if (!selectedPiece) return null;

		if (authLoading) {
			return (
				<>
					<DialogHeader>
						<DialogTitle>Connect {selectedPiece.displayName}</DialogTitle>
						<DialogDescription>Loading auth configuration...</DialogDescription>
					</DialogHeader>
					<div className="flex items-center justify-center py-8">
						<Loader2 className="size-6 animate-spin text-muted-foreground" />
					</div>
				</>
			);
		}

		return (
			<>
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						{selectedPiece.logoUrl && (
							<img
								alt=""
								className="size-5 rounded"
								src={selectedPiece.logoUrl}
							/>
						)}
						Connect {selectedPiece.displayName}
					</DialogTitle>
					<DialogDescription>
						{isOAuth2 ? "Connect via OAuth2" : "Enter credentials"}
					</DialogDescription>
				</DialogHeader>

				<div className="max-h-[500px] space-y-4 overflow-y-auto py-2">
					{/* Connection name */}
					<div className="space-y-2">
						<Label htmlFor="connection-name">Connection Name</Label>
						<Input
							id="connection-name"
							onChange={(e) => setDisplayName(e.target.value)}
							placeholder={`${selectedPiece.displayName} Connection`}
							value={displayName}
						/>
					</div>

					{/* Auth method selector for multi-auth pieces */}
					{authConfigs.length > 1 && (
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
					)}

					{/* Setup instructions */}
					{selectedAuthConfig?.description && (
						<AuthSetupInstructions
							description={selectedAuthConfig.description}
						/>
					)}

					{/* Auth-type specific fields */}
					{isOAuth2 ? (
						<>
							{platformOAuthApp ? (
								<div className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
									OAuth credentials configured by your administrator.
								</div>
							) : (
								<div className="rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200">
									OAuth app not configured for this piece. Ask your
									administrator to set it up in Settings.
								</div>
							)}
							{/* Extra OAuth2 props */}
							{platformOAuthApp &&
								oauth2AuthConfig?.props &&
								Object.entries(oauth2AuthConfig.props).map(([key, prop]) =>
									renderPiecePropertyField({
										propKey: key,
										property: prop,
										value: oauthProps[key],
										onChange: (val) =>
											setOauthProps((prev) => ({ ...prev, [key]: val })),
									}),
								)}
							{/* Scopes display */}
							{oauth2AuthConfig?.scope && oauth2AuthConfig.scope.length > 0 && (
								<div className="space-y-1">
									<Label className="text-muted-foreground text-xs">
										Scopes
									</Label>
									<p className="rounded-md bg-muted/50 px-3 py-2 font-mono text-xs">
										{oauth2AuthConfig.scope.join(", ")}
									</p>
								</div>
							)}
						</>
					) : selectedAuthConfig?.type === PieceAuthType.SECRET_TEXT ? (
						<div className="space-y-2">
							<Label htmlFor="secret_text">
								{selectedAuthConfig.displayName || "API Key"}
							</Label>
							<Input
								disabled={saving}
								id="secret_text"
								onChange={(e) => updateConfig("secret_text", e.target.value)}
								placeholder="Enter your API key"
								type="password"
								value={config.secret_text || ""}
							/>
							{selectedAuthConfig.description && (
								<p className="text-muted-foreground text-xs">
									{selectedAuthConfig.description}
								</p>
							)}
						</div>
					) : selectedAuthConfig?.type === PieceAuthType.BASIC_AUTH ? (
						<>
							<div className="space-y-2">
								<Label htmlFor="username">
									{selectedAuthConfig.username?.displayName || "Username"}
								</Label>
								<Input
									disabled={saving}
									id="username"
									onChange={(e) => updateConfig("username", e.target.value)}
									placeholder={
										selectedAuthConfig.username?.description || "Enter username"
									}
									value={config.username || ""}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="password">
									{selectedAuthConfig.password?.displayName || "Password"}
								</Label>
								<Input
									disabled={saving}
									id="password"
									onChange={(e) => updateConfig("password", e.target.value)}
									placeholder={
										selectedAuthConfig.password?.description || "Enter password"
									}
									type="password"
									value={config.password || ""}
								/>
							</div>
						</>
					) : selectedAuthConfig?.type === PieceAuthType.CUSTOM_AUTH ? (
						<div className="space-y-4">
							{Object.entries(selectedAuthConfig.props ?? {}).map(
								([key, prop]) =>
									renderPiecePropertyField({
										propKey: key,
										property: prop,
										value: customProps[key],
										onChange: (val) =>
											setCustomProps((prev) => ({ ...prev, [key]: val })),
									}),
							)}
						</div>
					) : null}
				</div>

				<DialogFooter className="gap-2 sm:gap-0">
					<Button onClick={handleBack} type="button" variant="outline">
						<ArrowLeft className="mr-2 size-4" />
						Back
					</Button>
					{isOAuth2 ? (
						<Button
							disabled={oauthConnecting || !platformOAuthApp}
							onClick={handleOAuth2Connect}
						>
							<ExternalLink className="mr-2 size-4" />
							{oauthConnecting
								? "Waiting for authorization..."
								: `Connect with ${selectedPiece.displayName}`}
						</Button>
					) : (
						<Button disabled={saving} onClick={handleSaveNonOAuth}>
							{saving && <Loader2 className="mr-2 size-4 animate-spin" />}
							Save
						</Button>
					)}
				</DialogFooter>
			</>
		);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl">
				{step === 1 ? renderStep1() : renderStep2()}
			</DialogContent>
		</Dialog>
	);
}
