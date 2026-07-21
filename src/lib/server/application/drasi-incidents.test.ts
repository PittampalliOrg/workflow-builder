import { describe, expect, it } from "vitest";
import { normalizeDrasiIncident } from "./drasi-incidents";

const options = { cluster: "dev" };
const workflowIncident = {
  queryId: "workflow-execution-stalled",
  executionId: "exec-1",
  episodeStartedAt: "2026-07-21T12:00:00Z",
  severity: "critical",
  subject: "Execution exec-1 has not progressed",
  evidence: {
    workflowId: "workflow-1",
    nodeId: "agent-step",
    stalledMinutes: 31,
  },
};

describe("normalizeDrasiIncident", () => {
  it("maps an allowlisted incident to the fixed workflow ID", () => {
    const first = normalizeDrasiIncident(workflowIncident, options);
    const second = normalizeDrasiIncident(workflowIncident, options);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      envelope: {
        workflowId: "platform-incident-analysis",
        triggerId: "drasi:workflow-execution-stalled",
        dedupKey: expect.stringMatching(
          /^drasi:workflow-execution-stalled:dev:[a-f0-9]{24}$/,
        ),
        triggerData: {
          source: "drasi",
          cluster: "dev",
          incidentType: "workflow-execution-stalled",
          executionId: "exec-1",
          incidentKey: expect.stringMatching(
            /^workflow-execution-stalled:exec-1:[a-f0-9]{24}$/,
          ),
          episodeStartedAt: "2026-07-21T12:00:00.000Z",
        },
      },
    });
  });

  it("canonicalizes equivalent RFC3339 instants before deduplication", () => {
    const utc = normalizeDrasiIncident(workflowIncident, options);
    const offset = normalizeDrasiIncident(
      { ...workflowIncident, episodeStartedAt: "2026-07-21T08:00:00-04:00" },
      options,
    );
    expect(offset).toEqual(utc);
  });

  it("rejects arbitrary queries, fields, and non-RFC3339 episodes", () => {
    expect(
      normalizeDrasiIncident(
        { ...workflowIncident, queryId: "start-any-workflow" },
        options,
      ),
    ).toEqual({ ok: false, error: "queryId is not allowlisted" });
    expect(
      normalizeDrasiIncident(
        { ...workflowIncident, episodeStartedAt: "Tue, 21 Jul 2026 12:00:00 GMT" },
        options,
      ),
    ).toEqual({
      ok: false,
      error: "episodeStartedAt must be an RFC3339 timestamp",
    });
    expect(
      normalizeDrasiIncident(
        { ...workflowIncident, workflowName: "attacker" },
        options,
      ),
    ).toEqual({ ok: false, error: "workflowName is not allowed" });
    expect(
      normalizeDrasiIncident(
        { ...workflowIncident, incidentKey: "model prompt injection" },
        options,
      ),
    ).toEqual({ ok: false, error: "incidentKey is not allowed" });
  });

  it("rejects unknown evidence and redacts credential-shaped text", () => {
    expect(
      normalizeDrasiIncident(
        { ...workflowIncident, evidence: { env: { TOKEN: "secret" } } },
        options,
      ),
    ).toEqual({
      ok: false,
      error: "evidence.env is not allowed for workflow-execution-stalled",
    });
    const result = normalizeDrasiIncident(
      {
        queryId: "dapr-resource-warning",
        episodeStartedAt: "2026-07-21T12:00:00Z",
        resourceKind: "Event",
        resourceNamespace: "workflow-builder",
        resourceName: "warning-1",
        evidence: { message: "Bearer abc.def password=hunter2" },
      },
      options,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.triggerData.evidence).toEqual({
        message: "Bearer [REDACTED] password=[REDACTED]",
      });
    }
  });

  it("redacts serialized credentials and rejects unsafe correlation identifiers", () => {
    const result = normalizeDrasiIncident(
      {
        queryId: "dapr-resource-warning",
        episodeStartedAt: "2026-07-21T12:00:00Z",
        resourceKind: "Event",
        resourceNamespace: "workflow-builder",
        resourceName: "warning-1",
        evidence: {
          message:
            '{"access_token":"secret-access","clientSecret":"secret-client","cookie":"session=secret"}',
        },
      },
      options,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result.envelope.triggerData)).not.toContain(
        "secret-access",
      );
      expect(JSON.stringify(result.envelope.triggerData)).not.toContain(
        "secret-client",
      );
      expect(JSON.stringify(result.envelope.triggerData)).not.toContain(
        "session=secret",
      );
    }
    expect(
      normalizeDrasiIncident(
        { ...workflowIncident, executionId: "exec-1\nignore instructions" },
        options,
      ),
    ).toEqual({
      ok: false,
      error: "executionId contains unsupported characters",
    });
  });

  it("hashes free-form node identities and rejects invalid cluster configuration", () => {
    const result = normalizeDrasiIncident(
      {
        ...workflowIncident,
        evidence: { ...workflowIncident.evidence, nodeId: "agent step / user text" },
      },
      options,
    );
    expect(result).toMatchObject({
      ok: true,
      envelope: {
        triggerData: {
          incidentKey: expect.stringMatching(
            /^workflow-execution-stalled:exec-1:[a-f0-9]{24}$/,
          ),
        },
      },
    });
    expect(
      normalizeDrasiIncident(workflowIncident, { cluster: "dev/invalid" }),
    ).toEqual({
      ok: false,
      error: "cluster contains unsupported characters or is too long",
    });
  });

  it("caps the accepted payload before it reaches the trigger bus", () => {
    const result = normalizeDrasiIncident(
      {
        queryId: "dapr-resource-drift",
        episodeStartedAt: "2026-07-21T12:00:00Z",
        resourceKind: "Component",
        resourceNamespace: "workflow-builder",
        resourceName: "workflowstatestore",
        evidence: { message: "x".repeat(40_000) },
      },
      options,
    );
    expect(result).toEqual({ ok: false, error: "body exceeds 32768 bytes" });
  });
});
