import { describe, expect, it } from "vitest";

import { SESSION_PROVISIONING_EVENT_TYPES } from "./session-stream-events";

describe("session stream event subscriptions", () => {
	it("subscribes to every canonical sandbox provisioning transition", () => {
		expect(SESSION_PROVISIONING_EVENT_TYPES).toEqual([
			"session.provisioning_admitted",
			"session.provisioning_scheduled",
			"session.provisioning_pulling",
			"session.provisioning_pulled",
			"session.provisioning_initialized",
			"session.provisioning_running",
			"session.provisioning_failed",
		]);
		expect(new Set(SESSION_PROVISIONING_EVENT_TYPES).size).toBe(
			SESSION_PROVISIONING_EVENT_TYPES.length,
		);
	});
});
