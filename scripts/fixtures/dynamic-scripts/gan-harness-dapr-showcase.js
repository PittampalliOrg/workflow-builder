export const meta = {
  "name": "gan-harness-dapr-showcase",
  "description": "Anthropic GAN-style general coding harness running on dapr-agent-py over the openshell-shared workspace backend (sibling of gan-harness-cli-showcase). A workspace/profile provisions ONE shared /sandbox openshell sandbox (keepAfterRun); a deterministic clone_repo node clones repoUrl into /sandbox/repo. The Planner writes a HIGH-LEVEL SPEC.md; the Generator and a skeptical Evaluator NEGOTIATE a rigid acceptance contract (each criterion kind=objective|subjective) before any code. The build loop generates, passes a deterministic gate (build + tests), and the Evaluator grades the RUNNING artifact b",
  "phases": [
    {
      "title": "Setup"
    },
    {
      "title": "Plan"
    },
    {
      "title": "Approve"
    },
    {
      "title": "Design"
    },
    {
      "title": "Negotiate"
    },
    {
      "title": "Refine"
    },
    {
      "title": "Publish"
    }
  ],
  "input": {
    "type": "object",
    "required": [
      "intent"
    ],
    "properties": {
      "intent": {
        "type": "string",
        "title": "Redesign request",
        "default": "Improve input validation and test coverage for the is-number library: correctly classify edge cases (empty string, whitespace-only, hex like \"0x1F\", scientific notation like \"1e3\", Infinity, and numeric strings) and keep `npm test` passing. Do NOT change the public API or add dependencies.",
        "description": "What the agents change in the repo."
      },
      "planAgent": {
        "type": "string",
        "title": "Planner agent",
        "default": "evaluator-critic-agent",
        "description": "PLAN phase agent (reads /sandbox/repo + writes SPEC). openshell-shared family."
      },
      "generatorAgent": {
        "type": "string",
        "title": "Generator agent",
        "default": "evaluator-critic-agent",
        "description": "GENERATE phase agent."
      },
      "criticAgent": {
        "type": "string",
        "title": "Critic agent",
        "default": "evaluator-critic-agent",
        "description": "EVALUATOR agent \u2014 negotiates the contract AND grades the build by running the test suite / exercising the API (no browser). dapr-agent-py family."
      },
      "installCommand": {
        "type": "string",
        "title": "Install command",
        "default": "auto",
        "description": "Dependency-install command ('auto' = detect pnpm/npm/cargo/pip)."
      },
      "buildCommand": {
        "type": "string",
        "title": "Build command",
        "default": "auto",
        "description": "Build command the deterministic gate runs ('auto' = detect pnpm/npm/cargo/make)."
      },
      "previewCommand": {
        "type": "string",
        "title": "Preview command",
        "default": "auto",
        "description": "Preview/serve command the critic views ('auto' = detect npm/pnpm)."
      },
      "designPass": {
        "type": "string",
        "title": "Two-pass design",
        "default": "true",
        "description": "Run the design-tokens+wireframe review BEFORE code ('false' to skip)."
      },
      "criticVotes": {
        "type": "string",
        "title": "Critic votes",
        "default": "2",
        "description": "Independent Evaluator votes per build iteration; a criterion passes only if ALL votes agree (1 = single critic)."
      },
      "maxRestarts": {
        "type": "string",
        "title": "Max restarts",
        "default": "2",
        "description": "How many times the Evaluator may force a from-scratch restart (git reset --hard baseline) on fundamentally-broken work."
      },
      "repoUrl": {
        "type": "string",
        "title": "Repository (owner/repo)",
        "default": "jonschlinkert/is-number",
        "description": "GitHub owner/repo the agents clone + (optionally) open a PR into."
      },
      "repoRef": {
        "type": "string",
        "title": "Branch",
        "default": "main",
        "description": "Branch to clone from and use as the PR base."
      },
      "evaluationProfile": {
        "type": "string",
        "title": "Evaluation profile",
        "default": "library",
        "description": "How the Evaluator grounds + grades: 'ui-web' (Playwright + design rubric), 'library' (run tests + exercise the public API), 'service' (boot + hit endpoints + integration tests)."
      },
      "outputMode": {
        "type": "string",
        "title": "Output mode",
        "default": "pr",
        "description": "Remote-write policy: 'pr' (push branch + open PR), 'branch' (push branch only), 'none' (no remote change)."
      },
      "testCommand": {
        "type": "string",
        "title": "Test command",
        "default": "auto",
        "description": "Objective verify the gate runs for code profiles ('auto' = detect npm/pnpm test, cargo test, pytest)."
      },
      "taskScope": {
        "type": "string",
        "title": "Task scope",
        "default": "Edit src/routes/+page.svelte plus a global stylesheet; plain SvelteKit + CSS only; do NOT change package.json deps or routing.",
        "description": "Free-form hint of what/where to change (replaces UI-file hardcoding)."
      }
    }
  }
}

