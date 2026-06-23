# Heavy PR Code-Review Workflow

A GitHub-triggered, agentic **heavy code review**: when a pull request is opened/updated on a repo, a multi-stage agent pipeline clones the PR, reviews it across many dimensions, independently verifies the findings, and posts a single structured review back to the PR. Fixture: `scripts/fixtures/pr-heavy-review.workflow.json` (SW 1.0). Trigger: the `github` workflow-trigger (see `docs/event-driven-workflow-triggers.md` + the `github-webhook` backing).

## Best-practice model (what we modeled it on)

Researched across the leading AI code reviewers — **CodeRabbit, Greptile, Qodo/PR-Agent, Graphite Diamond, Anthropic's Claude Code review, GitHub Copilot**. The convergent backbone (every serious tool shares it):

> A **constrained map→reduce**, NOT a free-roaming agent: context-engineering up front → parallel multi-dimensional analysis → an **independent JUDGE** that grounds every finding in evidence, dedups, confidence-thresholds and severity-ranks **before anything posts** → **comment-only** output (never auto-approve/block).

Key principles we adopted:

1. **The independent judge is non-negotiable.** It is the single biggest driver of signal quality and the #1 control against false positives (the top complaint about review bots). A *separate* agent verifies each candidate finding against the real code and drops anything it can't ground ("empty grep results are not proof of a bug"). This is the evaluator-optimizer / generator→critic pattern with completion authority held by the critic — the same shape as our `generator-critic-multi-agent.md` and `goal-loop-evaluator-design.md`.
2. **Repo-aware, not diff-only.** Read the full changed files + the surrounding code the change touches, not just the hunk — cross-file/contract bugs are what humans and linters miss.
3. **Decomposed dimensions.** Split analysis into distinct lenses; prioritize the high-signal ones (correctness/logic, breaking-changes/contract, security, concurrency/resource) over the low-signal ones (style/docs — let linters own those).
4. **False-positive controls:** evidence-grounding · confidence scoring + threshold (drop < 60) · severity classification (blocker/major/minor/nit) · dedup · "only comment if actionable" (bias to silence) · bounded exploration.
5. **Comment-only verdict.** Emit an advisory verdict (approve-suggested / changes-suggested / comment) but never gate the merge — matches Copilot ("always Comment") and Anthropic ("does not approve PRs automatically").
6. **Skip noise:** generated/vendored/minified/lockfiles excluded before review; drafts skipped.

References: CodeRabbit (theaiengineer.substack.com/p/how-coderabbit-actually-works; cloud.google.com/blog/products/ai-machine-learning/how-coderabbit-built-its-ai-code-review-agent-with-google-cloud-run) · Greptile (greptile.com/what-is-ai-code-review) · Qodo (qodo.ai/blog/introducing-qodo-2-0-agentic-code-review) · Graphite Diamond (graphite.com/blog/series-b-diamond-launch) · Anthropic Claude review (infoq.com/news/2026/04/claude-code-review) · Copilot (docs.github.com/copilot/using-github-copilot/code-review).

## Our pipeline (3 CLI-agent stages, shared workspace)

The SW 1.0 interpreter is the orchestrator. All three stages are `durable/run` nodes on `claude-code-cli` (`cli-evaluator-critic-agent`), sharing one execution-scoped workspace (`workspaceRef: ${ .runtime.executionId }` → `/sandbox/work`). `GITHUB_TOKEN` is auto-injected into the CLI sandbox (from 1Password `GITHUB-PAT`) for both the private-repo clone and posting the review — no separate connection needed.

| Stage | Role | Maps to |
|-------|------|---------|
| **review** | Materializes the PR (`git clone --filter=blob:none` + `git fetch pull/<n>/head` + base..head diff), skips generated/lockfiles, reads changed files repo-aware, and emits multi-dimensional findings → `/sandbox/work/pr/findings.json` (each: file·line·dimension·severity·confidence·rationale·evidence·suggestion) | context-engineering + map (parallel-dimensions, here decomposed inside one structured pass) |
| **judge** | **Independent** critic: grounds each finding in the real code, drops ungrounded/duplicate/low-confidence/non-actionable, resolves conflicts, re-ranks severity → `/sandbox/work/pr/verified.json` (+ advisory verdict) | reduce: the judge / evaluator-optimizer (the false-positive gate) |
| **publish** | Synthesizes a polished **comment-only** review (summary · findings by severity with `file:line` + confidence + fix · advisory verdict, explicitly non-blocking) and POSTs it to the PR via the GitHub API; persists it as the run's primary `markdown` artifact | synthesize + post |

Dimensions reviewed: correctness/logic · breaking-change/contract · security · concurrency/resource · error-handling · tests/coverage · performance · maintainability.

Every stage is guarded by `if: action ∈ {opened, synchronize, reopened} AND not draft` so closing/labeling a PR (or a draft) is a no-op.

## Trigger wiring

Create a `github` trigger on the workflow (events `pull_request`) and **Activate** it — the `github-webhook` backing auto-registers the repo webhook against the public Tailscale **Funnel** receiver; GitHub deliveries are HMAC-validated and converge on the `workflow.triggers` spine (idempotent on `X-GitHub-Delivery`, concurrency-gated). Deactivate removes the hook. The PR metadata (`prNumber`, `repository`, `prBaseRef`, `action`, full `event`) arrives as `${ .trigger.* }`.

## Extending toward the full reference pipeline

Deliberately scoped to 3 stages for reliability/cost. Natural next steps, in priority order: true **parallel per-dimension fan-out** (SW `fork`) for large PRs; **inline file:line review comments** (GitHub reviews API) in addition to the summary comment; **deterministic evidence** (run linters/SAST/tests in-sandbox and feed their output to the judge as ground truth); a **feedback loop** (👍/👎 + accept/dismiss) to tune the confidence threshold.
