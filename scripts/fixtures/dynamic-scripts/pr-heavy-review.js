export const meta = {
  "name": "pr-heavy-review",
  "description": "Agentic, GitHub-triggered heavy code review modeled on how leading AI reviewers (CodeRabbit, Greptile, Qodo, Diamond, Anthropic Claude review) actually work: a CONSTRAINED map->reduce, not a free-roaming agent. (1) REVIEW \u2014 a CLI agent clones the PR head into the shared workspace, computes the base..head diff (repo-aware, skipping generated/vendored/lockfiles) and produces multi-dimensional findings (correctness, breaking-changes/contract, security, concurrency/resource, error-handling, tests, performance, maintainability) each with file:line, severity, confidence, evidence, fix. (2) JUDGE \u2014 an INDEPENDENT critic grounds every finding in the actual code, drops ungrounded/duplicate/low-confidence ones, resolves conflicts, re-ranks by severity (the non-negotiable false-positive control). (3) PUBLISH \u2014 synthesizes a polished, COMMENT-ONLY review (advisory verdict, never auto-approve/block) and posts it back to the PR. GITHUB_TOKEN is auto-injected into the CLI sandbox for clone + posting; all stages share /sandbox/work.",
  "phases": [
    {
      "title": "Review"
    },
    {
      "title": "Judge"
    },
    {
      "title": "Publish"
    }
  ],
  "input": {
    "type": "object",
    "properties": {
      "repository": {
        "type": "string",
        "title": "Repository (owner/repo)",
        "description": "GitHub full_name, e.g. PittampalliOrg/workflow-builder. Provided by the github trigger.",
        "default": "PittampalliOrg/workflow-builder"
      },
      "prNumber": {
        "type": "integer",
        "minimum": 1,
        "title": "PR number"
      },
      "prTitle": {
        "type": "string",
        "title": "PR title",
        "default": ""
      },
      "prUrl": {
        "type": "string",
        "title": "PR URL",
        "format": "uri",
        "default": ""
      },
      "prHeadRef": {
        "type": "string",
        "title": "Head branch",
        "default": ""
      },
      "prBaseRef": {
        "type": "string",
        "title": "Base branch",
        "default": "main"
      },
      "action": {
        "type": "string",
        "title": "PR action",
        "default": "opened"
      },
      "reviewAgent": {
        "type": "string",
        "title": "Review/judge agent slug",
        "description": "claude-code-cli agent slug used for all three stages (shares /sandbox/work, has GITHUB_TOKEN).",
        "default": "cli-evaluator-critic-agent"
      }
    },
    "required": [
      "repository",
      "prNumber"
    ]
  }
}

// Ported from the SW 1.0 fixture (cutover P3, item 15). Three CLI agents share
// ONE workspace (the run's shared /sandbox/work): review -> independent judge
// (the false-positive gate) -> publish. jq prompt concatenation becomes JS
// string concatenation; the shared workspaceRef becomes the `workspace` sentinel.
const t = args ?? {}

phase('Review')
const review = await agent(
  "You are reviewing pull request #" + t.prNumber + " (\"" + (t.prTitle ?? "") + "\") on repository " + t.repository + ".\n\nSTEP 1 — materialize the PR. Run EXACTLY this shell (GITHUB_TOKEN is already in the environment). It fetches the diff via the GitHub API (instant) and does a SHALLOW clone of the PR head for repo-aware reading:\n  mkdir -p /sandbox/work/pr && cd /sandbox/work && curl -sSL -H \"Authorization: Bearer $GITHUB_TOKEN\" -H 'Accept: application/vnd.github.v3.diff' https://api.github.com/repos/" + t.repository + "/pulls/" + t.prNumber + " > /sandbox/work/pr/diff.patch && curl -sSL -H \"Authorization: Bearer $GITHUB_TOKEN\" -H 'Accept: application/vnd.github+json' 'https://api.github.com/repos/" + t.repository + "/pulls/" + t.prNumber + "/files?per_page=100' | python3 -c 'import sys,json; [print(f[\"status\"],f[\"filename\"]) for f in json.load(sys.stdin)]' > /sandbox/work/pr/files.txt && rm -rf repo && git clone --depth 1 --single-branch --filter=blob:none --branch " + (t.prHeadRef ?? (t.prBaseRef ?? "main")) + " https://x-access-token:$GITHUB_TOKEN@github.com/" + t.repository + ".git repo\n\nSTEP 2 — follow your reviewer instructions: read the diff + changed files (repo-aware), and WRITE /sandbox/work/pr/findings.json (the structured findings) and /sandbox/work/pr/SUMMARY.md. Be thorough across all dimensions.",
  {
    label: 'review',
    agent: (t.reviewAgent ?? "cli-evaluator-critic-agent"),
    isolation: 'shared',
    sandbox: {
      workspaceRef: workspace,
      cwd: '/sandbox/work',
      maxTurns: 60,
      timeoutMinutes: 45,
    },
  },
)

phase('Judge')
const judge = await agent(
  "Independently verify the candidate review findings for PR #" + t.prNumber + " on " + t.repository + ". Read /sandbox/work/pr/findings.json and ground each one against the real code in /sandbox/work/repo (open files, grep, trace). Drop anything ungrounded, duplicate, low-confidence (<60), or non-actionable. WRITE /sandbox/work/pr/verified.json exactly as your instructions specify. Follow your instructions.",
  {
    label: 'judge',
    agent: (t.reviewAgent ?? "cli-evaluator-critic-agent"),
    isolation: 'shared',
    sandbox: {
      workspaceRef: workspace,
      cwd: '/sandbox/work',
      maxTurns: 45,
      timeoutMinutes: 40,
    },
  },
)

phase('Publish')
const publish = await agent(
  "Synthesize and post the review for PR #" + t.prNumber + " on " + t.repository + ".\n\nWrite /sandbox/work/pr/REVIEW.md per your instructions, then POST it as a PR comment by running:\n  python3 -c 'import json;print(json.dumps({\"body\":open(\"/sandbox/work/pr/REVIEW.md\").read()}))' > /sandbox/work/pr/comment.json\n  curl -sS -X POST -H \"Authorization: Bearer $GITHUB_TOKEN\" -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' https://api.github.com/repos/" + t.repository + "/issues/" + t.prNumber + "/comments -d @/sandbox/work/pr/comment.json | python3 -c 'import sys,json;d=json.load(sys.stdin);print(\"COMMENT_URL=\"+str(d.get(\"html_url\") or d.get(\"message\") or d))'\n\nThen output the full REVIEW.md as your final message with the COMMENT_URL line last.",
  {
    label: 'publish',
    agent: (t.reviewAgent ?? "cli-evaluator-critic-agent"),
    isolation: 'shared',
    sandbox: {
      workspaceRef: workspace,
      cwd: '/sandbox/work',
      maxTurns: 25,
      timeoutMinutes: 25,
    },
  },
)

return {
  "repository": t.repository,
  "pr_number": t.prNumber,
  "pr_title": (t.prTitle ?? null),
  "action": (t.action ?? null),
  // agent() returns the final text directly (the SW spec read
  // `.publish.data.content` off the node-output envelope).
  "review": publish ?? null,
}