// Ported from the SW 1.0 fixture (cutover P3, item 17). Every SW primitive it
// used now exists in the script dialect: workspace/profile + agent sandbox
// binding, the `listen` approval gate becomes approve(), and the three jq
// `for`+`while` loops (design / negotiate / refine) become plain JS loops whose
// exit conditions read SCHEMA'D critic verdicts instead of parsing free-form
// JSON out of stdout. Prompts and shell bodies are verbatim.
const t = args ?? {}
const repoUrl = t.repoUrl ?? 'jonschlinkert/is-number'

// Action result envelopes (dialect contract):
//   success            -> the payload directly:            { result: {...}, backend, ... }
//   allowFailure + fail -> wrapped:  { success:false, error, data: { result: {...}, exitCode, ... } }
// So unwrap `.data` FIRST, then `.result`. Reading only `.result` silently
// loses every failing command's exitCode/stdout (caught on dev 2026-07-14).
function shell(res) {
  const base = res?.data ?? res ?? {}
  const r = base.result ?? base
  return {
    exitCode: r.exitCode ?? base.exitCode ?? 1,
    stdout: r.stdout ?? base.stdout ?? '',
    stderr: r.stderr ?? base.stderr ?? '',
    content: r.content ?? base.content ?? '',
  }
}

phase('Setup')
const profile = await action('workspace/profile', {
  "name": "gan-harness-dapr",
  "rootPath": "/sandbox",
  "managedBy": "workflow-builder:demos:gan-harness-dapr",
  "timeoutMs": 600000,
  "ttlSeconds": 3600,
  "enabledTools": [
    "execute_command",
    "read_file",
    "write_file",
    "edit_file",
    "list_files",
    "mkdir",
    "file_stat"
  ],
  "keepAfterRun": true,
  "sandboxPolicy": {
    "mode": "per-run",
    "template": "dapr-agent",
    "ttlSeconds": 3600,
    "keepAfterRun": true
  },
  "sandboxTemplate": "dapr-agent",
  "commandTimeoutMs": 300000
}, { label: 'workspace_profile' })
const profileBase = profile?.data ?? profile ?? {}
const profileData = profileBase.result ?? profileBase
const workspaceRef = profileData.workspaceRef
const sandboxName =
  profileData.sandboxName ?? profileData.sandbox?.details?.sandboxName ?? profileData.sandbox?.sandboxName
const SANDBOX = { workspaceRef, sandboxName, cwd: '/sandbox' }

await action('workspace/command', {
  workspaceRef,
  command: "\nif [ -n \"$REF\" ] && git rev-parse --verify \"origin/$REF\" >/dev/null 2>&1; then git checkout \"$REF\"; fi\ngit config user.email agent@workflow-builder.local\ngit config user.name \"workflow-builder agent\"\nBASE=$(git rev-parse --abbrev-ref HEAD)\nprintf %s \"$BASE\" > /sandbox/.wfb_base\necho CLONED $(git rev-parse HEAD) on $BASE",
  cwd: "/sandbox",
  timeoutMs: 600000,
}, { label: 'clone_repo' })

phase('Plan')
const plan = await agent("\nThe repo is ALREADY cloned at /sandbox/repo. READ it (entry points, package manifest, existing tests) and write a HIGH-LEVEL spec to /sandbox/SPEC.md (product/task context + the quality dimensions relevant to this task). Do NOT enumerate granular acceptance criteria (those are negotiated next). Do NOT edit the repo. End with a one-line summary.", {
  label: 'plan',
  agent: "evaluator-critic-agent",
  isolation: 'shared',
  sandbox: { ...SANDBOX, maxTurns: 25, timeoutMinutes: 60 },
})

