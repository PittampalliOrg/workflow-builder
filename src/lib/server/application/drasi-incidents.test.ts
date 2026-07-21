import { describe, expect, it } from "vitest";
import { normalizeDrasiIncident } from "./drasi-incidents";

const options = { workflowName: "platform-incident-analysis", cluster: "dev" };

describe("normalizeDrasiIncident", () => {
  it("maps an allowlisted incident to the canonical trigger envelope", () => {
    const input = {
      queryId: "workflow-execution-stalled",
      incidentKey: "exec-1",
      episodeStartedAt: "2026-07-21T12:00:00Z",
      severity: "critical",
      subject: "Execution exec-1 has not progressed",
      evidence: { executionId: "exec-1", ageMinutes: 31 },
    };

    const first = normalizeDrasiIncident(input, options);
    const second = normalizeDrasiIncident(input, options);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      envelope: {
        workflowName: "platform-incident-analysis",
        triggerId: "drasi:workflow-execution-stalled",
        dedupKey: expect.stringMatching(
          /^drasi:workflow-execution-stalled:dev:[a-f0-9]{24}$/,
        ),
        triggerData: {
          source: "drasi",
          cluster: "dev",
          incidentType: "workflow-execution-stalled",
          incidentKey: "exec-1",
        },
      },
    });
  });

  it("rejects arbitrary query IDs and invalid episodes", () => {
    expect(
      normalizeDrasiIncident(
        {
          queryId: "start-any-workflow",
          incidentKey: "x",
          episodeStartedAt: "2026-07-21T12:00:00Z",
        },
        options,
      ),
    ).toEqual({ ok: false, error: "queryId is not allowlisted" });
    expect(
      normalizeDrasiIncident(
        {
          queryId: "dapr-resource-warning",
          incidentKey: "x",
          episodeStartedAt: "not-a-date",
        },
        options,
      ),
    ).toEqual({ ok: false, error: "episodeStartedAt must be an ISO timestamp" });
  });

  it("caps the accepted payload before it reaches the trigger bus", () => {
    const result = normalizeDrasiIncident(
      {
        queryId: "dapr-resource-drift",
        incidentKey: "component/workflowstatestore",
        episodeStartedAt: "2026-07-21T12:00:00Z",
        evidence: { payload: "x".repeat(40_000) },
      },
      options,
    );
    expect(result).toEqual({ ok: false, error: "body exceeds 32768 bytes" });
  });
});
