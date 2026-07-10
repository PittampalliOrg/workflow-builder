import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ACTIONABLE_SEVERITIES = new Set(["error", "warn", "info"]);

export function normalizeViolation(violation) {
  if (!violation || typeof violation !== "object") {
    throw new TypeError("dependency-cruiser violation must be an object");
  }

  const normalized = {
    severity: violation.severity ?? violation.rule?.severity,
    rule: typeof violation.rule === "string" ? violation.rule : violation.rule?.name,
    type: violation.type,
    from: violation.from,
    to: violation.to,
    unresolvedTo: violation.unresolvedTo ?? null,
    dependencyTypes: [...(violation.dependencyTypes ?? [])].sort(),
  };

  for (const field of ["severity", "rule", "type", "from", "to"]) {
    if (typeof normalized[field] !== "string" || normalized[field].length === 0) {
      throw new TypeError(`dependency-cruiser violation is missing ${field}`);
    }
  }
  if (!ACTIONABLE_SEVERITIES.has(normalized.severity)) {
    throw new TypeError(`unsupported dependency-cruiser severity: ${normalized.severity}`);
  }
  if (!normalized.dependencyTypes.every((value) => typeof value === "string")) {
    throw new TypeError("dependencyTypes must contain only strings");
  }

  return normalized;
}

export function violationSignature(violation) {
  return JSON.stringify(normalizeViolation(violation));
}

export function compareViolations(baselineViolations, currentViolations) {
  const baseline = new Map(
    baselineViolations.map((violation) => [violationSignature(violation), normalizeViolation(violation)]),
  );
  const current = new Map(
    currentViolations.map((violation) => [violationSignature(violation), normalizeViolation(violation)]),
  );

  return {
    added: [...current.entries()]
      .filter(([signature]) => !baseline.has(signature))
      .map(([, violation]) => violation),
    removed: [...baseline.entries()]
      .filter(([signature]) => !current.has(signature))
      .map(([, violation]) => violation),
  };
}

export function createBaseline(violations, generatedFromCommit) {
  const normalized = violations
    .filter((violation) => ACTIONABLE_SEVERITIES.has(violation.rule?.severity ?? violation.severity))
    .map(normalizeViolation)
    .sort((left, right) => violationSignature(left).localeCompare(violationSignature(right)));
  return {
    schemaVersion: 1,
    generatedFromCommit,
    command:
      "pnpm exec depcruise src/lib/server src/routes --config .dependency-cruiser.cjs --output-type json",
    counts: countBySeverity(normalized),
    violations: normalized,
  };
}

export function validateBaseline(baseline) {
  if (baseline?.schemaVersion !== 1) {
    throw new Error("dependency boundary baseline must use schemaVersion 1");
  }
  if (!Array.isArray(baseline.violations)) {
    throw new Error("dependency boundary baseline violations must be an array");
  }

  const signatures = baseline.violations.map(violationSignature);
  if (new Set(signatures).size !== signatures.length) {
    throw new Error("dependency boundary baseline contains duplicate violations");
  }

  const counts = countBySeverity(baseline.violations);
  for (const severity of ACTIONABLE_SEVERITIES) {
    if (baseline.counts?.[severity] !== counts[severity]) {
      throw new Error(
        `dependency boundary baseline ${severity} count is ${baseline.counts?.[severity]}, expected ${counts[severity]}`,
      );
    }
  }
}

function countBySeverity(violations) {
  const counts = { error: 0, warn: 0, info: 0 };
  for (const violation of violations) {
    counts[normalizeViolation(violation).severity] += 1;
  }
  return counts;
}

function formatViolation(violation) {
  const target = violation.unresolvedTo ?? violation.to;
  return `${violation.severity} ${violation.rule}: ${violation.from} -> ${target}`;
}

async function run() {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(scriptDirectory, "../..");
  const baselinePath = join(scriptDirectory, "dependency-cruiser-baseline.json");

  const reportArgument = process.argv.indexOf("--write-baseline-from");
  if (reportArgument >= 0) {
    const reportPath = process.argv[reportArgument + 1];
    const commitArgument = process.argv.indexOf("--source-commit");
    const generatedFromCommit = process.argv[commitArgument + 1];
    if (!reportPath || !/^[a-f0-9]{40}$/.test(generatedFromCommit ?? "")) {
      throw new Error("baseline generation requires a report path and --source-commit <40-char SHA>");
    }
    const report = JSON.parse(await readFile(resolve(reportPath), "utf8"));
    const baseline = createBaseline(report.summary?.violations ?? [], generatedFromCommit);
    validateBaseline(baseline);
    await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
    console.log(`Wrote ${baseline.violations.length} violations to ${baselinePath}`);
    return;
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "workflow-builder-depcruise-"));
  const reportPath = join(temporaryDirectory, "report.json");

  try {
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    validateBaseline(baseline);

    const result = spawnSync(
      "pnpm",
      [
        "exec",
        "depcruise",
        "src/lib/server",
        "src/routes",
        "--config",
        ".dependency-cruiser.cjs",
        "--output-type",
        "json",
        "--output-to",
        reportPath,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) {
      process.stderr.write(result.stderr ?? "");
      throw new Error(
        `dependency-cruiser exited unexpectedly with status ${String(result.status)}`,
      );
    }

    let report;
    try {
      report = JSON.parse(await readFile(reportPath, "utf8"));
    } catch (error) {
      process.stderr.write(result.stderr ?? "");
      throw new Error(`dependency-cruiser did not produce a readable report: ${error.message}`);
    }

    const currentViolations = (report.summary?.violations ?? []).filter((violation) =>
      ACTIONABLE_SEVERITIES.has(violation.rule?.severity),
    );
    const currentSignatures = currentViolations.map(violationSignature);
    if (new Set(currentSignatures).size !== currentSignatures.length) {
      throw new Error("dependency-cruiser returned duplicate actionable violations");
    }
    const reportedCounts = {
      error: report.summary?.error ?? 0,
      warn: report.summary?.warn ?? 0,
      info: report.summary?.info ?? 0,
    };
    const computedCounts = countBySeverity(currentViolations);
    if (JSON.stringify(reportedCounts) !== JSON.stringify(computedCounts)) {
      throw new Error(
        `dependency-cruiser summary counts do not match its violations: ${JSON.stringify({ reportedCounts, computedCounts })}`,
      );
    }

    const comparison = compareViolations(baseline.violations, currentViolations);
    for (const violation of comparison.removed) {
      console.log(`REMOVED ${formatViolation(violation)}`);
    }
    for (const violation of comparison.added) {
      console.error(`ADDED ${formatViolation(violation)}`);
    }

    console.log(
      `Dependency boundary ratchet: ${computedCounts.error} errors, ${computedCounts.warn} warnings, ${computedCounts.info} info; ${comparison.removed.length} removed, ${comparison.added.length} added.`,
    );
    if (comparison.added.length > 0) process.exitCode = 1;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
