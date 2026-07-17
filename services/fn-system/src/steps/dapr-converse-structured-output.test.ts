import { describe, expect, it } from "vitest";
import {
  DAPR_CONVERSE_STRUCTURED_OUTPUT_ACTIONS,
  buildDaprRequest,
} from "./dapr-converse-structured-output";

const responseFormat = {
  type: "object",
  properties: { result: { type: "string" } },
  required: ["result"],
  additionalProperties: false,
};

function asRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

describe("dapr-converse structured-output Kimi K3 contract", () => {
  it("publishes Kimi K3 as the first and only Kimi catalog action", () => {
    expect(
      DAPR_CONVERSE_STRUCTURED_OUTPUT_ACTIONS.map((action) => action.id),
    ).toEqual([
      "system-dapr-converse-kimi-k3-structured",
      "system-dapr-converse-openai-structured",
      "system-dapr-converse-anthropic-structured",
    ]);

    const kimiActions = DAPR_CONVERSE_STRUCTURED_OUTPUT_ACTIONS.filter(
      (action) =>
        `${action.id} ${action.name} ${action.displayName} ${action.tags.join(" ")}`
          .toLowerCase()
          .includes("kimi"),
    );
    expect(kimiActions).toHaveLength(1);

    const action = kimiActions[0];
    expect(action).toMatchObject({
      id: "system-dapr-converse-kimi-k3-structured",
      displayName: "Kimi K3 Structured Output",
      pieceName: "system",
      actionName: "dapr-converse-structured-output",
    });

    const taskConfig = asRecord(action.taskConfig);
    const withBlock = asRecord(taskConfig.with);
    const body = asRecord(withBlock.body);
    const input = asRecord(body.input);
    expect(input).toMatchObject({
      componentName: "llm-kimi-k3",
      model: "kimi-k3",
    });

    const parameters = asRecord(input.parameters);
    expect(parameters).toEqual({
      model: {
        "@type": "type.googleapis.com/google.protobuf.StringValue",
        value: "kimi-k3",
      },
      reasoning_effort: {
        "@type": "type.googleapis.com/google.protobuf.StringValue",
        value: "max",
      },
      max_completion_tokens: {
        "@type": "type.googleapis.com/google.protobuf.Int64Value",
        value: "131072",
      },
    });

    const signature = asRecord(action.signature);
    const inputSchema = asRecord(signature.inputSchema);
    const properties = asRecord(inputSchema.properties);
    expect(properties.temperature).toBeUndefined();
    expect(asRecord(properties.componentName).default).toBe("llm-kimi-k3");
    expect(asRecord(properties.model).default).toBe("kimi-k3");
  });

  it("forces K3 max reasoning and the 131072 completion default", () => {
    const request = buildDaprRequest({
      componentName: "llm-kimi-k3",
      prompt: "Return JSON.",
      responseFormat,
      model: "kimi-k2.6",
      temperature: 0,
      metadata: { trace_id: "trace-1", model: "kimi-k2.6" },
      parameters: {
        custom: "kept",
        thinking: { type: "enabled" },
        reasoningEffort: "low",
        reasoning_effort: "low",
        max_tokens: 512,
        max_completion_tokens: 512,
        top_p: 0.2,
      },
    });

    expect(request).not.toHaveProperty("temperature");
    expect(request.metadata).toEqual({ trace_id: "trace-1" });
    expect(request.parameters).toEqual({
      custom: "kept",
      model: {
        "@type": "type.googleapis.com/google.protobuf.StringValue",
        value: "kimi-k3",
      },
      reasoning_effort: {
        "@type": "type.googleapis.com/google.protobuf.StringValue",
        value: "max",
      },
      max_completion_tokens: {
        "@type": "type.googleapis.com/google.protobuf.Int64Value",
        value: "131072",
      },
    });
  });

  it("preserves explicit alternatives without applying the K3 contract", () => {
    const request = buildDaprRequest({
      componentName: "workflow-llm-openai",
      prompt: "Return JSON.",
      responseFormat,
      model: "gpt-4.1",
      temperature: 0.2,
      parameters: { max_tokens: 256 },
    });

    expect(request.temperature).toBe(0.2);
    expect(request.parameters).toEqual({
      max_tokens: 256,
      model: {
        "@type": "type.googleapis.com/google.protobuf.StringValue",
        value: "gpt-4.1",
      },
    });
    expect(request.parameters).not.toHaveProperty("reasoning_effort");
  });
});
