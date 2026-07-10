import assert from "node:assert/strict";
import test from "node:test";
import {
  compareViolations,
  createBaseline,
  normalizeViolation,
  validateBaseline,
  violationSignature,
} from "./check-dependency-boundaries.mjs";

function violation(overrides = {}) {
  return {
    type: "dependency",
    from: "src/routes/example/+server.ts",
    to: "src/lib/server/db/index.ts",
    unresolvedTo: "$lib/server/db",
    dependencyTypes: ["import", "undetermined"],
    rule: { severity: "error", name: "db-only-in-adapters" },
    ...overrides,
  };
}

test("normalizes dependency type ordering into a stable exact signature", () => {
  const forward = violation();
  const reverse = violation({ dependencyTypes: ["undetermined", "import"] });
  assert.equal(violationSignature(forward), violationSignature(reverse));
  assert.deepEqual(normalizeViolation(forward).dependencyTypes, ["import", "undetermined"]);
});

test("reports additions and removals independently", () => {
  const legacy = violation();
  const added = violation({
    from: "src/routes/new/+server.ts",
    rule: { severity: "warn", name: "routes-through-application" },
  });
  assert.deepEqual(compareViolations([legacy], [added]), {
    added: [normalizeViolation(added)],
    removed: [normalizeViolation(legacy)],
  });
});

test("accepts a reduced current set without treating removed debt as an addition", () => {
  const first = violation();
  const second = violation({ from: "src/routes/legacy/+server.ts" });
  assert.deepEqual(compareViolations([first, second], [first]), {
    added: [],
    removed: [normalizeViolation(second)],
  });
});

test("creates a deterministic baseline with computed severity counts", () => {
  const warning = violation({
    from: "src/routes/legacy/+server.ts",
    rule: { severity: "warn", name: "routes-through-application" },
  });
  const baseline = createBaseline([warning, violation()], "a".repeat(40));
  assert.deepEqual(baseline.counts, { error: 1, warn: 1, info: 0 });
  assert.equal(baseline.violations[0].severity, "error");
  validateBaseline(baseline);
});

test("rejects malformed counts and duplicate baseline entries", () => {
  const entry = normalizeViolation(violation());
  assert.throws(
    () =>
      validateBaseline({
        schemaVersion: 1,
        counts: { error: 2, warn: 0, info: 0 },
        violations: [entry, entry],
      }),
    /duplicate/,
  );
  assert.throws(
    () =>
      validateBaseline({
        schemaVersion: 1,
        counts: { error: 0, warn: 0, info: 0 },
        violations: [entry],
      }),
    /error count/,
  );
});
