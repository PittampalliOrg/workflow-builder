import { describe, expect, it } from "vitest";
import { compileGraphToWorkflow } from "./compile";
import { decompileWorkflowToGraph } from "./decompile";
import type { Workflow } from "./types";
import { SW_DSL_VERSION } from "./types";

/** Simple sequential workflow: set -> call -> wait -> emit */
const simpleWorkflow: Workflow = {
  document: {
    dsl: SW_DSL_VERSION,
    namespace: "test",
    name: "simple-test",
    version: "1.0.0",
    title: "Simple Test Workflow",
  },
  do: [
    {
      initVars: {
        set: { greeting: "hello", count: 0 },
      },
    },
    {
      fetchData: {
        call: "http",
        with: {
          method: "GET",
          endpoint: { uri: "https://api.example.com/data" },
        },
      },
    },
    {
      waitStep: {
        wait: "PT5S",
      },
    },
    {
      notifyDone: {
        emit: {
          event: {
            with: {
              type: "workflow.completed",
              source: "test",
              data: { status: "done" },
            },
          },
        },
      },
    },
  ],
};

/** Workflow with switch (conditional branching) */
const switchWorkflow: Workflow = {
  document: {
    dsl: SW_DSL_VERSION,
    namespace: "test",
    name: "switch-test",
    version: "1.0.0",
  },
  do: [
    {
      checkStatus: {
        switch: [
          {
            active: {
              when: "${ .status == 'active' }",
              then: "processActive",
            },
          },
          {
            inactive: {
              when: "${ .status == 'inactive' }",
              then: "processInactive",
            },
          },
          {
            default: {
              then: "end",
            },
          },
        ],
      },
    },
    {
      processActive: {
        set: { result: "processed-active" },
        then: "end",
      },
    },
    {
      processInactive: {
        set: { result: "processed-inactive" },
        then: "end",
      },
    },
  ],
};

/** Workflow with function catalog references */
const functionWorkflow: Workflow = {
  document: {
    dsl: SW_DSL_VERSION,
    namespace: "workflow-builder",
    name: "agent-workflow",
    version: "1.0.0",
    title: "Agent Workflow",
  },
  use: {
    functions: {
      workspaceClone: {
        call: "http",
        with: {
          method: "POST",
          endpoint: {
            uri: "http://localhost:3500/v1.0/invoke/openshell-agent-runtime/method/workspace/clone",
          },
        },
      },
      durableRun: {
        call: "http",
        with: {
          method: "POST",
          endpoint: {
            uri: "http://localhost:3500/v1.0/invoke/durable-agent/method/durable/run",
          },
        },
      },
    },
  },
  do: [
    {
      cloneRepo: {
        call: "workspaceClone",
        with: {
          repo: "${ .input.repository }",
          branch: "${ .input.branch }",
        },
      },
    },
    {
      runAgent: {
        call: "durableRun",
        with: {
          prompt: "${ .input.task }",
          workspace: "${ .cloneRepo.workspaceId }",
        },
      },
    },
  ],
};

describe("SW 1.0 roundtrip", () => {
  it("decompiles a simple workflow to graph", () => {
    const graph = decompileWorkflowToGraph(simpleWorkflow);

    // Should have start + 4 tasks + end = 6 nodes
    expect(graph.nodes.length).toBe(6);
    expect(graph.edges.length).toBeGreaterThanOrEqual(5);

    // Check node types
    const types = graph.nodes.map((n) => n.data.taskType);
    expect(types).toContain("start");
    expect(types).toContain("end");
    expect(types).toContain("set");
    expect(types).toContain("call");
    expect(types).toContain("wait");
    expect(types).toContain("emit");
  });

  it("recompiles graph back to workflow", () => {
    const graph = decompileWorkflowToGraph(simpleWorkflow);
    const recompiled = compileGraphToWorkflow(graph, {
      namespace: "test",
      name: "simple-test",
      version: "1.0.0",
      title: "Simple Test Workflow",
    });

    // Check document
    expect(recompiled.document.dsl).toBe(SW_DSL_VERSION);
    expect(recompiled.document.name).toBe("simple-test");
    expect(recompiled.document.namespace).toBe("test");

    // Check task count
    expect(recompiled.do.length).toBe(4);
  });

  it("preserves switch task structure", () => {
    const graph = decompileWorkflowToGraph(switchWorkflow);

    // Find the switch node
    const switchNode = graph.nodes.find((n) => n.data.taskType === "switch");
    expect(switchNode).toBeDefined();
    expect(switchNode!.data.taskConfig).toHaveProperty("switch");
  });

  it("preserves use.functions through roundtrip", () => {
    const graph = decompileWorkflowToGraph(functionWorkflow);
    const recompiled = compileGraphToWorkflow(graph, {
      namespace: "workflow-builder",
      name: "agent-workflow",
      version: "1.0.0",
    });

    // use.functions should be preserved via start node
    expect(recompiled.use).toBeDefined();
    expect(recompiled.use!.functions).toBeDefined();
    expect(recompiled.use!.functions!.workspaceClone).toBeDefined();
    expect(recompiled.use!.functions!.durableRun).toBeDefined();
  });

  it("generates valid node positions", () => {
    const graph = decompileWorkflowToGraph(simpleWorkflow);
    for (const node of graph.nodes) {
      expect(typeof node.position.x).toBe("number");
      expect(typeof node.position.y).toBe("number");
    }
  });
});
