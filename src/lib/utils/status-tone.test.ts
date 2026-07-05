import { describe, expect, it } from "vitest";
import {
	resolveStatusTone,
	statusToneLabel,
	statusTonePillClass,
	statusToneTextClass,
} from "./status-tone";

describe("resolveStatusTone", () => {
	it("classifies the execution-badge exact statuses", () => {
		expect(resolveStatusTone("success")).toBe("success");
		expect(resolveStatusTone("completed")).toBe("success");
		expect(resolveStatusTone("running")).toBe("active");
		expect(resolveStatusTone("error")).toBe("danger");
		expect(resolveStatusTone("failed")).toBe("danger");
		expect(resolveStatusTone("pending")).toBe("pending");
		expect(resolveStatusTone("cancelled")).toBe("warning");
		expect(resolveStatusTone("terminated")).toBe("muted");
	});

	it("classifies the fleet compound statuses via substrings", () => {
		expect(resolveStatusTone("InferenceRunning")).toBe("active");
		expect(resolveStatusTone("grading")).toBe("active");
		expect(resolveStatusTone("Rescheduling")).toBe("pending");
		expect(resolveStatusTone("StartupTimeout")).toBe("danger");
		expect(resolveStatusTone("Finishing")).toBe("muted");
	});

	it("classifies the preview/PR lifecycle statuses", () => {
		expect(resolveStatusTone("provisioning")).toBe("pending");
		expect(resolveStatusTone("seeding")).toBe("active");
		expect(resolveStatusTone("ready")).toBe("success");
		expect(resolveStatusTone("capacity_full")).toBe("warning");
		expect(resolveStatusTone("slept")).toBe("warning");
		expect(resolveStatusTone("absent")).toBe("muted");
	});

	it("is safe on null/empty/unknown input", () => {
		expect(resolveStatusTone(null)).toBe("muted");
		expect(resolveStatusTone(undefined)).toBe("muted");
		expect(resolveStatusTone("")).toBe("muted");
		expect(resolveStatusTone("some-novel-status")).toBe("muted");
	});

	it("failure words win over activity words in compounds", () => {
		expect(resolveStatusTone("RunFailed")).toBe("danger");
		expect(resolveStatusTone("running-with-errors")).toBe("danger");
	});
});

describe("tone class helpers", () => {
	it("every tone maps to non-empty distinct classes", () => {
		const tones = ["success", "active", "pending", "warning", "danger", "muted"] as const;
		const text = tones.map(statusToneTextClass);
		const pill = tones.map(statusTonePillClass);
		expect(new Set(text).size).toBe(tones.length);
		expect(new Set(pill).size).toBe(tones.length);
		for (const c of [...text, ...pill]) expect(c.length).toBeGreaterThan(0);
	});
});

describe("statusToneLabel", () => {
	it("maps completed to Success and capitalizes the rest", () => {
		expect(statusToneLabel("completed")).toBe("Success");
		expect(statusToneLabel("capacity_full")).toBe("Capacity full");
		expect(statusToneLabel("running")).toBe("Running");
	});
});
