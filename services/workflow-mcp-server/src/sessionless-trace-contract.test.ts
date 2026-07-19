import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";

const SERVICE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const TEST_BEARER = "Bearer wfb_contract_key";
const INTERNAL_TOKEN = "contract-internal-token";
const PRINCIPAL_ASSERTION = "signed-workspace-principal";
const EXECUTION_ID = "execution-contract-123";
const STORAGE_REF =
  "workflow-browser-artifacts/execution-contract-123/artifact-1/screenshot.png";
const SCREENSHOT_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

type ObservedRequest = {
  method: string;
  path: string;
  headers: Headers;
  body?: unknown;
};

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test HTTP server did not bind a TCP port");
  }
  return address.port;
}

async function reservePort(): Promise<number> {
  const server = http.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function waitForHealth(
  baseUrl: string,
  child: ChildProcessWithoutNullStreams,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `workflow-mcp-server exited with ${child.exitCode}:\n${output()}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The child has not started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`workflow-mcp-server did not become ready:\n${output()}`);
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

function jsonRpcBody(body: RequestInit["body"]): unknown {
  if (typeof body === "string") return JSON.parse(body);
  if (body instanceof Uint8Array) {
    return JSON.parse(Buffer.from(body).toString("utf-8"));
  }
  return undefined;
}

describe("sessionless workflow trace consumer contract", () => {
  it(
    "resolves bearer auth per request and returns screenshot pixels as native MCP image content",
    async () => {
      const authRequests: ObservedRequest[] = [];
      const diagnosticsRequests: ObservedRequest[] = [];
      const unexpectedBffRequests: ObservedRequest[] = [];
      const fakeBff = http.createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://fake-bff");
        const observed = {
          method: request.method ?? "GET",
          path: `${url.pathname}${url.search}`,
          headers: requestHeaders(request),
        };

        if (
          request.method === "POST" &&
          url.pathname === "/api/internal/auth/workflow-mcp-principal"
        ) {
          authRequests.push(observed);
          sendJson(response, 200, {
            authenticated: true,
            authMode: "workspace_api_key",
            userId: "user-contract",
            projectId: "project-contract",
            workspace: {
              id: "project-contract",
              slug: "contract-workspace",
            },
            scopes: ["workflow:read"],
            apiKeyId: "key-contract",
            principalAssertion: PRINCIPAL_ASSERTION,
            capabilities: {
              scriptDepth: 0,
              teamId: null,
              teamRole: "none",
            },
          });
          return;
        }

        if (
          request.method === "GET" &&
          url.pathname ===
            `/api/internal/observability/executions/${EXECUTION_ID}/browser-artifacts/screenshot`
        ) {
          diagnosticsRequests.push(observed);
          sendJson(response, 200, {
            storageRef: STORAGE_REF,
            contentType: "image/png",
            sizeBytes: Buffer.from(SCREENSHOT_BASE64, "base64").byteLength,
            payloadBase64: SCREENSHOT_BASE64,
          });
          return;
        }

        unexpectedBffRequests.push(observed);
        sendJson(response, 404, { error: "Unexpected fake BFF request" });
      });

      const fakeBffPort = await listen(fakeBff);
      const mcpPort = await reservePort();
      const mcpBaseUrl = `http://127.0.0.1:${mcpPort}`;
      const child = spawn(
        process.execPath,
        [path.join(SERVICE_ROOT, "node_modules/tsx/dist/cli.mjs"), "src/index.ts"],
        {
          cwd: SERVICE_ROOT,
          env: {
            ...process.env,
            DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
            HOST: "127.0.0.1",
            PORT: String(mcpPort),
            INTERNAL_API_TOKEN: INTERNAL_TOKEN,
            WORKFLOW_BUILDER_URL: `http://127.0.0.1:${fakeBffPort}`,
            OTEL_EXPORTER_OTLP_ENDPOINT: "",
          },
          stdio: "pipe",
        },
      );
      let childOutput = "";
      child.stdout.on("data", (chunk) => {
        childOutput += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        childOutput += String(chunk);
      });

      const mcpRequests: ObservedRequest[] = [];
      const tracedFetch = async (
        input: string | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        mcpRequests.push({
          method: init?.method ?? "GET",
          path: new URL(input).pathname,
          headers: new Headers(init?.headers),
          body: jsonRpcBody(init?.body),
        });
        return fetch(input, init);
      };
      const client = new Client(
        { name: "trace-contract-consumer", version: "1.0.0" },
        { capabilities: {} },
      );
      const transport = new StreamableHTTPClientTransport(
        new URL(`${mcpBaseUrl}/mcp`),
        {
          requestInit: { headers: { Authorization: TEST_BEARER } },
          fetch: tracedFetch,
        },
      );

      try {
        await waitForHealth(mcpBaseUrl, child, () => childOutput);

        await client.connect(transport);
        expect(transport.sessionId).toBeUndefined();

        const catalog = await client.listTools();
        expect(catalog.tools.map((tool) => tool.name)).toContain(
          "trace_get_browser_screenshot",
        );

        const result = await client.callTool({
          name: "trace_get_browser_screenshot",
          arguments: {
            executionId: EXECUTION_ID,
            storageRef: STORAGE_REF,
          },
        });
        const content = result.content as Array<Record<string, unknown>>;
        expect(content).toContainEqual({
          type: "image",
          data: SCREENSHOT_BASE64,
          mimeType: "image/png",
        });
        const text = content.find((part) => part.type === "text")?.text;
        expect(text).toEqual(expect.any(String));
        expect(text).not.toContain(SCREENSHOT_BASE64);
        expect(result.structuredContent).toMatchObject({
          ok: true,
          data: {
            storageRef: STORAGE_REF,
            contentType: "image/png",
          },
        });
        expect(JSON.stringify(result.structuredContent)).not.toContain(
          SCREENSHOT_BASE64,
        );

        const rpcMethods = mcpRequests
          .map((request) =>
            request.body && typeof request.body === "object"
              ? (request.body as Record<string, unknown>).method
              : undefined,
          )
          .filter((method): method is string => typeof method === "string");
        expect(rpcMethods).toEqual(
          expect.arrayContaining(["initialize", "tools/list", "tools/call"]),
        );
        const mcpPosts = mcpRequests.filter(
          (request) => request.method === "POST",
        );
        expect(mcpPosts.length).toBeGreaterThanOrEqual(3);
        for (const request of mcpPosts) {
          expect(request.headers.get("authorization")).toBe(TEST_BEARER);
          expect(request.headers.get("mcp-session-id")).toBeNull();
        }

        expect(authRequests).toHaveLength(mcpPosts.length);
        for (const request of authRequests) {
          expect(request.headers.get("authorization")).toBe(TEST_BEARER);
          expect(request.headers.get("x-internal-token")).toBe(INTERNAL_TOKEN);
          expect(request.headers.get("x-wfb-session-id")).toBeNull();
        }

        expect(diagnosticsRequests).toHaveLength(1);
        expect(diagnosticsRequests[0]?.path).toBe(
          `/api/internal/observability/executions/${EXECUTION_ID}/browser-artifacts/screenshot?storageRef=${encodeURIComponent(STORAGE_REF)}`,
        );
        expect(
          diagnosticsRequests[0]?.headers.get("x-wfb-principal-assertion"),
        ).toBe(PRINCIPAL_ASSERTION);
        expect(diagnosticsRequests[0]?.headers.get("x-internal-token")).toBe(
          INTERNAL_TOKEN,
        );
        expect(diagnosticsRequests[0]?.headers.get("authorization")).toBeNull();
        expect(unexpectedBffRequests).toEqual([]);
      } finally {
        await client.close().catch(() => undefined);
        await stopChild(child);
        await closeServer(fakeBff);
      }
    },
    30_000,
  );
});
