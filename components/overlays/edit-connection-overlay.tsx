"use client";

import { Check, Pencil, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useIsMobile } from "@/hooks/use-mobile";
import { type AppConnection, api } from "@/lib/api-client";
import { AppConnectionType } from "@/lib/types/app-connection";
import { getIntegration } from "@/plugins";
import { ConfirmOverlay } from "./confirm-overlay";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";

type EditConnectionOverlayProps = {
  overlayId: string;
  connection: AppConnection;
  onSuccess?: () => void;
  onDelete?: () => void;
};

/**
 * Secret field with "Configured" state for edit mode
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
  const [isEditing, setIsEditing] = useState(false);
  const isMobile = useIsMobile();
  const hasNewValue = value.length > 0;

  // Show "Configured" state until user clicks Change
  if (!(isEditing || hasNewValue)) {
    return (
      <div className="space-y-2">
        <Label htmlFor={fieldId}>{label}</Label>
        <div className="flex items-center gap-2">
          <div className="flex h-9 flex-1 items-center gap-2 rounded-md border bg-muted/30 px-3">
            <Check className="size-4 text-green-600" />
            <span className="text-muted-foreground text-sm">Configured</span>
          </div>
          <Button
            onClick={() => setIsEditing(true)}
            type="button"
            variant="outline"
          >
            <Pencil className="mr-1.5 size-3" />
            Change
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={fieldId}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          autoFocus={isEditing && !isMobile}
          className="flex-1"
          id={fieldId}
          onChange={(e) => onChange(configKey, e.target.value)}
          placeholder={placeholder}
          type="password"
          value={value}
        />
        {(isEditing || hasNewValue) && (
          <Button
            onClick={() => {
              onChange(configKey, "");
              setIsEditing(false);
            }}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X className="size-4" />
          </Button>
        )}
      </div>
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
 * Overlay for editing an existing connection
 */
export function EditConnectionOverlay({
  overlayId,
  connection,
  onSuccess,
  onDelete,
}: EditConnectionOverlayProps) {
  const { push, closeAll } = useOverlay();
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [_testResult, setTestResult] = useState<{
    status: "success" | "error";
    message: string;
  } | null>(null);
  const [displayName, setDisplayName] = useState(connection.displayName);
  const [config, setConfig] = useState<Record<string, string>>({});

  const updateConfig = (key: string, value: string) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const doSave = async () => {
    try {
      setSaving(true);
      const hasNewConfig = Object.values(config).some((v) => v && v.length > 0);
      if (hasNewConfig) {
        // Re-upsert with new credentials (matched by externalId)
        await api.appConnection.upsert({
          externalId: connection.externalId,
          displayName: displayName.trim(),
          pieceName: connection.pieceName,
          projectId: "default",
          value: {
            type: AppConnectionType.SECRET_TEXT,
            secret_text:
              Object.values(config).find((v) => v && v.length > 0) || "",
          },
          type: AppConnectionType.SECRET_TEXT,
        });
      } else {
        await api.appConnection.update(connection.id, {
          displayName: displayName.trim(),
        });
      }
      toast.success("Connection updated");
      onSuccess?.();
      closeAll();
    } catch (error) {
      console.error("Failed to update connection:", error);
      toast.error("Failed to update connection");
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    const hasNewConfig = Object.values(config).some((v) => v && v.length > 0);

    // If no new config, just save the name
    if (!hasNewConfig) {
      await doSave();
      return;
    }

    // Test before saving
    try {
      setSaving(true);
      setTestResult(null);

      const result = await api.appConnection.test({
        pieceName: connection.pieceName,
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
            await doSave();
          },
        });
        setSaving(false);
        return;
      }

      await doSave();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to test connection";
      push(ConfirmOverlay, {
        title: "Connection Test Failed",
        message: `${message}\n\nDo you want to save anyway?`,
        confirmLabel: "Save Anyway",
        onConfirm: async () => {
          await doSave();
        },
      });
      setSaving(false);
    }
  };

  const handleTest = async () => {
    const hasNewConfig = Object.values(config).some((v) => v && v.length > 0);

    try {
      setTesting(true);
      setTestResult(null);

      let result: { status: "success" | "error"; message: string };

      if (hasNewConfig) {
        result = await api.appConnection.test({
          pieceName: connection.pieceName,
          value: {
            type: AppConnectionType.SECRET_TEXT,
            secret_text:
              Object.values(config).find((v) => v && v.length > 0) || "",
          },
          type: AppConnectionType.SECRET_TEXT,
        });
      } else {
        result = await api.appConnection.testExisting(connection.id);
      }

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

  const handleDelete = () => {
    push(DeleteConnectionOverlay, {
      connection,
      onSuccess: () => {
        onDelete?.();
        closeAll();
      },
    });
  };

  // Get plugin form fields (will be replaced by piece-metadata-driven auth in Phase 5)
  const plugin = getIntegration(connection.pieceName);
  const formFields = plugin?.formFields;

  // Render config fields
  const renderConfigFields = () => {
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

  return (
    <Overlay
      actions={[
        {
          label: "Delete",
          variant: "ghost",
          onClick: handleDelete,
          disabled: saving || testing,
        },
        {
          label: "Test",
          variant: "outline",
          onClick: handleTest,
          loading: testing,
          disabled: saving,
        },
        { label: "Update", onClick: handleSave, loading: saving },
      ]}
      overlayId={overlayId}
      title={`Edit ${connection.displayName}`}
    >
      <p className="-mt-2 mb-4 text-muted-foreground text-sm">
        Update your connection credentials
      </p>

      <div className="space-y-4">
        {renderConfigFields()}

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

type DeleteConnectionOverlayProps = {
  overlayId: string;
  connection: AppConnection;
  onSuccess?: () => void;
};

/**
 * Overlay for deleting a connection with optional key revocation
 */
export function DeleteConnectionOverlay({
  overlayId,
  connection,
  onSuccess,
}: DeleteConnectionOverlayProps) {
  const { pop } = useOverlay();
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    try {
      setDeleting(true);
      await api.appConnection.delete(connection.id);
      toast.success("Connection deleted");
      onSuccess?.();
    } catch (error) {
      console.error("Failed to delete connection:", error);
      toast.error("Failed to delete connection");
      setDeleting(false);
    }
  };

  return (
    <Overlay
      actions={[
        { label: "Cancel", variant: "outline", onClick: pop },
        {
          label: "Delete",
          variant: "destructive",
          onClick: handleDelete,
          loading: deleting,
        },
      ]}
      overlayId={overlayId}
      title="Delete Connection"
    >
      <p className="text-muted-foreground text-sm">
        Are you sure you want to delete this connection? Workflows using it will
        fail until a new one is configured.
      </p>
    </Overlay>
  );
}
