import { describe, expect, it, vi } from "vitest";
import {
	ApplicationCodeFunctionParsePreviewService,
	type CodeFunctionParsePreviewPort,
} from "$lib/server/application/code-function-parse-preview";

describe("ApplicationCodeFunctionParsePreviewService", () => {
	it("validates and delegates parse-preview requests through a parser port", async () => {
		const parser: CodeFunctionParsePreviewPort = {
			parse: vi.fn(async () => ({ entrypoint: "main" })),
		};
		const service = new ApplicationCodeFunctionParsePreviewService(parser);

		await expect(
			service.parse({
				body: {
					language: "python",
					source: "def main(): pass",
					entrypoint: " main ",
					path: " app.py ",
					supporting_files: { "lib.py": "VALUE = 1", ignored: 12 },
				},
			}),
		).resolves.toEqual({ model: { entrypoint: "main" } });
		expect(parser.parse).toHaveBeenCalledWith({
			language: "python",
			source: "def main(): pass",
			entrypoint: "main",
			path: "app.py",
			supportingFiles: { "lib.py": "VALUE = 1" },
		});
	});

	it("maps validation and parser failures to application errors", async () => {
		const service = new ApplicationCodeFunctionParsePreviewService({
			parse: vi.fn(async () => {
				throw new Error("parser unavailable");
			}),
		});

		await expect(
			service.parse({ body: { language: "ruby", source: "puts 'hi'" } }),
		).rejects.toMatchObject({
			status: 400,
			message: "language must be typescript or python",
		});
		await expect(
			service.parse({ body: { language: "typescript", source: "export {}" } }),
		).rejects.toMatchObject({
			status: 502,
			message: "parser unavailable",
		});
	});
});
