/**
 * The `trace-deep-analysis` dynamic-script workflow — the platform analyzing
 * itself: four parallel lens reviewers (performance / cost / reliability /
 * quality), each investigating the target run through the trace_* MCP tools
 * (auto-wired into every script-spawned session), then a schema'd synthesis
 * (hybrid-routed to the strict structured-output model) producing a
 * TraceAnalysisReport with ranked improvements — including complete revised
 * scripts the UI can apply after user confirmation.
 *
 * Seeded per project on first use (upsert by name, save-script semantics).
 */
import { getApplicationAdapters } from '$lib/server/application';

export const TRACE_ANALYSIS_WORKFLOW_NAME = 'trace-deep-analysis';

/** Bump when ANALYSIS_SCRIPT changes — drives the seeded-workflow upsert. */
const SCRIPT_VERSION = 'v1';

export const ANALYSIS_SCRIPT = `export const meta = {
  name: "trace-deep-analysis",
  description: "Multi-agent trace review (${SCRIPT_VERSION}): parallel performance/cost/reliability/quality lenses over a run's OpenTelemetry trace, synthesized into a quality report with ranked, appliable improvements.",
  phases: [{ title: "Review" }, { title: "Synthesize" }]
};

const target = args && args.executionId ? String(args.executionId) : null;
const targetScript = args && args.script ? String(args.script) : null;
const targetWorkflow = args && args.workflowName ? String(args.workflowName) : "the workflow";
if (!target) {
  return { error: "args.executionId is required" };
}

const toolGuide = [
  "You have MCP trace tools for this platform:",
  "- trace_get_digest({executionId}) — ALWAYS call this first: status, phases, durations, tokens/cost, cache hit rate, critical path, issues.",
  "- trace_search_spans({executionId, query?, errorsOnly?, limit?}) — find spans by substring.",
  "- trace_get_llm_turn({executionId, sessionId|spanId}) — an agent's actual LLM input/output messages.",
  "- trace_get_logs({executionId, spanId?, errorsOnly?}) — correlated log lines.",
  \`Analyze ONLY execution "\${target}". Be concrete: quote durations, token counts, span names, session ids.\`
].join("\\n");

phase("Review");
const LENSES = [
  { key: "performance", brief: "Latency and the critical path: where did wall-clock actually go? Separate sandbox provisioning from LLM time from tool time. Quantify the single biggest wait and whether parallel phases actually overlapped." },
  { key: "cost", brief: "Tokens and dollars: per-phase and per-call spend, cache hit rate (and WHY it is what it is), wasted tokens (retries, oversized prompts, redundant context), and the cheapest configuration that would produce the same result." },
  { key: "reliability", brief: "Errors, retries, and noise: triage EVERY issue in the digest as benign (expected teardown, cancellations) or actionable (real failures, silent nulls, retry storms), with evidence for each verdict." },
  { key: "quality", brief: "Output quality: read the final phase's LLM turns where available; judge whether prompts were well-formed, whether structured output was used where it should be, and whether the run's result matches the workflow's stated intent." }
];

const reviews = await parallel(
  LENSES.map((l) => () =>
    agent(
      \`You are the \${l.key} reviewer for a workflow trace.\\n\${toolGuide}\\n\\nFocus: \${l.brief}\\n\\nReturn a tight review: 3-6 bullet findings, each with evidence (numbers, span/session ids), then a final line "MOST IMPACTFUL: <the one change that matters most from your lens>".\`,
      { label: "review:" + l.key }
    )
  )
);

phase("Synthesize");
const corpus = LENSES.map((l, i) => "## " + l.key + "\\n" + (reviews[i] || "(reviewer failed)")).join("\\n\\n");
const scriptSection = targetScript
  ? "\\n\\nThe target workflow's SOURCE SCRIPT (dynamic-script dialect — agent()/parallel()/pipeline()/phase()/log(), ALWAYS await every call):\\n\`\`\`js\\n" + targetScript + "\\n\`\`\`\\nWhere an improvement is a SCRIPT change, set kind=\\"script\\" and include the COMPLETE revised script in revisedScript (full file, same dialect). Otherwise set revisedScript to null."
  : "";

const report = await agent(
  \`You are the lead analyst. Synthesize the four lens reviews below into ONE quality report for execution "\${target}" of workflow "\${targetWorkflow}".\\n\\n\${corpus}\${scriptSection}\\n\\nRules: deduplicate findings across lenses; keep only findings with real evidence; score healthScore 0-100 (100 = fast, cheap, reliable, high-quality output); rank improvements by impact; improvements must be concrete enough to act on.\`,
  {
    label: "synthesis",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "healthScore", "findings", "improvements"],
      properties: {
        summary: { type: "string", description: "3-5 sentence executive summary of what happened and how well." },
        healthScore: { type: "integer", minimum: 0, maximum: 100 },
        findings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["lens", "severity", "title", "detail", "evidence"],
            properties: {
              lens: { type: "string", enum: ["performance", "cost", "reliability", "quality"] },
              severity: { type: "string", enum: ["info", "low", "medium", "high"] },
              title: { type: "string" },
              detail: { type: "string" },
              evidence: { type: "array", items: { type: "string" } }
            }
          }
        },
        improvements: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "rationale", "impact", "kind", "revisedScript"],
            properties: {
              title: { type: "string" },
              rationale: { type: "string" },
              impact: { type: "string", enum: ["high", "medium", "low"] },
              kind: { type: "string", enum: ["script", "config", "suggestion"] },
              revisedScript: { type: ["string", "null"], description: "Complete revised script when kind=script, else null." }
            }
          }
        }
      }
    }
  }
);

if (!report) {
  return { error: "synthesis failed", reviews: corpus };
}
log("Health " + report.healthScore + "/100 — " + report.findings.length + " findings, " + report.improvements.length + " improvements");
return report;
`;

