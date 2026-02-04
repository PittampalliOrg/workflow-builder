"use client";

import { ArrowLeft, Box, Globe } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api-client";

type ExecutionType = "oci" | "http";

export default function NewFunctionPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [executionType, setExecutionType] = useState<ExecutionType>("oci");

  // Common fields
  const [name, setName] = useState("");
  const [pluginId, setPluginId] = useState("custom");
  const [functionSlug, setFunctionSlug] = useState("");
  const [description, setDescription] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(300);
  const [integrationType, setIntegrationType] = useState("");

  // OCI fields
  const [imageRef, setImageRef] = useState("");
  const [command, setCommand] = useState("");
  const [workingDir, setWorkingDir] = useState("");

  // HTTP fields
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookMethod, setWebhookMethod] = useState("POST");
  const [webhookTimeoutSeconds, setWebhookTimeoutSeconds] = useState(30);

  // Auto-generate slug from name and plugin
  const handleNameChange = (newName: string) => {
    setName(newName);
    // Generate slug if user hasn't manually edited it
    if (!functionSlug || functionSlug === generateSlug(name, pluginId)) {
      setFunctionSlug(generateSlug(newName, pluginId));
    }
  };

  const handlePluginChange = (newPluginId: string) => {
    setPluginId(newPluginId);
    // Update slug if it was auto-generated
    if (!functionSlug || functionSlug === generateSlug(name, pluginId)) {
      setFunctionSlug(generateSlug(name, newPluginId));
    }
  };

  const generateSlug = (n: string, p: string): string => {
    if (!n) return "";
    const slugName = n
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    return `${p}/${slugName}`;
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (!name || !functionSlug || !pluginId) {
      toast.error("Please fill in all required fields");
      return;
    }

    if (executionType === "oci" && !imageRef) {
      toast.error("Image reference is required for container functions");
      return;
    }

    if (executionType === "http" && !webhookUrl) {
      toast.error("Webhook URL is required for HTTP functions");
      return;
    }

    try {
      setLoading(true);

      await api.functions.create({
        name,
        slug: functionSlug,
        description: description || undefined,
        pluginId,
        executionType,
        timeoutSeconds,
        integrationType: integrationType || undefined,
        // OCI fields
        imageRef: executionType === "oci" ? imageRef : undefined,
        command: executionType === "oci" && command ? command : undefined,
        workingDir: executionType === "oci" && workingDir ? workingDir : undefined,
        // HTTP fields
        webhookUrl: executionType === "http" ? webhookUrl : undefined,
        webhookMethod: executionType === "http" ? webhookMethod : undefined,
        webhookTimeoutSeconds:
          executionType === "http" ? webhookTimeoutSeconds : undefined,
      });

      toast.success("Function created successfully");
      router.push("/functions");
    } catch (error) {
      console.error("Failed to create function:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to create function"
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto max-w-2xl py-8">
      <div className="mb-8 flex items-center gap-4">
        <Link href="/functions">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold">Create Function</h1>
          <p className="text-muted-foreground">
            Define a custom function for workflow execution
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Basic Information</CardTitle>
            <CardDescription>
              General information about your function
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="My Custom Function"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="pluginId">Plugin ID *</Label>
              <Input
                id="pluginId"
                value={pluginId}
                onChange={(e) => handlePluginChange(e.target.value)}
                placeholder="custom"
                required
              />
              <p className="text-xs text-muted-foreground">
                Group similar functions under the same plugin ID
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="slug">Function Slug *</Label>
              <Input
                id="slug"
                value={functionSlug}
                onChange={(e) => setFunctionSlug(e.target.value)}
                placeholder="custom/my-function"
                required
                pattern="^[a-z0-9]+\/[a-z0-9-]+$"
              />
              <p className="text-xs text-muted-foreground">
                Unique identifier in format: plugin/function-name
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this function do?"
                rows={3}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="timeout">Timeout (seconds)</Label>
                <Input
                  id="timeout"
                  type="number"
                  value={timeoutSeconds}
                  onChange={(e) => setTimeoutSeconds(Number(e.target.value))}
                  min={1}
                  max={3600}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="integrationType">Integration Type</Label>
                <Input
                  id="integrationType"
                  value={integrationType}
                  onChange={(e) => setIntegrationType(e.target.value)}
                  placeholder="e.g., openai, slack"
                />
                <p className="text-xs text-muted-foreground">
                  For credential lookup
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Execution Type</CardTitle>
            <CardDescription>
              How should this function be executed?
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs
              value={executionType}
              onValueChange={(v) => setExecutionType(v as ExecutionType)}
            >
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="oci" className="gap-2">
                  <Box className="h-4 w-4" />
                  Container (OCI)
                </TabsTrigger>
                <TabsTrigger value="http" className="gap-2">
                  <Globe className="h-4 w-4" />
                  Webhook (HTTP)
                </TabsTrigger>
              </TabsList>

              <TabsContent value="oci" className="mt-4 space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="imageRef">Container Image *</Label>
                  <Input
                    id="imageRef"
                    value={imageRef}
                    onChange={(e) => setImageRef(e.target.value)}
                    placeholder="gitea.cnoe.localtest.me:8443/functions/my-func:v1"
                  />
                  <p className="text-xs text-muted-foreground">
                    Full OCI image reference including registry and tag
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="command">Command Override</Label>
                  <Input
                    id="command"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder="/bin/run-function"
                  />
                  <p className="text-xs text-muted-foreground">
                    Optional: override container entrypoint
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="workingDir">Working Directory</Label>
                  <Input
                    id="workingDir"
                    value={workingDir}
                    onChange={(e) => setWorkingDir(e.target.value)}
                    placeholder="/app"
                  />
                  <p className="text-xs text-muted-foreground">
                    Optional: working directory inside container
                  </p>
                </div>
              </TabsContent>

              <TabsContent value="http" className="mt-4 space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="webhookUrl">Webhook URL *</Label>
                  <Input
                    id="webhookUrl"
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                    placeholder="https://api.example.com/webhook"
                    type="url"
                  />
                  <p className="text-xs text-muted-foreground">
                    The URL that will receive function execution requests
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="webhookMethod">HTTP Method</Label>
                    <Select
                      value={webhookMethod}
                      onValueChange={setWebhookMethod}
                    >
                      <SelectTrigger id="webhookMethod">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="POST">POST</SelectItem>
                        <SelectItem value="PUT">PUT</SelectItem>
                        <SelectItem value="PATCH">PATCH</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="webhookTimeout">Timeout (seconds)</Label>
                    <Input
                      id="webhookTimeout"
                      type="number"
                      value={webhookTimeoutSeconds}
                      onChange={(e) =>
                        setWebhookTimeoutSeconds(Number(e.target.value))
                      }
                      min={1}
                      max={300}
                    />
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-4">
          <Link href="/functions">
            <Button variant="outline" type="button">
              Cancel
            </Button>
          </Link>
          <Button type="submit" disabled={loading}>
            {loading ? "Creating..." : "Create Function"}
          </Button>
        </div>
      </form>
    </div>
  );
}
