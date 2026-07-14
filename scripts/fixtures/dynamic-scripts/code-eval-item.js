export const meta = {
  name: 'code-eval-item',
  description: 'Coding eval item (HumanEval+/MBPP+/BigCodeBench): profile a sandbox, probe the runtime, plant the test, solve with the agent, run pytest, capture artifacts.',
  phases: [{ title: 'Setup' }, { title: 'Solve' }, { title: 'Grade' }],
}

// Ported from the SW 1.0 fixture (cutover P3, item 15). Same workflow id, so
// CODE_EVAL_WORKFLOW_ID + the humaneval/mbpp/bigcodebench template routes need
// zero changes. The jq guards (`if: (.validate_runtime.exitCode // 1) == 0`)
// become plain JS control flow; the jq output projection becomes the returned
// object.
const RUN_TESTS_COMMAND = "set -u; cd /sandbox; if [ -f solution.py ]; then missing=0; else echo 'MISSING_SOLUTION' >&2; : > solution.py; missing=1; fi; run_dir=/tmp/code_eval_run; [ \"${run_dir}\" = \"/tmp/code_eval_run\" ] || exit 3; rm -rf \"${run_dir}\"; mkdir -p \"${run_dir}\"; cp /sandbox/solution.py \"${run_dir}/solution.py\"; cp /sandbox/test_solution.py \"${run_dir}/test_solution.py\"; cd \"${run_dir}\"; if [ \"${missing}\" = \"1\" ]; then pytest_exit=2; else PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 CODE_EVAL_SOLUTION_PATH=\"${run_dir}/solution.py\" /sandbox/.venv/bin/python -m pytest -q --tb=short --noconftest test_solution.py 2>&1; pytest_exit=$?; fi; echo \"__PYTEST_EXIT_CODE__=${pytest_exit}\"; exit ${pytest_exit}"
const CAPTURE_METADATA_COMMAND = "set -eu; /sandbox/.venv/bin/python - <<'PY'\nimport hashlib, json, pathlib\n\ndef digest(path):\n    p = pathlib.Path(path)\n    if not p.is_file():\n        return {'exists': False, 'sha256': '', 'bytes': 0}\n    data = p.read_bytes()\n    return {'exists': True, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}\n\nsolution = digest('/sandbox/solution.py')\ntest_file = digest('/sandbox/test_solution.py')\nprint(json.dumps({\n    'solutionSha256': solution['sha256'],\n    'solutionBytes': solution['bytes'],\n    'solutionExists': solution['exists'],\n    'testFileSha256': test_file['sha256'],\n    'testFileBytes': test_file['bytes'],\n    'testFileExists': test_file['exists'],\n}, sort_keys=True))\nPY"

const t = args ?? {}
const evaluation = t.evaluation ?? {}
const expected = evaluation.expectedOutput ?? {}
const template = t.sandboxTemplate || 'code-eval-evalplus'
const taskId = t.taskId || evaluation.itemId || 'code-eval'

phase('Setup')

const profile = await action('workspace/profile', {
  name: `code-eval-${taskId}`,
  rootPath: '/sandbox',
  sandboxTemplate: template,
  ttlSeconds: 1800,
  keepAfterRun: true,
  managedBy: 'workflow-builder:evaluations:code-eval',
  commandTimeoutMs: 180000,
  timeoutMs: 240000,
  enabledTools: ['execute_command', 'read_file', 'write_file', 'edit_file', 'list_files', 'mkdir', 'file_stat'],
  sandboxPolicy: { keepAfterRun: true, mode: 'per-run', template, ttlSeconds: 1800 },
}, { label: 'workspace_profile' })

// workspace/profile returns `{ result: { workspaceRef, sandbox: {...}, … } }` —
// unwrap it (the SW spec read `.workspace_profile.workspaceRef` off the node
// output envelope, which the interpreter had already flattened).
const profileData = profile?.result ?? profile ?? {}
const workspaceRef = profileData.workspaceRef
const sandboxName =
  profileData.sandboxName ??
  profileData.sandbox?.details?.sandboxName ??
  profileData.sandbox?.sandboxName

const probe = await action('workspace/command', {
  workspaceRef,
  command: t.runtimeProbeCommand,
  allowFailure: true,
  timeoutMs: 60000,
}, { label: 'validate_runtime', allowFailure: true })

const probeExit = shell(probe).exitCode
let solutionContent = ''
let tests = null
let metadata = null

if (probeExit === 0) {
  await action('workspace/write_file', {
    workspaceRef,
    path: '/sandbox/test_solution.py',
    content: expected.testFileContent,
    timeoutMs: 60000,
  }, { label: 'write_test' })

  phase('Solve')
  await agent(t.solvePrompt, {
    label: 'solve',
    agent: t.agentRef?.id ?? t.agentRef,
    ...(t.agentRef?.version != null ? { agentVersion: t.agentRef.version } : {}),
    sandbox: {
      workspaceRef,
      sandboxName,
      cwd: '/sandbox',
      maxTurns: 30,
      timeoutMinutes: 8,
      policy: { keepAfterRun: true, mode: 'per-run', template, ttlSeconds: 1800 },
    },
  })

  phase('Grade')
  // The agent may have overwritten the test file — restore it before grading.
  await action('workspace/write_file', {
    workspaceRef,
    path: '/sandbox/test_solution.py',
    content: expected.testFileContent,
    timeoutMs: 60000,
  }, { label: 'restore_test' })

  tests = await action('workspace/command', {
    workspaceRef,
    command: RUN_TESTS_COMMAND,
    allowFailure: true,
    timeoutMs: 300000,
  }, { label: 'run_tests', allowFailure: true })

  const solution = await action('workspace/read_file', {
    workspaceRef,
    path: '/sandbox/solution.py',
    timeoutMs: 60000,
  }, { label: 'read_solution', allowFailure: true })
  solutionContent = shell(solution).content

  metadata = await action('workspace/command', {
    workspaceRef,
    command: CAPTURE_METADATA_COMMAND,
    timeoutMs: 60000,
  }, { label: 'capture_metadata', allowFailure: true })
}

// workspace/* actions return `{ result: {stdout, stderr, exitCode}, backend, … }`
// — unwrap it (the SW spec did this with `.output.result.stdout // .output.stdout`).
function shell(res) {
  const r = res?.result ?? res ?? {}
  return {
    exitCode: r.exitCode ?? res?.exitCode ?? 1,
    stdout: r.stdout ?? res?.stdout ?? '',
    stderr: r.stderr ?? res?.stderr ?? '',
    content: r.content ?? res?.content ?? '',
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text ?? '{}')
  } catch {
    return {}
  }
}

const meta_ = parseJson(shell(metadata).stdout)
const testsShell = shell(tests)
const exitCode = tests ? testsShell.exitCode : 1
const stdout = testsShell.stdout
const stderr = testsShell.stderr

return {
  taskId,
  passed: exitCode === 0,
  exitCode,
  stdout,
  stderr,
  pytestOutput: stdout + (stderr ? '\n' + stderr : ''),
  solutionPath: '/sandbox/solution.py',
  solutionContent,
  solutionSha256: meta_.solutionSha256 ?? '',
  testFileSha256: meta_.testFileSha256 ?? expected.testFileSha256 ?? '',
  runtimeProbe: shell(probe),
}