await action('workspace/command', {
  workspaceRef,
  command: "WFB_INSTALL=\"$WFB_INSTALL_OVERRIDE\"; WFB_BUILD=\"$WFB_BUILD_OVERRIDE\"; WFB_PREVIEW=\"$WFB_PREVIEW_OVERRIDE\"\ncd /sandbox/repo 2>/dev/null || true\nif [ -z \"$WFB_INSTALL\" ] || [ \"$WFB_INSTALL\" = auto ]; then\n  if [ -f pnpm-lock.yaml ]; then WFB_INSTALL='pnpm install --frozen-lockfile';\n  elif [ -f package.json ]; then WFB_INSTALL='npm install --no-audit --no-fund';\n  elif [ -f Cargo.toml ]; then WFB_INSTALL='cargo fetch';\n  elif [ -f requirements.txt ]; then WFB_INSTALL='pip install -r requirements.txt';\n  else WFB_INSTALL='true'; fi\nfi\nif [ -z \"$WFB_BUILD\" ] || [ \"$WFB_BUILD\" = auto ]; then\n  if [ -f pnpm-lock.yaml ]; then WFB_BUILD='pnpm build';\n  elif [ -f package.json ]; then WFB_BUILD='npm run build';\n  elif [ -f Cargo.toml ]; then WFB_BUILD='cargo build --release';\n  elif [ -f Makefile ] && grep -q '^build:' Makefile; then WFB_BUILD='make build';\n  else WFB_BUILD='echo no-build-step'; fi\nfi\nif [ -z \"$WFB_PREVIEW\" ] || [ \"$WFB_PREVIEW\" = auto ]; then\n  if [ -f package.json ]; then WFB_PREVIEW='npm run preview -- --host 127.0.0.1';\n  else WFB_PREVIEW='true'; fi\nfi\nsh -c \"$WFB_INSTALL\" >/tmp/install.log 2>&1 || true\nprintf '%s' \"$WFB_EVAL_PROFILE\" > /sandbox/.wfb_profile\nprintf '%s' \"$WFB_REPO\" > /sandbox/.wfb_repo\nprintf '%s' \"$WFB_OUT\" > /sandbox/.wfb_out\nprintf '%s' \"$WFB_INTENT\" > /sandbox/.wfb_intent\nprintf '%s' \"$WFB_MAXRESTARTS\" > /sandbox/.wfb_maxrestarts\nBASE=$(git rev-parse HEAD 2>/dev/null || echo unknown); printf '{\"baseline\":\"%s\",\"log\":[]}' \"$BASE\" > /sandbox/progress.json; cat /sandbox/progress.json",
  cwd: "/sandbox",
  timeoutMs: 900000,
}, { label: 'init_state', allowFailure: true })

