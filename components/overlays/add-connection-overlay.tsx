"use client";

import { ExternalLink, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IntegrationIcon } from "@/components/ui/integration-icon";
import { Label } from "@/components/ui/label";
import { useIsMobile } from "@/hooks/use-mobile";
import { api } from "@/lib/api-client";
import { AppConnectionType } from "@/lib/types/app-connection";
import type { PluginType } from "@/plugins/registry";
import {
  getIntegration,
  getIntegrationLabels,
  getSortedPluginTypes,
} from "@/plugins";
import { getIntegrationDescriptions } from "@/plugins/registry";
import { ConfirmOverlay } from "./confirm-overlay";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";

type PieceAuthConfig = {
  type?: string;
  authUrl?: string;
  tokenUrl?: string;
  scope?: string[];
  displayName?: string;
  description?: string;
};

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
      <div className="border-t px-3 py-2 space-y-1">
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
        <strong key={match.index} className="font-semibold text-foreground">
          {match[1]}
        </strong>
      );
    } else if (match[2] && match[3]) {
      // Link
      parts.push(
        <a
          key={match.index}
          href={match[3]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline"
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
  const [authConfig, setAuthConfig] = useState<PieceAuthConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.piece
      .get(pieceName)
      .then((piece) => {
        if (!cancelled && piece?.auth) {
          const auth = piece.auth as PieceAuthConfig;
          setAuthConfig(auth);
        }
      })
      .catch(() => {
        // Piece not in metadata — fall back to plugin formFields
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pieceName]);

  return { authConfig, loading };
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

  // Fetch piece auth config from synced metadata
  const { authConfig, loading: authLoading } = usePieceAuth(type);
  const isOAuth2 = authConfig?.type === "OAUTH2";

  const updateConfig = (key: string, value: string) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  // --- SECRET_TEXT save flow ---
  const doSaveSecretText = async () => {
    try {
      setSaving(true);
      const name = displayName.trim() || getLabel(type);
      const newConnection = await api.appConnection.upsert({
        externalId: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        displayName: name,
        pieceName: type,
        projectId: "default",
        value: {
          type: AppConnectionType.SECRET_TEXT,
          secret_text:
            Object.values(config).find((v) => v && v.length > 0) || "",
        },
        type: AppConnectionType.SECRET_TEXT,
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

  const handleSaveSecretText = async () => {
    const hasConfig = Object.values(config).some((v) => v && v.length > 0);
    if (!hasConfig) {
      toast.error("Please enter credentials");
      return;
    }

    try {
      setSaving(true);
      setTestResult(null);

      const result = await api.appConnection.test({
        pieceName: type,
        value: {
          type: AppConnectionType.SECRET_TEXT,
          secret_text:
            Object.values(config).find((v) => v && v.length > 0) || "",
        },
        type: AppConnectionType.SECRET_TEXT,
      });

      if (result.status === "error") {
        push(ConfirmOverlay, {
          title: "Connection Test Failed",
          message: `The test failed: ${result.message}\n\nDo you want to save anyway?`,
          confirmLabel: "Save Anyway",
          onConfirm: async () => {
            await doSaveSecretText();
          },
        });
        setSaving(false);
        return;
      }

      await doSaveSecretText();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to test connection";
      push(ConfirmOverlay, {
        title: "Connection Test Failed",
        message: `${message}\n\nDo you want to save anyway?`,
        confirmLabel: "Save Anyway",
        onConfirm: async () => {
          await doSaveSecretText();
        },
      });
      setSaving(false);
    }
  };

  const handleTest = async () => {
    const hasConfig = Object.values(config).some((v) => v && v.length > 0);
    if (!hasConfig) {
      toast.error("Please enter credentials first");
      return;
    }

    try {
      setTesting(true);
      setTestResult(null);
      const result = await api.appConnection.test({
        pieceName: type,
        value: {
          type: AppConnectionType.SECRET_TEXT,
          secret_text:
            Object.values(config).find((v) => v && v.length > 0) || "",
        },
        type: AppConnectionType.SECRET_TEXT,
      });
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
    clientSecret: string;
    redirectUrl: string;
    codeVerifier: string;
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

  useEffect(() => {
    return () => {
      cleanupOAuthListeners();
      closeOAuthPopup();
      processingRef.current = false;
    };
  }, [cleanupOAuthListeners, closeOAuthPopup]);

  const handleOAuth2Connect = async () => {
    const clientId = config.clientId?.trim();
    const clientSecret = config.clientSecret?.trim();
    if (!clientId || !clientSecret) {
      toast.error("Please enter Client ID and Client Secret");
      return;
    }

    try {
      setOauthConnecting(true);
      processingRef.current = false;
      const redirectUrl = `${window.location.origin}/api/app-connections/oauth2/callback`;

      // Start OAuth2 flow — get authorization URL with PKCE
      const startResult = await api.appConnection.oauth2Start({
        pieceName: type,
        clientId,
        redirectUrl,
      });

      // Store OAuth state in ref so it survives across the async popup flow
      oauthStateRef.current = {
        clientId,
        clientSecret,
        redirectUrl,
        codeVerifier: startResult.codeVerifier,
        scope: authConfig?.scope?.join(" ") ?? "",
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
      try { localStorage.removeItem("oauth2_callback_result"); } catch { /* ok */ }

      // Shared handler: processes the OAuth callback result from either channel
      const processCallbackResult = async (data: Record<string, unknown>) => {
        if (processingRef.current) return;

        if (data.error) {
          processingRef.current = true;
          cleanupOAuthListeners();
          closeOAuthPopup();
          const desc = (data.errorDescription || data.error || "Unknown error") as string;
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
        try { localStorage.removeItem("oauth2_callback_result"); } catch { /* ok */ }

        const code = decodeURIComponent(data.code as string);
        const oauthState = oauthStateRef.current;
        if (!oauthState) {
          toast.error("OAuth state lost — please try again");
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
            type: AppConnectionType.OAUTH2,
            value: {
              type: AppConnectionType.OAUTH2,
              client_id: oauthState.clientId,
              client_secret: oauthState.clientSecret,
              redirect_url: oauthState.redirectUrl,
              code,
              scope: oauthState.scope,
              code_verifier: oauthState.codeVerifier,
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
        if (!redirectUrl || !redirectUrl.startsWith(event.origin)) return;
        const data = event.data;
        if (!data || typeof data !== "object") return;
        if (!data.code && !data.error) return;
        processCallbackResult(data);
      };
      messageHandlerRef.current = messageHandler;
      window.addEventListener("message", messageHandler);

      // Channel 2: localStorage (fallback for COOP — Google OAuth sets
      // Cross-Origin-Opener-Policy: same-origin which severs window.opener)
      const storageHandler = (event: StorageEvent) => {
        if (event.key !== "oauth2_callback_result" || !event.newValue) return;
        try {
          const data = JSON.parse(event.newValue);
          processCallbackResult(data);
        } catch {
          // ignore malformed data
        }
      };
      storageHandlerRef.current = storageHandler;
      window.addEventListener("storage", storageHandler);

      // Poll for popup close (COOP may block popup.closed, so wrap in try/catch)
      popupCheckRef.current = setInterval(() => {
        try {
          if (popup.closed && !processingRef.current) {
            // Also check localStorage one final time (storage event may have
            // fired before our listener was ready, or in same-tab scenario)
            try {
              const stored = localStorage.getItem("oauth2_callback_result");
              if (stored) {
                const data = JSON.parse(stored);
                processCallbackResult(data);
                return;
              }
            } catch { /* ok */ }

            cleanupOAuthListeners();
            toast.error(
              "Authorization window was closed. If Google showed an error, ensure your app has the correct redirect URI and your account is listed as a test user."
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

    if (!formFields) return null;

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

  // Render OAuth2 fields
  const renderOAuth2Fields = () => (
    <>
      <SecretField
        configKey="clientId"
        fieldId="clientId"
        helpText="From your OAuth app settings"
        label="Client ID"
        onChange={updateConfig}
        placeholder="Your OAuth2 Client ID"
        value={config.clientId || ""}
      />
      <SecretField
        configKey="clientSecret"
        fieldId="clientSecret"
        helpText="From your OAuth app settings"
        label="Client Secret"
        onChange={updateConfig}
        placeholder="Your OAuth2 Client Secret"
        value={config.clientSecret || ""}
      />
      {authConfig?.scope && authConfig.scope.length > 0 && (
        <div className="space-y-1">
          <Label className="text-muted-foreground text-xs">Scopes</Label>
          <p className="rounded-md bg-muted/50 px-3 py-2 font-mono text-xs">
            {authConfig.scope.join(", ")}
          </p>
        </div>
      )}
      <Button
        className="w-full"
        disabled={oauthConnecting}
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
          {authConfig?.description && (
            <AuthSetupInstructions description={authConfig.description} />
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

  // SECRET_TEXT mode — existing behavior
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
        { label: "Create", onClick: handleSaveSecretText, loading: saving },
      ]}
      overlayId={overlayId}
      title={`Add ${getLabel(type)}`}
    >
      <p className="-mt-2 mb-4 text-muted-foreground text-sm">
        Enter your credentials
      </p>

      <div className="space-y-4">
        {renderSecretTextFields()}

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
