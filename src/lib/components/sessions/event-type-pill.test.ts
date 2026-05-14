import { describe, expect, it } from "vitest";
import { eventKindFor } from "./event-type-pill.svelte";

describe("eventKindFor", () => {
  it("groups ADK event-action events into the ADK bucket", () => {
    expect(eventKindFor("adk.state_delta")).toBe("adk");
    expect(eventKindFor("adk.artifact_delta")).toBe("adk");
    expect(eventKindFor("adk.auth_request")).toBe("adk");
    expect(eventKindFor("adk.tool_confirmation_request")).toBe("adk");
    expect(eventKindFor("adk.transfer")).toBe("adk");
    expect(eventKindFor("adk.escalation")).toBe("adk");
    expect(eventKindFor("adk.ui_widget")).toBe("adk");
  });

	it("leaves unknown event types on the raw event path", () => {
		expect(eventKindFor("adkx.state_delta")).toBe("other");
		expect(eventKindFor("vendor.custom")).toBe("other");
	});

	it("groups llm_start with model events", () => {
		expect(eventKindFor("llm_start")).toBe("model");
	});
});
