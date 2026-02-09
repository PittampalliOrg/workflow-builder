"use client";

import { Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  DeleteConnectionOverlay,
  EditConnectionOverlay,
} from "@/components/overlays/edit-connection-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import { IntegrationIcon } from "@/components/ui/integration-icon";
import { Spinner } from "@/components/ui/spinner";
import { type AppConnection, api } from "@/lib/api-client";

type IntegrationsManagerProps = {
  onIntegrationChange?: () => void;
  filter?: string;
};

export function IntegrationsManager({
  onIntegrationChange,
  filter = "",
}: IntegrationsManagerProps) {
  const { push } = useOverlay();
  const [connections, setConnections] = useState<AppConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [testingId, setTestingId] = useState<string | null>(null);

  const loadConnections = useCallback(async () => {
    try {
      setLoading(true);
      const result = await api.appConnection.list();
      setConnections(result.data);
    } catch (error) {
      console.error("Failed to load connections:", error);
      toast.error("Failed to load connections");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

  const filteredConnections = useMemo(() => {
    const filterLower = filter.toLowerCase();

    return connections
      .filter((conn) => {
        if (!filter) {
          return true;
        }
        return (
          conn.displayName.toLowerCase().includes(filterLower) ||
          conn.pieceName.toLowerCase().includes(filterLower)
        );
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [connections, filter]);

  const handleEdit = (connection: AppConnection) => {
    push(EditConnectionOverlay, {
      connection,
      onSuccess: () => {
        loadConnections();
        onIntegrationChange?.();
      },
      onDelete: () => {
        loadConnections();
        onIntegrationChange?.();
      },
    });
  };

  const handleDelete = (connection: AppConnection) => {
    push(DeleteConnectionOverlay, {
      connection,
      onSuccess: () => {
        loadConnections();
        onIntegrationChange?.();
      },
    });
  };

  const handleTest = async (id: string) => {
    try {
      setTestingId(id);
      const result = await api.appConnection.testExisting(id);

      if (result.status === "success") {
        toast.success(result.message || "Connection successful");
      } else {
        toast.error(result.message || "Connection test failed");
      }
    } catch (error) {
      console.error("Connection test failed:", error);
      toast.error(
        error instanceof Error ? error.message : "Connection test failed"
      );
    } finally {
      setTestingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner />
      </div>
    );
  }

  const renderConnectionsList = () => {
    if (connections.length === 0) {
      return (
        <div className="py-8 text-center">
          <p className="text-muted-foreground text-sm">
            No connections configured yet
          </p>
        </div>
      );
    }

    if (filteredConnections.length === 0) {
      return (
        <div className="py-8 text-center">
          <p className="text-muted-foreground text-sm">
            No connections match your filter
          </p>
        </div>
      );
    }

    return (
      <div className="space-y-1">
        {filteredConnections.map((connection) => (
          <div
            className="flex items-center justify-between rounded-md px-2 py-1.5"
            key={connection.id}
          >
            <div className="flex items-center gap-2">
              <IntegrationIcon
                className="size-4"
                integration={connection.pieceName}
              />
              <span className="font-medium text-sm">
                {connection.displayName}
              </span>
              <span className="text-muted-foreground text-sm">
                {connection.pieceName}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Button
                className="h-7 px-2"
                disabled={testingId === connection.id}
                onClick={() => handleTest(connection.id)}
                size="sm"
                variant="outline"
              >
                {testingId === connection.id ? (
                  <Spinner className="size-3" />
                ) : (
                  <span className="text-xs">Test</span>
                )}
              </Button>
              <Button
                className="size-7"
                onClick={() => handleEdit(connection)}
                size="icon"
                variant="outline"
              >
                <Pencil className="size-3" />
              </Button>
              <Button
                className="size-7"
                onClick={() => handleDelete(connection)}
                size="icon"
                variant="outline"
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    );
  };

  return <div className="space-y-1">{renderConnectionsList()}</div>;
}
