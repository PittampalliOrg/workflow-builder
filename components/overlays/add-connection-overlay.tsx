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
import { api, type OAuthAppSummary } from "@/lib/api-client";
import {
  AppConnectionType,
  OAuth2GrantType,
  type UpsertAppConnectionRequestBody,
} from "@/lib/types/app-connection";
import {
  type PieceAuthConfig,
  type PieceAuthProperty,
  PieceAuthType,
  PiecePropertyType,
  parsePieceAuthAll,
} from "@/lib/types/piece-auth";
import {
  getIntegration,
  getIntegrationLabels,
  getSortedPluginTypes,
} from "@/plugins";
import type { PluginType } from "@/plugins/registry";
import { getIntegrationDescriptions } from "@/plugins/registry";
import { ConfirmOverlay } from "./confirm-overlay";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";

// System integrations that don't have plugins
const SYSTEM_INTEGRATION_TYPES: PluginType[] = ["database"];
const SYSTEM_INTEGRATION_LABELS: Record<string, string> = {
  database: "Database",
};
const SYSTEM_INTEGRATION_DESCRIPTIONS: Record<string, string> = {
  database: "Connect to PostgreSQL databases",
};

// Get all integration types (plugins + system)
const getPluginTypes = (): PluginType[] => [
  ...getSortedPluginTypes(),
  ...SYSTEM_INTEGRATION_TYPES,
];

// Get label for any integration type
const getLabel = (type: PluginType): string =>
  getIntegrationLabels()[type] || SYSTEM_INTEGRATION_LABELS[type] || type;

