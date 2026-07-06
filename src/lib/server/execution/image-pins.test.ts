import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	loadExecutionClassesJson,
	loadImagePins,
	resolveImagePin,
} from "./image-pins";

let dir: string;

function writeFixture(name: string, content: string): string {
	const path = join(dir, name);
	writeFileSync(path, content);
	return path;
}

describe("image-pins file-first readers", () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "image-pins-"));
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("loadImagePins", () => {
		it("reads the pin file into an env-key → image map", () => {
			const file = writeFixture(
				"runtime-images.json",
				JSON.stringify({ FOO_DEV_IMAGE: "img:a", BAR_DEV_IMAGE: "img:b" }),
			);
			expect(loadImagePins({ WORKFLOW_BUILDER_IMAGE_PINS_FILE: file })).toEqual({
				FOO_DEV_IMAGE: "img:a",
				BAR_DEV_IMAGE: "img:b",
			});
		});

		it("returns {} when the file env is unset", () => {
			expect(loadImagePins({})).toEqual({});
		});

		it("returns {} when the file is missing", () => {
			expect(
				loadImagePins({ WORKFLOW_BUILDER_IMAGE_PINS_FILE: join(dir, "absent.json") }),
			).toEqual({});
		});

		it("returns {} on invalid JSON", () => {
			const file = writeFixture("runtime-images.json", "{ not json");
			expect(loadImagePins({ WORKFLOW_BUILDER_IMAGE_PINS_FILE: file })).toEqual({});
		});

		it("ignores non-string / empty values", () => {
			const file = writeFixture(
				"runtime-images.json",
				JSON.stringify({ A: "img:a", B: 5, C: "" }),
			);
			expect(loadImagePins({ WORKFLOW_BUILDER_IMAGE_PINS_FILE: file })).toEqual({
				A: "img:a",
			});
		});
	});

	describe("resolveImagePin", () => {
		it("prefers the file pin over the pod env, else env, else null", () => {
			const file = writeFixture(
				"runtime-images.json",
				JSON.stringify({ FOO_DEV_IMAGE: "img:file" }),
			);
			// file wins
			expect(
				resolveImagePin("FOO_DEV_IMAGE", {
					WORKFLOW_BUILDER_IMAGE_PINS_FILE: file,
					FOO_DEV_IMAGE: "img:env",
				}),
			).toBe("img:file");
			// no file entry → env
			expect(
				resolveImagePin("BAR_DEV_IMAGE", {
					WORKFLOW_BUILDER_IMAGE_PINS_FILE: file,
					BAR_DEV_IMAGE: "img:env",
				}),
			).toBe("img:env");
			// neither → null
			expect(resolveImagePin("BAZ_DEV_IMAGE", {})).toBeNull();
		});
	});

	describe("loadExecutionClassesJson", () => {
		it("prefers the mounted classes file over the env JSON, else null", () => {
			const file = writeFixture("classes.json", '{"from":"file"}');
			expect(
				loadExecutionClassesJson({
					SANDBOX_EXECUTION_CLASSES_FILE: file,
					SANDBOX_EXECUTION_CLASSES_JSON: '{"from":"env"}',
				}),
			).toBe('{"from":"file"}');
			expect(
				loadExecutionClassesJson({ SANDBOX_EXECUTION_CLASSES_JSON: '{"from":"env"}' }),
			).toBe('{"from":"env"}');
			expect(loadExecutionClassesJson({})).toBeNull();
		});

		it("falls back to the env JSON when the file is missing/empty", () => {
			expect(
				loadExecutionClassesJson({
					SANDBOX_EXECUTION_CLASSES_FILE: join(dir, "absent.json"),
					SANDBOX_EXECUTION_CLASSES_JSON: '{"from":"env"}',
				}),
			).toBe('{"from":"env"}');
			const empty = writeFixture("empty.json", "   ");
			expect(
				loadExecutionClassesJson({
					SANDBOX_EXECUTION_CLASSES_FILE: empty,
					SANDBOX_EXECUTION_CLASSES_JSON: '{"from":"env"}',
				}),
			).toBe('{"from":"env"}');
		});
	});
});
