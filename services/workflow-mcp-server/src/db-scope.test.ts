import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("pg", () => ({
  default: {
    Pool: class {
      query = mocks.query;
    },
  },
}));

import {
  getExecutionByInstanceId,
  getScopedWorkflow,
  initDb,
  listWorkflows,
} from "./db.js";

describe("workflow MCP database scoping", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = "postgres://test";
    initDb();
  });

  beforeEach(() => {
    mocks.query.mockReset();
  });

  it("lists all workflows in the authenticated project without creator filtering", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await listWorkflows("project-a", 50);

    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("WHERE project_id = $1");
    expect(sql).not.toContain("user_id");
    expect(params).toEqual(["project-a"]);
  });

  it("resolves workflow ids and names only inside the authenticated project", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    expect(await getScopedWorkflow("shared-workflow", "project-b")).toBeNull();

    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("project_id = $2");
    expect(sql).not.toContain("user_id");
    expect(params).toEqual(["shared-workflow", "project-b"]);
  });

  it("does not resolve an execution outside the authenticated project", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    expect(await getExecutionByInstanceId("exec-1", "project-b")).toBeNull();

    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("AND project_id = $2");
    expect(sql).not.toContain("user_id");
    expect(params).toEqual(["exec-1", "project-b"]);
  });
});