phase('Approve')
// The SW `listen` gate (type goal_spec_approval, timeout PT2H) — a first-class
// approve() in the dialect: a wait_event child per callId; a timeout RESOLVES
// {timedOut:true} rather than failing the run.
const approval = await approve({
  message: 'Approve the goal spec before the design loop starts',
  timeoutMinutes: 120,
})
if (approval?.approved !== true) {
  return { approved: false, timedOut: approval?.timedOut === true, plan }
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['meets_criteria'],
  properties: {
    meets_criteria: { type: 'boolean' },
    score: { type: 'number' },
    failing: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

phase('Design')
let designVerdict = null
let designIterations = 0
while (designIterations < 3) {
  const feedback = designVerdict
    ? `\n\nPREVIOUS REVIEW (address every failing item):\n${JSON.stringify(designVerdict)}`
    : ''
  await agent("Two-pass design (proposal). Intent: " + feedback, {
    label: `design_propose #${designIterations + 1}`,
    phase: 'Design',
    agent: "evaluator-critic-agent",
    isolation: 'shared',
    sandbox: { ...SANDBOX, maxTurns: 15, timeoutMinutes: 45 },
  })

  designVerdict = await agent("Review the DESIGN PLAN (no code yet). Read /sandbox/SPEC.md, design-tokens.json, wireframe.txt. Write /sandbox/design-review.json {approved, feedback}. Reject generic/AI-slop direction; approve only a distinctive, coherent one.", {
    label: `design_review #${designIterations + 1}`,
    phase: 'Design',
    agent: "evaluator-critic-agent",
    isolation: 'shared',
    schema: VERDICT_SCHEMA,
    sandbox: { ...SANDBOX, maxTurns: 12, timeoutMinutes: 30 },
  })

  designIterations += 1
  if (designVerdict?.meets_criteria === true) break
}

phase('Negotiate')
let negotiateVerdict = null
let negotiateIterations = 0
while (negotiateIterations < 4) {
  const feedback = negotiateVerdict
    ? `\n\nPREVIOUS REVIEW (address every failing item):\n${JSON.stringify(negotiateVerdict)}`
    : ''
  await agent("COMMAND/TEST-verifiable \u2014 name the EXACT shell/test command or function-call assertion that proves it (e.g. `npm test` passes, `python -m pytest -q` passes, import the module and assert f(x)==expected, or curl an endpoint and assert the status). NO browser checks." + feedback, {
    label: `propose #${negotiateIterations + 1}`,
    phase: 'Negotiate',
    agent: "evaluator-critic-agent",
    isolation: 'shared',
    sandbox: { ...SANDBOX, maxTurns: 20, timeoutMinutes: 60 },
  })

  negotiateVerdict = await agent("' profile. Read /sandbox/SPEC.md and /sandbox/proposal.md, write your objections to /sandbox/contract-review.md, and write/update /sandbox/contract.json (agreed + criteria, each kind/dimension/verify, passes:false) as STRICT JSON per your instructions. Each criterion must be ", {
    label: `review #${negotiateIterations + 1}`,
    phase: 'Negotiate',
    agent: "evaluator-critic-agent",
    isolation: 'shared',
    schema: VERDICT_SCHEMA,
    sandbox: { ...SANDBOX, maxTurns: 25, timeoutMinutes: 60 },
  })

  negotiateIterations += 1
  if (negotiateVerdict?.meets_criteria === true) break
}

phase('Refine')
let refineVerdict = null
let refineIterations = 0
const REFINE_CAP = Number(t.maxIterations ?? 20) || 20
while (refineIterations < REFINE_CAP) {
  const feedback = refineVerdict
    ? `\n\nPREVIOUS VERDICT (address every failing item):\n${JSON.stringify(refineVerdict)}`
    : ''
  await agent("\n\nRepo: /sandbox/repo. Authoritative acceptance criteria: /sandbox/contract.json. Spec: /sandbox/SPEC.md. Memory: /sandbox/progress.json (read it + git log FIRST)." + feedback, {
    label: `generate #${refineIterations + 1}`,
    phase: 'Refine',
    agent: "evaluator-critic-agent",
    isolation: 'shared',
    sandbox: { ...SANDBOX, maxTurns: 50, timeoutMinutes: 120 },
  })

  // Deterministic contract-graded gate (verbatim shell from the fixture).
  const gateRes = await action('workspace/command', {
    workspaceRef,
    command: "WFB_INSTALL=\"$WFB_INSTALL_OVERRIDE\"; WFB_BUILD=\"$WFB_BUILD_OVERRIDE\"; WFB_PREVIEW=\"$WFB_PREVIEW_OVERRIDE\"; WFB_TEST=\"$WFB_TEST_OVERRIDE\"\ncd /sandbox/repo 2>/dev/null || true\nif [ -z \"$WFB_INSTALL\" ] || [ \"$WFB_INSTALL\" = auto ]; then\n  if [ -f pnpm-lock.yaml ]; then WFB_INSTALL='pnpm install --frozen-lockfile';\n  elif [ -f package.json ]; then WFB_INSTALL='npm install --no-audit --no-fund';\n  elif [ -f Cargo.toml ]; then WFB_INSTALL='cargo fetch';\n  elif [ -f requirements.txt ]; then WFB_INSTALL='pip install -r requirements.txt';\n  else WFB_INSTALL='true'; fi\nfi\nif [ -z \"$WFB_BUILD\" ] || [ \"$WFB_BUILD\" = auto ]; then\n  if [ -f pnpm-lock.yaml ]; then WFB_BUILD='pnpm build';\n  elif [ -f package.json ]; then WFB_BUILD='npm run build';\n  elif [ -f Cargo.toml ]; then WFB_BUILD='cargo build --release';\n  elif [ -f Makefile ] && grep -q '^build:' Makefile; then WFB_BUILD='make build';\n  else WFB_BUILD='echo no-build-step'; fi\nfi\nif [ -z \"$WFB_PREVIEW\" ] || [ \"$WFB_PREVIEW\" = auto ]; then\n  if [ -f package.json ]; then WFB_PREVIEW='npm run preview -- --host 127.0.0.1';\n  else WFB_PREVIEW='true'; fi\nfi\nif [ -z \"$WFB_TEST\" ] || [ \"$WFB_TEST\" = auto ]; then\n  if [ -f pnpm-lock.yaml ]; then WFB_TEST='pnpm test';\n  elif [ -f package.json ]; then WFB_TEST='npm test';\n  elif [ -f Cargo.toml ]; then WFB_TEST='cargo test';\n  elif [ -f pyproject.toml ] || [ -f pytest.ini ] || [ -f setup.cfg ] || [ -f requirements.txt ]; then WFB_TEST='python -m pytest -q';\n  else WFB_TEST='true'; fi\nfi\n[ -d node_modules ] || sh -c \"$WFB_INSTALL\" >/tmp/install.log 2>&1 || true\nsh -c \"$WFB_BUILD\" >/tmp/build.log 2>&1; BRC=$?\nTRC=0\ncase \"$WFB_EVAL_PROFILE\" in\n  library|service) sh -c \"$WFB_TEST\" >/tmp/test.log 2>&1; TRC=$? ;;\nesac\nif [ \"$BRC\" -eq 0 ] && [ \"$TRC\" -eq 0 ]; then echo 'OBJECTIVE PASS: build+test OK'; else echo \"OBJECTIVE FAIL: build rc=$BRC test rc=$TRC\"; tail -30 /tmp/build.log; tail -30 /tmp/test.log 2>/dev/null; fi\necho \"__EXIT__$BRC\"",
    cwd: "/sandbox/repo",
    timeoutMs: 600000,
  }, { label: `gate #${refineIterations + 1}`, phase: 'Refine', allowFailure: true })
  const gateOut = shell(gateRes)

  if (gateOut.exitCode !== 0) {
    refineVerdict = {
      meets_criteria: false,
      failing: ['gate failed: ' + (gateOut.stderr || gateOut.stdout).slice(0, 800)],
    }
    refineIterations += 1
    continue
  }

  // Two independent critics (UI + code) — the SW spec ran these as separate
  // nodes and parsed their JSON out of stdout; here both are schema'd.
  const [uiVerdict, codeVerdict] = await Promise.all([
    agent("Grade the redesigned app in /sandbox/repo against EACH criterion in /sandbox/contract.json by VIEWING + interacting with it in the browser (Playwright MCP), then WRITE /sandbox/verdict-0.json (per-criterion passes + allPass + meets_criteria + recommend_restart). Follow your instructions exactly.", {
      label: `evaluate_ui #${refineIterations + 1}`,
      phase: 'Refine',
      agent: "evaluator-critic-agent",
      isolation: 'shared',
      schema: VERDICT_SCHEMA,
      sandbox: { ...SANDBOX, maxTurns: 35 },
    }),
    agent("' profile, then WRITE /sandbox/verdict-0.json (per-criterion passes + allPass + meets_criteria + recommend_restart). Follow your instructions exactly. Test command hint: ", {
      label: `evaluate_code #${refineIterations + 1}`,
      phase: 'Refine',
      agent: "evaluator-critic-agent",
      isolation: 'shared',
      schema: VERDICT_SCHEMA,
      sandbox: { ...SANDBOX, maxTurns: 35 },
    }),
  ])

  refineVerdict = {
    meets_criteria:
      uiVerdict?.meets_criteria === true && codeVerdict?.meets_criteria === true,
    ui: uiVerdict,
    code: codeVerdict,
    failing: [...(uiVerdict?.failing ?? []), ...(codeVerdict?.failing ?? [])],
  }
  refineIterations += 1
  if (refineVerdict.meets_criteria) break
}

phase('Publish')
const publish_shot = await action('workspace/command', {
  workspaceRef,
  command: "WFB_INSTALL=\"$WFB_INSTALL_OVERRIDE\"; WFB_BUILD=\"$WFB_BUILD_OVERRIDE\"; WFB_PREVIEW=\"$WFB_PREVIEW_OVERRIDE\"\ncd /sandbox/repo 2>/dev/null || true\nif [ -z \"$WFB_INSTALL\" ] || [ \"$WFB_INSTALL\" = auto ]; then\n  if [ -f pnpm-lock.yaml ]; then WFB_INSTALL='pnpm install --frozen-lockfile';\n  elif [ -f package.json ]; then WFB_INSTALL='npm install --no-audit --no-fund';\n  elif [ -f Cargo.toml ]; then WFB_INSTALL='cargo fetch';\n  elif [ -f requirements.txt ]; then WFB_INSTALL='pip install -r requirements.txt';\n  else WFB_INSTALL='true'; fi\nfi\nif [ -z \"$WFB_BUILD\" ] || [ \"$WFB_BUILD\" = auto ]; then\n  if [ -f pnpm-lock.yaml ]; then WFB_BUILD='pnpm build';\n  elif [ -f package.json ]; then WFB_BUILD='npm run build';\n  elif [ -f Cargo.toml ]; then WFB_BUILD='cargo build --release';\n  elif [ -f Makefile ] && grep -q '^build:' Makefile; then WFB_BUILD='make build';\n  else WFB_BUILD='echo no-build-step'; fi\nfi\nif [ -z \"$WFB_PREVIEW\" ] || [ \"$WFB_PREVIEW\" = auto ]; then\n  if [ -f package.json ]; then WFB_PREVIEW='npm run preview -- --host 127.0.0.1';\n  else WFB_PREVIEW='true'; fi\nfi\ncd /sandbox/repo\n(nohup sh -c \"$WFB_PREVIEW --port 4321\" >/tmp/preview.log 2>&1 &) || true\nfor i in $(seq 1 40); do curl -sf http://127.0.0.1:4321/ >/dev/null 2>&1 && break; sleep 1; done\nPLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers playwright screenshot --browser chromium --full-page --viewport-size 1280,900 http://127.0.0.1:4321/ /sandbox/critic-shot.png || echo SHOT_FAILED\npkill -f vite 2>/dev/null; pkill -f \"npm run\" 2>/dev/null; pkill -f preview 2>/dev/null\nls -la /sandbox/critic-shot.png 2>/dev/null || echo NO-SHOT",
  cwd: "/sandbox",
  timeoutMs: 60000,
  readFile: "/sandbox/critic-shot.png",
}, { label: 'publish_shot', allowFailure: true })

const publish_contract = await action('workspace/command', {
  workspaceRef,
  command: "ls -la /sandbox/contract.json 2>/dev/null || echo no-contract",
  cwd: "/sandbox",
  timeoutMs: 60000,
  readFile: "/sandbox/contract.json",
}, { label: 'publish_contract', allowFailure: true })

const pr = await action('workspace/command', {
  workspaceRef,
  command: "REPO=$(git -C /sandbox/repo remote get-url origin 2>/dev/null | sed -e 's#.*github.com[:/]##' -e 's#\\.git$##'); [ -n \"$REPO\" ] || REPO=$(cat /sandbox/.wfb_repo 2>/dev/null || echo PittampalliOrg/sveltekit-landing-demo)\nBASE=$(cat /sandbox/.wfb_base 2>/dev/null || echo main)\nOUT=$(cat /sandbox/.wfb_out 2>/dev/null || echo branch)\nTITLE=$(head -c 72 /sandbox/.wfb_intent 2>/dev/null || echo 'automated change'); [ -n \"$TITLE\" ] || TITLE='automated change'\ncd /sandbox/repo && git config user.email agent@workflow-builder.local && git config user.name 'workflow-builder agent'\nBR=wfb-$(date +%s) && git checkout -b \"$BR\" && git add -A && (git commit -m \"$TITLE (workflow-builder GAN harness)\" || echo nothing-to-commit)\ngit push https://x-access-token:$GITHUB_TOKEN@github.com/$REPO.git HEAD:\"$BR\"\nif [ \"$OUT\" = pr ]; then\n  PR=$(curl -sS -X POST -H \"Authorization: Bearer $GITHUB_TOKEN\" -H 'Accept: application/vnd.github+json' https://api.github.com/repos/$REPO/pulls -d \"{\\\"title\\\":\\\"$TITLE (automated)\\\",\\\"head\\\":\\\"$BR\\\",\\\"base\\\":\\\"$BASE\\\",\\\"body\\\":\\\"Automated change via the workflow-builder GAN coding harness (plan/negotiate/generate/evaluate).\\\"}\")\n  echo \"$PR\" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(\"PR_URL=\"+str(d.get(\"html_url\") or d.get(\"message\") or d))'\nelse echo \"BRANCH_PUSHED=$BR\"; fi",
  cwd: "/sandbox/repo",
  timeoutMs: 120000,
}, { label: 'pr', allowFailure: true })

return {
  accepted: refineVerdict?.meets_criteria === true,
  approved: true,
  repoUrl,
  designIterations,
  negotiateIterations,
  refineIterations,
  verdict: refineVerdict,
  publishShot: shell(publish_shot).content || shell(publish_shot).stdout,
  contract: shell(publish_contract).content || shell(publish_contract).stdout,
  pr: shell(pr).stdout,
}
