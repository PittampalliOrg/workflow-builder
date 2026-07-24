import { describe, expect, it } from "vitest";
import { isSnapshotSeedPath, snapshotSeedNodeId } from "./snapshot-seed";

describe("isSnapshotSeedPath", () => {
	it("recognizes a node-boundary snapshot seed path", () => {
		expect(isSnapshotSeedPath(".snapshots/instance-root/build")).toBe(true);
	});

	it("treats a bare end-state workspace key as not a snapshot seed", () => {
		expect(isSnapshotSeedPath("sw-example-exec-root")).toBe(false);
	});

	it("is false for null/undefined/empty (normal, non-fork runs)", () => {
		expect(isSnapshotSeedPath(null)).toBe(false);
		expect(isSnapshotSeedPath(undefined)).toBe(false);
		expect(isSnapshotSeedPath("")).toBe(false);
	});

	it("does not match a path that merely contains .snapshots later", () => {
		expect(isSnapshotSeedPath("workspace/.snapshots/x/y")).toBe(false);
	});
});

describe("snapshotSeedNodeId", () => {
	it("returns the trailing node id from a snapshot path", () => {
		expect(snapshotSeedNodeId(".snapshots/instance-root/build")).toBe("build");
	});

	it("returns the last segment for a deeper snapshot path", () => {
		expect(snapshotSeedNodeId(".snapshots/key/nested/node")).toBe("node");
	});

	it("returns null for non-snapshot seeds", () => {
		expect(snapshotSeedNodeId("sw-example-exec-root")).toBeNull();
		expect(snapshotSeedNodeId(null)).toBeNull();
	});

	it("returns null when the path has no node segment", () => {
		expect(snapshotSeedNodeId(".snapshots/key")).toBeNull();
	});
});
