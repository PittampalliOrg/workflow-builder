import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const fixturePath = resolve(
	process.cwd(),
	"scripts/fixtures/generator-critic/coding-redesign-cli-showcase.json",
);

function loadFixture(): any {
	return JSON.parse(readFileSync(fixturePath, "utf8"));
}

describe("coding redesign CLI showcase fixture", () => {
	it("keeps preview startup in a workflow-owned command before the critic runs", () => {
		const spec = loadFixture();
		const refine = spec.do.find((entry: any) => entry.refine)?.refine;
		const tasks = refine.do as Array<Record<string, any>>;
		const names = tasks.map((entry) => Object.keys(entry)[0]);

		expect(names).toEqual(["generate", "gate", "start_preview", "evaluate", "read_verdict"]);

		const startPreview = tasks.find((entry) => entry.start_preview)?.start_preview;
		expect(startPreview.with.command).toContain("/sandbox/work/preview.pid");
		expect(startPreview.with.command).toContain("/sandbox/work/preview.url");
		expect(startPreview.with.command).toContain("npx vite preview");
		expect(startPreview.with.command).toContain("npx vite dev");

		const evaluate = tasks.find((entry) => entry.evaluate)?.evaluate;
		const instructions = evaluate.with.agentConfig.instructions;
		expect(instructions).toContain("workflow-owned preview lifecycle");
		expect(instructions).toContain("/sandbox/work/preview.url");
		expect(instructions).not.toContain("nohup npm run preview");
	});

	it("persists a deterministic screenshot artifact from critic-shot.png", () => {
		const spec = loadFixture();
		const publishShot = spec.do.find((entry: any) => entry.publish_shot)?.publish_shot;

		expect(publishShot.with.readFile).toBe("/sandbox/work/critic-shot.png");
		expect(publishShot.with.command).toContain("chrome-linux64/chrome");
		expect(publishShot.with.command).toContain("--screenshot=\"$SHOT\"");
		expect(publishShot.with.command).not.toContain("pkill");
		expect(publishShot.artifacts).toContainEqual(
			expect.objectContaining({
				fileId: "${ .data.fileId }",
				kind: "image",
				slot: "primary",
			}),
		);
	});
});
