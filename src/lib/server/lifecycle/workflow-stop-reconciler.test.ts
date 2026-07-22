import { describe, expect, it, vi } from "vitest";
import {
  reconcileWorkflowStops,
  type WorkflowStopReconcilerDeps,
} from "./workflow-stop-reconciler";

function deps(): WorkflowStopReconcilerDeps {
  return {
    listCandidates: vi.fn(async () => [
      { id: "workflow-1", mode: "purge" as const },
      { id: "workflow-2", mode: "reset" as const },
    ]),
    redriveStop: vi.fn(async () => undefined),
  };
}

describe("reconcileWorkflowStops", () => {
  it("re-drives persisted modes oldest-first within the action cap", async () => {
    const fake = deps();

    const result = await reconcileWorkflowStops(fake, {
      dryRun: false,
      limit: 20,
      maxActionsPerRun: 1,
    });

    expect(fake.redriveStop).toHaveBeenCalledOnce();
    expect(fake.redriveStop).toHaveBeenCalledWith("workflow-1", "purge");
    expect(result).toEqual({
      scanned: 2,
      redriven: ["workflow-1"],
      failed: [],
      dryRun: false,
    });
  });

  it("is read-only in dry-run mode", async () => {
    const fake = deps();

    const result = await reconcileWorkflowStops(fake, {
      dryRun: true,
      limit: 20,
      maxActionsPerRun: 20,
    });

    expect(fake.redriveStop).not.toHaveBeenCalled();
    expect(result.scanned).toBe(2);
    expect(result.dryRun).toBe(true);
  });

  it("records one failure without starving later candidates", async () => {
    const fake = deps();
    vi.mocked(fake.redriveStop)
      .mockRejectedValueOnce(new Error("transient control failure"))
      .mockResolvedValueOnce(undefined);

    const result = await reconcileWorkflowStops(fake, {
      dryRun: false,
      limit: 20,
      maxActionsPerRun: 20,
    });

    expect(result.redriven).toEqual(["workflow-2"]);
    expect(result.failed).toEqual([
      { id: "workflow-1", error: "transient control failure" },
    ]);
  });
});
