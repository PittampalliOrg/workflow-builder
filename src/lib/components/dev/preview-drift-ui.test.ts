/**
 * Source-contract tests for the Dev-page drift makeover (U2), following the
 * `dev-service-card.test.ts` precedent: assert the load-bearing wiring in the
 * component sources so refactors cannot silently drop it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(join(here, relative), "utf8");

const panel = read("vcluster-preview-panel.svelte");
const header = read("dev-context-header.svelte");
const dialog = read("dev-launch-dialog.svelte");
const page = read("../../../routes/workspaces/[slug]/dev/+page.svelte");

describe("vcluster preview panel drift wiring", () => {
  it("wires the Phase-1 retained-lifecycle commands", () => {
    expect(panel).toContain("releaseDevLease({ previewName: p.name })");
    expect(panel).toContain("freezePreviewSources({ previewName: p.name })");
  });

  it("records unsupported refusals and disables the actions with the refusal as tooltip", () => {
    expect(panel).toContain("markRetentionUnsupported(p.name, 'release', result.message)");
    expect(panel).toContain("markRetentionUnsupported(p.name, 'freeze', result.message)");
    expect(panel).toContain("disabled={!!unsupported?.freeze || p.state === 'slept'}");
    expect(panel).toContain("disabled={!!unsupported?.release || p.state === 'slept'}");
    expect(panel).toContain("title={unsupported?.freeze ??");
    expect(panel).toContain("title={unsupported?.release ??");
  });

  it("renders the stage badge and per-service drift rows from the shared overview", () => {
    expect(panel).toContain("driftEntryFor(drift, p.name)");
    expect(panel).toContain("<PreviewStageBadge stage={driftEntry.stage}");
    expect(panel).toContain("<PreviewServiceDriftList");
  });

  it("surfaces the revert-risk warnings", () => {
    expect(panel).toContain("assessRevertRisk({");
    expect(panel).toContain("risk?.uncapturedSleep");
    expect(panel).toContain("risk?.migrationDrift");
  });

  it("offers agent-run launch and the re-attach deep link", () => {
    expect(panel).toContain("onlaunchagent?.(p.name)");
    expect(panel).toContain("reattachHref(slug, p.name)");
  });
});

describe("dev page shared-tick wiring", () => {
  it("keeps the drift query on the single visibility-gated tick", () => {
    expect(page).toContain("const driftQuery = controlPlane ? getPreviewDriftOverview() : null;");
    expect(page).toContain("if (driftQuery) refreshes.push(driftQuery.refresh()");
  });

  it("feeds the overview to the header and the previews panel", () => {
    expect(header).toContain("<PreviewDriftSummaryChips overview={drift}");
    expect(page).toContain("onlaunchagent={launchAgentRun}");
    expect(page).toContain("{sessionLinks}");
  });

  it("prefills the launch dialog for re-attach / agent runs", () => {
    expect(page).toContain("prefillEnvironmentName={launchPrefillName}");
    expect(dialog).toContain(
      "if (prefillEnvironmentName !== null) environmentName = prefillEnvironmentName;",
    );
  });
});
