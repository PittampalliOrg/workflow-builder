import { describe, expect, it } from "vitest";

import { createCachedLoader } from "./cache";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("createCachedLoader", () => {
	it("dedupes concurrent callers into one upstream load", async () => {
		let calls = 0;
		const gate = deferred<string>();
		const loader = createCachedLoader({
			ttlMs: 1000,
			load: () => {
				calls += 1;
				return gate.promise;
			},
		});

		const first = loader.get();
		const second = loader.get();
		gate.resolve("value");
		await expect(first).resolves.toBe("value");
		await expect(second).resolves.toBe("value");
		expect(calls).toBe(1);
	});

	it("serves the cached value within the TTL and reloads after expiry", async () => {
		let calls = 0;
		let clock = 0;
		const loader = createCachedLoader({
			ttlMs: 1000,
			now: () => clock,
			load: async () => {
				calls += 1;
				return `load-${calls}`;
			},
		});

		await expect(loader.get()).resolves.toBe("load-1");
		clock = 999;
		await expect(loader.get()).resolves.toBe("load-1");
		clock = 1001;
		await expect(loader.get()).resolves.toBe("load-2");
		expect(calls).toBe(2);
	});

	it("serves the stale value on a failed refresh (stale-on-error)", async () => {
		let calls = 0;
		let clock = 0;
		const loader = createCachedLoader({
			ttlMs: 1000,
			errorTtlMs: 100,
			now: () => clock,
			load: async () => {
				calls += 1;
				if (calls > 1) throw new Error("upstream down");
				return "good";
			},
		});

		await expect(loader.get()).resolves.toBe("good");
		clock = 2000;
		await expect(loader.get()).resolves.toBe("good");
		expect(calls).toBe(2);
		// The stale value is re-cached for errorTtlMs only.
		clock = 2099;
		await expect(loader.get()).resolves.toBe("good");
		expect(calls).toBe(2);
		clock = 2101;
		await expect(loader.get()).resolves.toBe("good");
		expect(calls).toBe(3);
	});

	it("routes a first-load failure through the fallback and caches it briefly", async () => {
		let calls = 0;
		let clock = 0;
		const loader = createCachedLoader<string>({
			ttlMs: 1000,
			errorTtlMs: 100,
			now: () => clock,
			load: async () => {
				calls += 1;
				throw new Error("down");
			},
			fallback: (cause, stale) =>
				stale ?? `fallback:${(cause as Error).message}`,
		});

		await expect(loader.get()).resolves.toBe("fallback:down");
		clock = 99;
		await expect(loader.get()).resolves.toBe("fallback:down");
		expect(calls).toBe(1);
		clock = 101;
		await expect(loader.get()).resolves.toBe("fallback:down");
		expect(calls).toBe(2);
	});

	it("throws when the first load fails and no fallback exists", async () => {
		const loader = createCachedLoader<string>({
			ttlMs: 1000,
			load: async () => {
				throw new Error("boom");
			},
		});
		await expect(loader.get()).rejects.toThrow("boom");
		// The failure is not cached — the next call retries.
		await expect(loader.get()).rejects.toThrow("boom");
	});

	it("invalidate() forces the next get() to reload", async () => {
		let calls = 0;
		const loader = createCachedLoader({
			ttlMs: 60_000,
			load: async () => {
				calls += 1;
				return calls;
			},
		});
		await expect(loader.get()).resolves.toBe(1);
		loader.invalidate();
		await expect(loader.get()).resolves.toBe(2);
	});
});
