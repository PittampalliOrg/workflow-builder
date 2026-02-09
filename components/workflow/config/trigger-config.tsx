"use client";

import { Clock, Copy, Play, Webhook, Wrench } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CodeEditor } from "@/components/ui/code-editor";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TimezoneSelect } from "@/components/ui/timezone-select";
import { type McpInputProperty, McpInputsBuilder } from "./mcp-inputs-builder";
import { SchemaBuilder, type SchemaField } from "./schema-builder";

type TriggerConfigProps = {
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: string) => void;
  disabled: boolean;
  workflowId?: string;
};

export function TriggerConfig({
  config,
  onUpdateConfig,
  disabled,
  workflowId,
}: TriggerConfigProps) {
  const webhookUrl = workflowId
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/api/workflows/${workflowId}/webhook`
    : "";

  const handleCopyWebhookUrl = () => {
    if (webhookUrl) {
      navigator.clipboard.writeText(webhookUrl);
      toast.success("Webhook URL copied to clipboard");
    }
  };

  return (
    <>
      <div className="space-y-2">
        <Label className="ml-1" htmlFor="triggerType">
          Trigger Type
        </Label>
        <Select
          disabled={disabled}
          onValueChange={(value) => onUpdateConfig("triggerType", value)}
          value={(config?.triggerType as string) || "Manual"}
        >
          <SelectTrigger className="w-full" id="triggerType">
            <SelectValue placeholder="Select trigger type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="Manual">
              <div className="flex items-center gap-2">
                <Play className="h-4 w-4" />
                Manual
              </div>
            </SelectItem>
            <SelectItem value="Schedule">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4" />
                Schedule
              </div>
            </SelectItem>
            <SelectItem value="Webhook">
              <div className="flex items-center gap-2">
                <Webhook className="h-4 w-4" />
                Webhook
              </div>
            </SelectItem>
            <SelectItem value="MCP">
              <div className="flex items-center gap-2">
                <Wrench className="h-4 w-4" />
                MCP Tool
              </div>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Webhook fields */}
      {config?.triggerType === "Webhook" && (
        <>
          <div className="space-y-2">
            <Label className="ml-1">Webhook URL</Label>
            <div className="flex gap-2">
              <Input
                className="font-mono text-xs"
                disabled
                value={webhookUrl || "Save workflow to generate webhook URL"}
              />
              <Button
                disabled={!webhookUrl}
                onClick={handleCopyWebhookUrl}
                size="icon"
                variant="outline"
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Request Schema (Optional)</Label>
            <SchemaBuilder
              disabled={disabled}
              onChange={(schema) =>
                onUpdateConfig("webhookSchema", JSON.stringify(schema))
              }
              schema={
                config?.webhookSchema
                  ? (JSON.parse(
                      config.webhookSchema as string
                    ) as SchemaField[])
                  : []
              }
            />
            <p className="text-muted-foreground text-xs">
              Define the expected structure of the incoming webhook payload.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="webhookMockRequest">Mock Request (Optional)</Label>
            <div className="overflow-hidden rounded-md border">
              <CodeEditor
                defaultLanguage="json"
                height="150px"
                onChange={(value) =>
                  onUpdateConfig("webhookMockRequest", value || "")
                }
                options={{
                  minimap: { enabled: false },
                  lineNumbers: "on",
                  scrollBeyondLastLine: false,
                  fontSize: 12,
                  readOnly: disabled,
                  wordWrap: "on",
                }}
                value={(config?.webhookMockRequest as string) || ""}
              />
            </div>
            <p className="text-muted-foreground text-xs">
              Enter a sample JSON payload to test the webhook trigger.
            </p>
          </div>
        </>
      )}

      {/* Schedule fields */}
      {config?.triggerType === "Schedule" && (
        <>
          <div className="space-y-2">
            <Label className="ml-1" htmlFor="scheduleCron">
              Cron Expression
            </Label>
            <Input
              disabled={disabled}
              id="scheduleCron"
              onChange={(e) => onUpdateConfig("scheduleCron", e.target.value)}
              placeholder="0 9 * * * (every day at 9am)"
              value={(config?.scheduleCron as string) || ""}
            />
          </div>
          <div className="space-y-2">
            <Label className="ml-1" htmlFor="scheduleTimezone">
              Timezone
            </Label>
            <TimezoneSelect
              disabled={disabled}
              id="scheduleTimezone"
              onValueChange={(value) =>
                onUpdateConfig("scheduleTimezone", value)
              }
              value={(config?.scheduleTimezone as string) || "America/New_York"}
            />
          </div>
        </>
      )}

      {/* MCP fields */}
      {config?.triggerType === "MCP" &&
        (() => {
          let parsed: McpInputProperty[] = [];
          if (config?.inputSchema && typeof config.inputSchema === "string") {
            try {
              parsed = JSON.parse(config.inputSchema) as McpInputProperty[];
            } catch {
              parsed = [];
            }
          }
          const returnsResponse =
            typeof config?.returnsResponse === "string"
              ? config.returnsResponse.toLowerCase() === "true"
              : false;
          const exposeTool =
            typeof config?.enabled === "string"
              ? config.enabled.toLowerCase() !== "false"
              : true;

          return (
            <>
              <div className="space-y-2">
                <Label className="ml-1" htmlFor="mcpToolName">
                  Name
                </Label>
                <Input
                  disabled={disabled}
                  id="mcpToolName"
                  onChange={(e) => onUpdateConfig("toolName", e.target.value)}
                  placeholder="Used by MCP clients to call this tool"
                  value={(config?.toolName as string) || ""}
                />
                <p className="text-muted-foreground text-xs">
                  This becomes the MCP tool name for this workflow.
                </p>
              </div>

              <div className="space-y-2">
                <Label className="ml-1" htmlFor="mcpToolDescription">
                  Description
                </Label>
                <Input
                  disabled={disabled}
                  id="mcpToolDescription"
                  onChange={(e) =>
                    onUpdateConfig("toolDescription", e.target.value)
                  }
                  placeholder="Describe what this tool does"
                  value={(config?.toolDescription as string) || ""}
                />
              </div>

              <div className="space-y-2">
                <Label>Parameters</Label>
                <McpInputsBuilder
                  disabled={disabled}
                  onChange={(schema) =>
                    onUpdateConfig("inputSchema", JSON.stringify(schema))
                  }
                  value={parsed}
                />
                <p className="text-muted-foreground text-xs">
                  Define the input parameters MCP clients can pass to this
                  workflow.
                </p>
              </div>

              <div className="flex items-center gap-2 rounded-md border p-3">
                <Checkbox
                  checked={returnsResponse}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    onUpdateConfig("returnsResponse", String(Boolean(checked)))
                  }
                />
                <div>
                  <div className="font-medium text-sm">Wait for Response</div>
                  <div className="text-muted-foreground text-xs">
                    Keep the MCP client waiting until it receives a response via
                    the Reply to MCP Client action.
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 rounded-md border p-3">
                <Checkbox
                  checked={exposeTool}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    onUpdateConfig("enabled", String(Boolean(checked)))
                  }
                />
                <div>
                  <div className="font-medium text-sm">Expose Tool</div>
                  <div className="text-muted-foreground text-xs">
                    When disabled, this workflow will not be exposed as an MCP
                    tool.
                  </div>
                </div>
              </div>
            </>
          );
        })()}
    </>
  );
}