/**
 * Upsert the per-project analysis workflow (save-script semantics) and return
 * its id. Re-seeds only when the embedded script text changed (SCRIPT_VERSION).
 */
export async function ensureTraceAnalysisWorkflow(input: {
	userId: string;
	projectId: string;
}): Promise<{ workflowId: string } | { error: string }> {
	const app = getApplicationAdapters();
	const spec = { engine: 'dynamic-script', script: ANALYSIS_SCRIPT, meta: {} };

	const existing = (await app.workflowData.getWorkflowByRef({
		workflowName: TRACE_ANALYSIS_WORKFLOW_NAME,
		lookup: 'name'
	})) as {
		id: string;
		engineType?: string | null;
		projectId?: string | null;
		spec?: { script?: unknown } | null;
	} | null;

	if (
		existing &&
		existing.engineType === 'dynamic-script' &&
		existing.projectId === input.projectId
	) {
		if (existing.spec?.script === ANALYSIS_SCRIPT) {
			return { workflowId: existing.id };
		}
		const updated = await app.workflowDefinitionCommands.updateWorkflow({
			workflowId: existing.id,
			body: { name: TRACE_ANALYSIS_WORKFLOW_NAME, engineType: 'dynamic-script', spec }
		});
		if (updated.status === 'error') {
			return {
				error: typeof updated.body === 'string' ? updated.body : JSON.stringify(updated.body)
			};
		}
		return { workflowId: existing.id };
	}

	const created = await app.workflowDefinitionCommands.createWorkflow({
		body: {
			name: TRACE_ANALYSIS_WORKFLOW_NAME,
			nodes: [],
			edges: [],
			engineType: 'dynamic-script',
			spec
		},
		userId: input.userId,
		projectId: input.projectId
	});
	if (created.status === 'error') {
		return {
			error: typeof created.body === 'string' ? created.body : JSON.stringify(created.body)
		};
	}
	return { workflowId: (created.body as { id: string }).id };
}
