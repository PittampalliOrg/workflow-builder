import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Canonical session-event publisher (services/shared/session_events/publisher.py)
// is vendored byte-identical into each Python agent runtime's build context.
// These guards fail if a copy is edited directly instead of the canonical +
// `node scripts/sync-runtime-registry.mjs`.
const CANONICAL = "services/shared/session_events/publisher.py";
const COPIES = [
	"services/dapr-agent-py/src/event_publisher.py",
	"services/claude-agent-py/src/event_publisher.py"
];

function read(rel: string): string {
	return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("shared session-event publisher — drift guard", () => {
	const canonical = read(CANONICAL);

	for (const copy of COPIES) {
		it(`${copy} is byte-identical to the canonical SSOT`, () => {
			expect(read(copy)).toBe(canonical);
		});
	}

	it("canonical keeps the incremental-tier gate + symbols every call-site imports", () => {
		// The gate is what keeps the byte-identical copy inert on runtimes that
		// don't ship src.compaction.tokens / src.telemetry.session_tracing
		// (claude-agent-py / adk-agent-py — incrementalEvents:false).
		for (const sym of [
			"def publish_session_event(",
			"def scope_session(",
			"def get_scoped_session(",
			"def set_notification_dispatcher(",
			"def set_audit_field_provider(",
			"def set_incremental_tier_enabled(",
			"INCREMENTAL_EVENTS_ENABLED"
		]) {
			expect(canonical.includes(sym), `missing ${sym}`).toBe(true);
		}
	});

	it("the incremental-tier defaults OFF (the import-bearing tier is gated)", () => {
		// Default must be OFF so a new runtime that vendors the copy without
		// opting in gets the safe simple path (no per-event import failures).
		expect(canonical).toContain('_env_bool("SESSION_EVENTS_INCREMENTAL", False)');
		// The dapr-specific imports live behind the gate, never at module top.
		expect(canonical).not.toMatch(/^from src\.compaction\.tokens import/m);
		expect(canonical).not.toMatch(/^from src\.telemetry\.session_tracing import/m);
	});
});
