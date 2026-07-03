import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	preset: { id: "preset-1", name: "Review" },
	promptPresets: {
		list: vi.fn(async () => ({
			presets: [{ id: "preset-1", name: "Review" }],
		})),
		create: vi.fn(async () => ({
			preset: { id: "preset-1", name: "Review" },
		})),
		update: vi.fn(async () => ({
			preset: { id: "preset-1", name: "Updated" },
		})),
		archive: vi.fn(async () => ({ archived: true as const })),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		promptPresets: mocks.promptPresets,
	}),
}));

import { GET, POST } from "./+server";
import { DELETE, PUT } from "./[id]/+server";

describe("/api/prompt-presets routes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps prompt preset persistence behind the application service", () => {
		const routeDir = dirname(fileURLToPath(import.meta.url));
		for (const routePath of ["+server.ts", "[id]/+server.ts"]) {
			const source = readFileSync(join(routeDir, routePath), "utf8");

			expect(source).toContain("promptPresets");
			expect(source).not.toContain("$lib/server/prompt-presets");
			expect(source).not.toContain("$lib/server/db");
			expect(source).not.toContain("$lib/server/db/schema");
			expect(source).not.toContain("drizzle-orm");
		}
	});

	it("delegates list/create/update/archive behavior", async () => {
		const locals = { session: { userId: "user-1", projectId: "project-1" } };

		const listResponse = await GET({
			locals,
			url: new URL("http://localhost/api/prompt-presets?includeDisabled=true"),
		} as never);
		expect(listResponse.status).toBe(200);
		await expect(listResponse.json()).resolves.toEqual({
			presets: [{ id: "preset-1", name: "Review" }],
		});
		expect(mocks.promptPresets.list).toHaveBeenCalledWith({
			projectId: "project-1",
			includeDisabled: true,
		});

		const createBody = { name: "Review" };
		const createResponse = await POST({
			locals,
			request: new Request("http://localhost/api/prompt-presets", {
				method: "POST",
				body: JSON.stringify(createBody),
			}),
		} as never);
		expect(createResponse.status).toBe(201);
		expect(mocks.promptPresets.create).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
			body: createBody,
		});

		const updateBody = { name: "Updated" };
		const updateResponse = await PUT({
			params: { id: "preset-1" },
			locals,
			request: new Request("http://localhost/api/prompt-presets/preset-1", {
				method: "PUT",
				body: JSON.stringify(updateBody),
			}),
		} as never);
		expect(updateResponse.status).toBe(200);
		expect(mocks.promptPresets.update).toHaveBeenCalledWith({
			id: "preset-1",
			projectId: "project-1",
			userId: "user-1",
			body: updateBody,
		});

		const deleteResponse = await DELETE({
			params: { id: "preset-1" },
			locals,
		} as never);
		expect(deleteResponse.status).toBe(200);
		await expect(deleteResponse.json()).resolves.toEqual({ archived: true });
		expect(mocks.promptPresets.archive).toHaveBeenCalledWith({
			id: "preset-1",
			projectId: "project-1",
		});
	});
});
