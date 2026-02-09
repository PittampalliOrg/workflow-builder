"use client";

import {
  ChevronDown,
  ChevronRight,
  Cloud,
  Key,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { IntegrationIcon } from "@/components/ui/integration-icon";
import { Spinner } from "@/components/ui/spinner";
import {
  api,
  type InfrastructureSecret,
  type InfrastructureSecretsResponse,
} from "@/lib/api-client";
import { cn } from "@/lib/utils";

type InfrastructureSecretsSectionProps = {
  /** Whether to show as collapsed by default */
  defaultCollapsed?: boolean;
  /** Filter by integration type (e.g., "openai", "github") */
  filterType?: string;
  /** Callback when a secret is selected */
  onSelect?: (secret: InfrastructureSecret) => void;
  /** Currently selected secret key */
  selectedKey?: string;
  /** Whether selection is allowed */
  selectable?: boolean;
};

export function InfrastructureSecretsSection({
  defaultCollapsed = true,
  filterType,
  onSelect,
  selectedKey,
  selectable = false,
}: InfrastructureSecretsSectionProps) {
  const [data, setData] = useState<InfrastructureSecretsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  const loadSecrets = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await api.secrets.getAvailable();
      setData(response);
    } catch (err) {
      console.error("Failed to load infrastructure secrets:", err);
      setError(err instanceof Error ? err.message : "Failed to load secrets");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSecrets();
  }, [loadSecrets]);

  // Filter secrets by type if specified
  const filteredSecrets =
    data?.secrets.filter((secret) => {
      if (!filterType) {
        return true;
      }
      return secret.integrationType === filterType;
    }) ?? [];

  // Group secrets by integration type for display
  const groupedSecrets = filteredSecrets.reduce<
    Record<string, InfrastructureSecret[]>
  >((acc, secret) => {
    const type = secret.integrationType;
    if (!acc[type]) {
      acc[type] = [];
    }
    acc[type].push(secret);
    return acc;
  }, {});

  if (loading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Spinner className="size-4" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-4 text-center text-muted-foreground text-sm">
        Failed to load infrastructure secrets
      </div>
    );
  }

  if (!data?.available) {
    return null;
  }

  const secretCount = filteredSecrets.length;
  const isConnected = data.secretStoreConnected;

  return (
    <div className="space-y-2">
      {/* Header */}
      <button
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/50"
        onClick={() => setCollapsed(!collapsed)}
        type="button"
      >
        {collapsed ? (
          <ChevronRight className="size-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-4 text-muted-foreground" />
        )}
        <Cloud className="size-4 text-blue-500" />
        <span className="font-medium">Infrastructure Secrets</span>
        <span className="text-muted-foreground">({secretCount})</span>
        {isConnected ? (
          <span className="ml-auto flex items-center gap-1 text-green-600 text-xs">
            <ShieldCheck className="size-3" />
            Connected
          </span>
        ) : (
          <span className="ml-auto text-muted-foreground text-xs">
            Not connected
          </span>
        )}
      </button>

      {/* Secret list */}
      {!collapsed && (
        <div className="ml-6 space-y-1">
          {secretCount === 0 ? (
            <div className="py-2 text-muted-foreground text-sm">
              No secrets available for this integration type
            </div>
          ) : filterType ? (
            // Show flat list when filtering by type
            filteredSecrets.map((secret) => (
              <SecretItem
                isConnected={isConnected}
                isSelected={selectedKey === secret.key}
                key={secret.key}
                onSelect={selectable ? () => onSelect?.(secret) : undefined}
                secret={secret}
              />
            ))
          ) : (
            // Show grouped list when showing all
            Object.entries(groupedSecrets).map(([type, secrets]) => (
              <div className="space-y-1" key={type}>
                <div className="flex items-center gap-2 px-2 py-1 text-muted-foreground text-xs">
                  <IntegrationIcon className="size-3" integration={type} />
                  <span className="uppercase tracking-wide">
                    {secrets[0].label}
                  </span>
                </div>
                {secrets.map((secret) => (
                  <SecretItem
                    isConnected={isConnected}
                    isSelected={selectedKey === secret.key}
                    key={secret.key}
                    onSelect={selectable ? () => onSelect?.(secret) : undefined}
                    secret={secret}
                  />
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

type SecretItemProps = {
  secret: InfrastructureSecret;
  isConnected: boolean;
  isSelected?: boolean;
  onSelect?: () => void;
};

function SecretItem({
  secret,
  isConnected,
  isSelected,
  onSelect,
}: SecretItemProps) {
  const content = (
    <>
      <Key className="size-3.5 text-amber-500" />
      <span className="flex-1 truncate font-mono text-xs">{secret.key}</span>
      <span className="text-muted-foreground text-xs">Key Vault</span>
      {isConnected && (
        <span className="size-2 rounded-full bg-green-500" title="Available" />
      )}
    </>
  );

  if (onSelect) {
    return (
      <button
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
          isSelected ? "bg-primary/10 text-primary" : "hover:bg-muted/50"
        )}
        onClick={onSelect}
        type="button"
      >
        {content}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
      {content}
    </div>
  );
}

/**
 * Hook to fetch infrastructure secrets for a specific integration type
 */
export function useInfrastructureSecrets(integrationType?: string) {
  const [data, setData] = useState<InfrastructureSecretsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError(null);
        const response = await api.secrets.getAvailable();
        if (!cancelled) {
          setData(response);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load secrets"
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  // Filter by integration type
  const secrets =
    data?.secrets.filter((secret) => {
      if (!integrationType) {
        return true;
      }
      return secret.integrationType === integrationType;
    }) ?? [];

  return {
    secrets,
    loading,
    error,
    available: data?.available ?? false,
    secretStoreConnected: data?.secretStoreConnected ?? false,
  };
}
