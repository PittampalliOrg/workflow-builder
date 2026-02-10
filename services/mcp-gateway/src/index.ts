/**
 * MCP Gateway
 *
 * Public Streamable HTTP endpoint:
 *   POST /api/v1/projects/:projectId/mcp-server/http
 *
 * Auth:
 *   Authorization: Bearer <token>
 *
 * Data + execution are delegated to the workflow-builder Next.js app via
 * internal endpoints protected by X-Internal-Token.
 */

import cors from "@fastify/cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify from "fastify";
import { z } from "zod";

type McpPropertyType =
  | "TEXT"
  | "NUMBER"
  | "BOOLEAN"
  | "DATE"
  | "ARRAY"
  | "OBJECT";

type McpInputProperty = {
  name: string;
  type: McpPropertyType;
  required: boolean;
  description?: string;
};

type PopulatedMcpWorkflow = {
  id: string;
  name: string;
  enabled: boolean;
  trigger: {
    toolName: string;
    toolDescription: string;
    inputSchema: McpInputProperty[];
    returnsResponse: boolean;
  };
};

type PopulatedMcpServer = {
  id: string;
  projectId: string;
  status: "ENABLED" | "DISABLED";
  token: string;
  flows: PopulatedMcpWorkflow[];
};

const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const HOST = process.env.HOST || "0.0.0.0";

const WORKFLOW_BUILDER_URL =
  process.env.WORKFLOW_BUILDER_URL ||
  "http://workflow-builder.workflow-builder.svc.cluster.local:3000";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "";

const WAIT_TIMEOUT_MS = Number.parseInt(
  process.env.MCP_WAIT_TIMEOUT_MS || "300000",
  10
);
const POLL_INTERVAL_MS = 500;

function requireInternalTokenConfigured() {
  if (!INTERNAL_API_TOKEN) {
    throw new Error("INTERNAL_API_TOKEN is not configured for mcp-gateway");
  }
}

function sanitizeToolName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function mcpPropertyToZod(prop: McpInputProperty): z.ZodTypeAny {
  let schema: z.ZodTypeAny;

  switch (prop.type) {
    case "TEXT":
    case "DATE":
      schema = z.string();
      break;
    case "NUMBER":
      schema = z.number();
      break;
    case "BOOLEAN":
      schema = z.boolean();
      break;
    case "ARRAY":
      schema = z.array(z.string());
      break;
    case "OBJECT":
      schema = z.record(z.string(), z.string());
      break;
    default:
      schema = z.unknown();
  }

  if (prop.description) {
    schema = schema.describe(prop.description);
  }
  return prop.required ? schema : schema.nullish();
}

async function fetchMcpServer(projectId: string): Promise<PopulatedMcpServer> {
  requireInternalTokenConfigured();
  const res = await fetch(
    `${WORKFLOW_BUILDER_URL}/api/internal/mcp/projects/${encodeURIComponent(
      projectId
    )}/server`,
    {
      headers: {
        "X-Internal-Token": INTERNAL_API_TOKEN,
      },
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Failed to load MCP server config. HTTP ${res.status}: ${body}`
    );
  }
  return (await res.json()) as PopulatedMcpServer;
}

async function startToolExecution(params: {
  projectId: string;
  workflowId: string;
  toolName: string;
  input: Record<string, unknown>;
}): Promise<{
  runId: string;
  executionId: string;
  instanceId: string;
  returnsResponse: boolean;
}> {
  requireInternalTokenConfigured();
  const res = await fetch(
    `${WORKFLOW_BUILDER_URL}/api/internal/mcp/projects/${encodeURIComponent(
      params.projectId
    )}/tools/${encodeURIComponent(params.workflowId)}/execute`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": INTERNAL_API_TOKEN,
      },
      body: JSON.stringify({
        toolName: params.toolName,
        input: params.input,
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to execute MCP tool. HTTP ${res.status}: ${body}`);
  }
  return (await res.json()) as {
    runId: string;
    executionId: string;
    instanceId: string;
    returnsResponse: boolean;
  };
}

async function pollForResponse(runId: string): Promise<unknown> {
  requireInternalTokenConfigured();
  const started = Date.now();
  while (Date.now() - started < WAIT_TIMEOUT_MS) {
    const res = await fetch(
      `${WORKFLOW_BUILDER_URL}/api/internal/mcp/runs/${encodeURIComponent(runId)}`,
      { headers: { "X-Internal-Token": INTERNAL_API_TOKEN } }
    );
    if (res.ok) {
      const run = (await res.json()) as {
        status: string;
        response?: unknown;
      };
      if (run.status === "RESPONDED") {
        return run.response;
      }
      if (run.status === "FAILED") {
        return run.response;
      }
      if (run.status === "TIMED_OUT") {
        return { error: "Timed out waiting for response" };
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { error: "Timed out waiting for response" };
}

async function main() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || "info" },
    bodyLimit: 10 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: true,
    methods: ["POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });

  app.get("/health", async () => ({ status: "healthy" }));

  app.post<{
    Params: { projectId: string };
    Headers: { authorization?: string };
    Body: unknown;
  }>("/api/v1/projects/:projectId/mcp-server/http", async (req, reply) => {
    const projectId = req.params.projectId;

    const mcp = await fetchMcpServer(projectId);
    if (mcp.status !== "ENABLED") {
      return reply.status(403).send({ error: "MCP access is disabled" });
    }

    const authHeader = req.headers.authorization || "";
    const [type, token] = authHeader.split(" ");
    if (type !== "Bearer" || token !== mcp.token) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const server = new McpServer({
      name: "Workflow Builder",
      version: "1.0.0",
    });

    const enabledFlows = (mcp.flows || []).filter((f) => f.enabled);
    for (const flow of enabledFlows) {
      const baseName = flow.trigger.toolName || flow.name;
      const toolName = `${sanitizeToolName(baseName)}_${flow.id.substring(0, 4)}`;
      const toolDescription = flow.trigger.toolDescription || "";
      const mcpInputs = flow.trigger.inputSchema || [];
      const schemaObj = Object.fromEntries(
        mcpInputs.map((p) => [p.name, mcpPropertyToZod(p)])
      );

      server.tool(
        toolName,
        toolDescription,
        schemaObj,
        { title: toolName },
        async (args) => {
          const started = await startToolExecution({
            projectId,
            workflowId: flow.id,
            toolName,
            input: args as Record<string, unknown>,
          });

          if (!flow.trigger.returnsResponse) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Started workflow "${flow.name}".\n\n` +
                    "Execution:\n" +
                    JSON.stringify(
                      {
                        runId: started.runId,
                        executionId: started.executionId,
                        instanceId: started.instanceId,
                      },
                      null,
                      2
                    ),
                },
              ],
            };
          }

          const response = await pollForResponse(started.runId);
          return {
            content: [
              {
                type: "text",
                text:
                  `Workflow "${flow.name}" responded.\n\n` +
                  "Response:\n" +
                  JSON.stringify(response ?? null, null, 2),
              },
            ],
          };
        }
      );
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    reply.raw.on("close", async () => {
      await transport.close();
      await server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  await app.listen({ port: PORT, host: HOST });
  console.log(`mcp-gateway listening on ${HOST}:${PORT}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
