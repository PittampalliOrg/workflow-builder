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

type AddConnectionOverlayProps = {
  overlayId: string;
  onSuccess?: (connectionId: string) => void;
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
  onSuccess?: (connectionId: string) => void;
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
      onSuccess?.(newConnection.id);
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

  // --- OAuth2 flow ---
  const popupRef = useRef<Window | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const processingRef = useRef(false);

  const cleanupOAuthPopup = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.close();
    }
    popupRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      cleanupOAuthPopup();
      processingRef.current = false;
    };
  }, [cleanupOAuthPopup]);

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

      // Open popup for authorization
      const popup = window.open(
        startResult.authorizationUrl,
        "oauth2-popup",
        "width=600,height=700,menubar=no,toolbar=no,location=yes,status=no"
      );

      if (!popup) {
        toast.error("Popup blocked. Please allow popups for this site.");
        setOauthConnecting(false);
        return;
      }

      popupRef.current = popup;

      // Poll for the popup to complete (callback page sets the code)
      pollRef.current = setInterval(async () => {
        // Guard against re-entry while async save is in progress
        if (processingRef.current) return;

        try {
          if (!popup || popup.closed) {
            cleanupOAuthPopup();
            setOauthConnecting(false);
            return;
          }

          // Try to read the popup URL (same-origin callback)
          let callbackUrl: URL;
          try {
            callbackUrl = new URL(popup.location.href);
          } catch {
            // Cross-origin — still on the provider's page
            return;
          }

          // Check if we're back on our callback URL
          if (!callbackUrl.pathname.includes("/oauth2/callback")) {
            return;
          }

          // Prevent re-entry and stop polling immediately
          processingRef.current = true;
          cleanupOAuthPopup();

          const code = callbackUrl.searchParams.get("code");
          const error = callbackUrl.searchParams.get("error");

          if (error) {
            const desc =
              callbackUrl.searchParams.get("error_description") || error;
            toast.error(`OAuth2 failed: ${desc}`);
            setOauthConnecting(false);
            processingRef.current = false;
            return;
          }

          if (!code) {
            toast.error("No authorization code received");
            setOauthConnecting(false);
            processingRef.current = false;
            return;
          }

          // Save the connection with the OAuth2 code
          const name = displayName.trim() || getLabel(type);
          const newConnection = await api.appConnection.upsert({
            externalId: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
            displayName: name,
            pieceName: type,
            projectId: "default",
            type: AppConnectionType.OAUTH2,
            value: {
              type: AppConnectionType.OAUTH2,
              client_id: clientId,
              client_secret: clientSecret,
              redirect_url: redirectUrl,
              code,
              scope: authConfig?.scope?.join(" ") ?? "",
              code_challenge: startResult.codeChallenge,
            },
          });

          toast.success("Connection created via OAuth2");
          onSuccess?.(newConnection.id);
          closeAll();
        } catch {
          // polling error — ignore until popup closes
        }
      }, 500);
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
