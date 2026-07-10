import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const readModel = {
    executions: [
      {
        id: "exec-1",
        workflowId: "wf-1",
        status: "running",
      },
    ],
    total: 1,
    limit: 100,
    offset: 0,
  };
  const workflowData = {
    listInternalAgentWorkflowExecutions: vi.fn(async () => readModel),
  };
  const validateInternalOrPreviewControlRead = vi.fn(() => true);
  return { readModel, workflowData, validateInternalOrPreviewControlRead };
});

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/internal-auth", () => ({
  validateInternalOrPreviewControlRead:
    mocks.validateInternalOrPreviewControlRead,
}));

import { GET } from "./+server";

function request(url: string) {
  return new Request(url, {
    headers: { "X-Internal-Token": "test-token" },
  });
}

describe("internal agent workflow executions route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateInternalOrPreviewControlRead.mockReturnValue(true);
    mocks.workflowData.listInternalAgentWorkflowExecutions.mockResolvedValue(
      mocks.readModel,
    );
  });

  it("keeps internal execution listing behind workflow-data application services", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
      "utf8",
    );

    expect(source).toContain(
      "workflowData.listInternalAgentWorkflowExecutions",
    );
    expect(source).not.toContain("$lib/server/db");
    expect(source).not.toContain("$lib/server/db/schema");
    expect(source).not.toContain("drizzle-orm");
    expect(source).not.toContain("workflowExecutions");
  });

  it("forwards default filters to workflow-data for a valid internal token", async () => {
    const url = new URL(
      "http://localhost/api/internal/agent/workflows/executions",
    );
    const req = request(url.href);
    const response = (await GET({ request: req, url } as never)) as Response;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(mocks.readModel);
    expect(mocks.validateInternalOrPreviewControlRead).toHaveBeenCalledWith(
      req,
    );
    expect(
      mocks.workflowData.listInternalAgentWorkflowExecutions,
    ).toHaveBeenCalledWith({
      workflowId: undefined,
      workflowName: undefined,
      status: null,
      limit: 100,
      offset: 0,
    });
  });

  it("clamps pagination and forwards workflow/status filters", async () => {
    const url = new URL(
      "http://localhost/api/internal/agent/workflows/executions?workflowId=wf-1&workflowName=Build&status=%20running%20&limit=999&offset=-7",
    );

    await GET({ request: request(url.href), url } as never);

    expect(
      mocks.workflowData.listInternalAgentWorkflowExecutions,
    ).toHaveBeenCalledWith({
      workflowId: "wf-1",
      workflowName: "Build",
      status: "running",
      limit: 500,
      offset: 0,
    });
  });
});