// Get description for any integration type
const getDescription = (type: PluginType): string =>
  getIntegrationDescriptions()[type] ||
  SYSTEM_INTEGRATION_DESCRIPTIONS[type] ||
  "";

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
          <MarkdownLine key={`${line.trim()}-${i}`} text={line.trim()} />
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
  while (true) {
    const match = regex.exec(text);
    if (!match) {
      break;
    }
    // Text before this match
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[1]) {
      // Bold
      parts.push(
        <strong className="font-semibold text-foreground" key={match.index}>
          {match[1]}
        </strong>
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
        </a>
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
};

/**
 * Overlay for selecting a connection type to add
 */
export function AddConnectionOverlay({
  overlayId,
  onSuccess,
}: AddConnectionOverlayProps) {
  const { push } = useOverlay();
  const [searchQuery, setSearchQuery] = useState("");
  const isMobile = useIsMobile();

  const integrationTypes = getPluginTypes();

  const filteredTypes = useMemo(() => {
    if (!searchQuery.trim()) {
      return integrationTypes;
    }
    const query = searchQuery.toLowerCase();
    return integrationTypes.filter((type) =>
      getLabel(type).toLowerCase().includes(query)
    );
  }, [integrationTypes, searchQuery]);

  const handleSelectType = (type: PluginType) => {
    push(ConfigureConnectionOverlay, { type, onSuccess });
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
        <div className="max-h-[300px] space-y-1 overflow-y-auto">
          {filteredTypes.length === 0 ? (
            <p className="py-4 text-center text-muted-foreground text-sm">
              No services found
            </p>
          ) : (
            filteredTypes.map((type) => {
              const description = getDescription(type);
              return (
                <button
                  className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50"
                  key={type}
                  onClick={() => handleSelectType(type)}
                  type="button"
                >
                  <IntegrationIcon
                    className="size-5 shrink-0"
                    integration={type}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{getLabel(type)}</span>
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
  type: PluginType;
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

  useEffect(() => {
    let cancelled = false;
    api.piece
      .get(pieceName)
      .then((piece) => {
        if (!cancelled) {
          const configs = parsePieceAuthAll(piece?.auth) as ParsedAuthConfig[];
          setAuthConfigs(configs);
          setSelectedAuthIndex(0);
        }
      })
      .catch(() => {
        // Piece not in metadata — fall back to plugin formFields
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
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
  };
}

/**
 * Overlay for configuring a new connection.
 * Dynamically renders SECRET_TEXT or OAuth2 form based on piece metadata.
 */
export function ConfigureConnectionOverlay({
  overlayId,
  type,
  onSuccess,
}: ConfigureConnectionOverlayProps) {
  const { push, closeAll } = useOverlay();
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [_testResult, setTestResult] = useState<{
    status: "success" | "error";
    message: string;
  } | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [oauthConnecting, setOauthConnecting] = useState(false);
  const [oauthProps, setOauthProps] = useState<Record<string, unknown>>({});
  const [customProps, setCustomProps] = useState<Record<string, unknown>>({});
  const [_oauthGrantType, setOauthGrantType] = useState<OAuth2GrantType>(
    OAuth2GrantType.AUTHORIZATION_CODE
  );

  // Platform OAuth apps
  const [oauthApps, setOauthApps] = useState<OAuthAppSummary[]>([]);
  useEffect(() => {
    api.oauthApp
      .list()
      .then(setOauthApps)
      .catch(() => {});
  }, []);
  const platformOAuthApp = useMemo(
    () => oauthApps.find((a) => a.pieceName === type) ?? null,
    [oauthApps, type]
  );

  // Fetch piece auth config from synced metadata
  const {
    authConfigs,
    selectedAuthConfig,
    selectedAuthIndex,
    setSelectedAuthIndex,
    loading: authLoading,
  } = usePieceAuth(type);
  const isOAuth2 = selectedAuthConfig?.type === PieceAuthType.OAUTH2;
  const oauth2AuthConfig = isOAuth2
    ? (selectedAuthConfig as Extract<
        Exclude<PieceAuthConfig, null | undefined>,
        { type: PieceAuthType.OAUTH2 }
      >)
    : null;

  const _supportsClientCredentials =
    oauth2AuthConfig?.grantType === OAuth2GrantType.CLIENT_CREDENTIALS ||
    oauth2AuthConfig?.grantType ===
      "both_client_credentials_and_authorization_code";
  const _supportsAuthCode =
    oauth2AuthConfig?.grantType !== OAuth2GrantType.CLIENT_CREDENTIALS;

  useEffect(() => {
    // Keep grant type in sync with what the piece declares.
    if (!oauth2AuthConfig) {
      return;
    }
    if (oauth2AuthConfig.grantType === OAuth2GrantType.CLIENT_CREDENTIALS) {
      setOauthGrantType(OAuth2GrantType.CLIENT_CREDENTIALS);
      return;
    }
    setOauthGrantType(OAuth2GrantType.AUTHORIZATION_CODE);
  }, [oauth2AuthConfig]);

  const updateConfig = (key: string, value: string) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const connectionLabel = displayName.trim() || getLabel(type);
  const connectionExternalId = useMemo(
    () => connectionLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    [connectionLabel]
  );

  const getFirstNonEmptyConfigValue = (): string =>
    Object.values(config).find((v) => v && v.length > 0) || "";

  const buildUpsertBody = (): UpsertAppConnectionRequestBody | null => {
    const base = {
      externalId: connectionExternalId,
      displayName: connectionLabel,
      pieceName: type,
      projectId: "default",
    } as const;

    // If piece auth isn't known (not synced), fall back to existing SECRET_TEXT behavior.
    if (!selectedAuthConfig) {
      const secret_text = getFirstNonEmptyConfigValue();
      if (!secret_text) {
        return null;
      }
      return {
        ...base,
        type: AppConnectionType.SECRET_TEXT,
        value: {
          type: AppConnectionType.SECRET_TEXT,
          secret_text,
        },
      };
    }

    switch (selectedAuthConfig.type) {
      case PieceAuthType.SECRET_TEXT: {
        const secret_text =
          config.secret_text?.trim() || getFirstNonEmptyConfigValue();
        if (!secret_text) {
          return null;
        }
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
        if (!(username && password)) {
          return null;
        }
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
          (k) => customProps[k] == null || customProps[k] === ""
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
      setTestResult(null);

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
      setTestResult(null);
      const result = await api.appConnection.test(body);
      setTestResult(result);
      if (result.status === "success") {
        toast.success(result.message || "Connection successful");
      } else {
        toast.error(result.message || "Connection failed");
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Connection test failed";
      setTestResult({ status: "error", message });
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

  const closeOAuthPopup = useCallback(() => {
    try {
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.close();
      }
    } catch {
      // COOP may block access to popup.closed
    }
    popupRef.current = null;
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
    [cleanupOAuthListeners, closeOAuthPopup]
  );

  const handleOAuth2Connect = async () => {
    try {
      setOauthConnecting(true);
      processingRef.current = false;

      // Start OAuth2 flow — server fetches platform clientId from oauth_apps table
      const startResult = await api.appConnection.oauth2Start({
        pieceName: type,
        props: oauthProps,
      });

      const redirectUrl = `${window.location.origin}/api/app-connections/oauth2/callback`;
      const storageKey = `oauth2_callback_result:${startResult.state}`;

      // Store OAuth state in ref so it survives across the async popup flow
      oauthStateRef.current = {
        clientId: startResult.clientId,
        redirectUrl,
        codeVerifier: startResult.codeVerifier,
        state: startResult.state,
        storageKey,
        scope: oauth2AuthConfig?.scope?.join(" ") ?? "",
      };

      // Close any existing popup first (matches AP: closeOAuth2Popup() before open)
      closeOAuthPopup();

      // Open popup for authorization (AP uses '_blank' target with similar features)
      const popup = window.open(
        startResult.authorizationUrl,
        "_blank",
        "resizable=no,toolbar=no,left=100,top=100,scrollbars=no,menubar=no,status=no,directories=no,location=no,width=600,height=800"
      );

      if (!popup) {
        toast.error("Popup blocked. Please allow popups for this site.");
        setOauthConnecting(false);
        return;
      }

      popupRef.current = popup;

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
        if (processingRef.current) {
          return;
        }

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

        if (!data.code) {
          return;
        }

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
          toast.error("OAuth state lost — please try again");
          setOauthConnecting(false);
          processingRef.current = false;
          return;
        }
        if (oauthState.state !== returnedState) {
          toast.error("OAuth state mismatch — please try again");
          setOauthConnecting(false);
          processingRef.current = false;
          return;
        }

        try {
          const name = displayName.trim() || getLabel(type);
          const newConnection = await api.appConnection.upsert({
            externalId: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
            displayName: name,
            pieceName: type,
            projectId: "default",
            type: AppConnectionType.PLATFORM_OAUTH2,
            value: {
              type: AppConnectionType.PLATFORM_OAUTH2,
              client_id: oauthState.clientId,
              redirect_url: oauthState.redirectUrl,
              code,
              scope: oauthState.scope,
              code_verifier: oauthState.codeVerifier,
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
            err instanceof Error ? err.message : "Failed to save connection"
          );
          setOauthConnecting(false);
          processingRef.current = false;
        }
      };

      // Channel 1: postMessage (works when COOP doesn't block window.opener)
      const messageHandler = (event: MessageEvent) => {
        if (!redirectUrl?.startsWith(event.origin)) {
          return;
        }
        const data = event.data;
        if (!data || typeof data !== "object") {
          return;
        }
        if (!(data.code || data.error)) {
          return;
        }
        processCallbackResult(data);
      };
      messageHandlerRef.current = messageHandler;
      window.addEventListener("message", messageHandler);

      // Channel 2: localStorage (fallback for COOP — Google OAuth sets
      // Cross-Origin-Opener-Policy: same-origin which severs window.opener)
      const storageHandler = (event: StorageEvent) => {
        if (!event.newValue) {
          return;
        }
        if (
          event.key !== storageKey &&
          event.key !== "oauth2_callback_result"
        ) {
          return;
        }
        try {
          const data = JSON.parse(event.newValue);
          processCallbackResult(data);
        } catch {
          // ignore malformed data
        }
      };
      storageHandlerRef.current = storageHandler;
      window.addEventListener("storage", storageHandler);

      // Poll for popup close with a grace period.
      // COOP (Cross-Origin-Opener-Policy) from OAuth providers (Google, Microsoft)
      // severs the popup reference, causing popup.closed to return true immediately.
      // Tiling WMs (Sway, i3) may also close/reparent popup windows unexpectedly.
      // We delay the close check so these false positives don't abort the flow.
      // The callback will still arrive via postMessage or localStorage.
      const POPUP_GRACE_PERIOD_MS = 10_000;
      const popupOpenedAt = Date.now();
      popupCheckRef.current = setInterval(() => {
        // During grace period, only check localStorage for early callbacks
        if (Date.now() - popupOpenedAt < POPUP_GRACE_PERIOD_MS) {
          try {
            const stored = localStorage.getItem("oauth2_callback_result");
            if (stored) {
              const data = JSON.parse(stored);
              processCallbackResult(data);
            }
          } catch {
            /* ok */
          }
          return;
        }

        try {
          if (popup.closed && !processingRef.current) {
            // Also check localStorage one final time (storage event may have
            // fired before our listener was ready, or in same-tab scenario)
            try {
              const stored =
                localStorage.getItem(storageKey) ??
                localStorage.getItem("oauth2_callback_result");
              if (stored) {
                const data = JSON.parse(stored);
                processCallbackResult(data);
                return;
              }
            } catch {
              /* ok */
            }

            cleanupOAuthListeners();
            toast.error(
              "Authorization window was closed. Ensure your OAuth app has the correct redirect URI configured."
            );
            setOauthConnecting(false);
          }
        } catch {
          // COOP blocks popup.closed — can't detect close, just keep waiting
        }
      }, 1000);
    } catch (error) {
      console.error("OAuth2 start failed:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to start OAuth2 flow"
      );
      setOauthConnecting(false);
    }
  };

  // Get plugin form fields as fallback
  const plugin = getIntegration(type);
  const formFields = plugin?.formFields;

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

    if (type === "database") {
      return (
        <SecretField
          configKey="url"
          fieldId="url"
          helpText="Connection string in the format: postgresql://user:password@host:port/database"
          label="Database URL"
          onChange={updateConfig}
          placeholder="postgresql://user:password@host:port/database"
          value={config.url || ""}
        />
      );
    }

    if (!formFields) {
      return null;
    }

    return formFields.map((field) => {
      if (field.type === "password") {
        return (
          <SecretField
            configKey={field.configKey}
            fieldId={field.id}
            helpLink={field.helpLink}
            helpText={field.helpText}
            key={field.id}
            label={field.label}
            onChange={updateConfig}
            placeholder={field.placeholder}
            value={config[field.configKey] || ""}
          />
        );
      }

      return (
        <div className="space-y-2" key={field.id}>
          <Label htmlFor={field.id}>{field.label}</Label>
          <Input
            id={field.id}
            onChange={(e) => updateConfig(field.configKey, e.target.value)}
            placeholder={field.placeholder}
            type={field.type}
            value={config[field.configKey] || ""}
          />
          {(field.helpText || field.helpLink) && (
            <p className="text-muted-foreground text-xs">
              {field.helpText}
              {field.helpLink && (
                <a
                  className="underline hover:text-foreground"
                  href={field.helpLink.url}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {field.helpLink.text}
                </a>
              )}
            </p>
          )}
        </div>
      );
    });
  };

  const renderAuthMethodSelect = () => {
    if (authConfigs.length <= 1) {
      return null;
    }

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
          })
        )}
      </div>
    );
  };

  const renderOAuth2PropsFields = () => {
    if (!oauth2AuthConfig?.props) {
      return null;
    }
    const entries = Object.entries(oauth2AuthConfig.props);
    if (entries.length === 0) {
      return null;
    }

    return (
      <div className="space-y-4">
        {entries.map(([key, prop]) =>
          renderPiecePropertyField({
            propKey: key,
            property: prop,
            value: oauthProps[key],
            onChange: (val) =>
              setOauthProps((prev) => ({ ...prev, [key]: val })),
          })
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
          : `Connect with ${getLabel(type)}`}
      </Button>
    </>
  );

  if (authLoading) {
    return (
      <Overlay overlayId={overlayId} title={`Add ${getLabel(type)}`}>
        <p className="py-8 text-center text-muted-foreground text-sm">
          Loading...
        </p>
      </Overlay>
    );
  }

  // OAuth2 mode — no Test/Create buttons, just the Connect button
  if (isOAuth2) {
    return (
      <Overlay overlayId={overlayId} title={`Add ${getLabel(type)}`}>
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
      title={`Add ${getLabel(type)}`}
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
