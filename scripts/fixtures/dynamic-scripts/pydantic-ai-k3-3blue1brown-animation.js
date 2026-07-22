export const meta = {
  name: "pydantic-ai-k3-3blue1brown-animation",
  description:
    "Build a 3Blue1Brown-style browser animation with Pydantic AI and Kimi K3, materialize it into a retained browser sandbox, capture its interaction states, and start a live preview.",
  phases: [
    { title: "Setup" },
    { title: "Build", model: "kimi/kimi-k3" },
    { title: "Materialize" },
    { title: "Validate" },
    { title: "Preview" },
  ],
  input: {
    type: "object",
    required: ["animationDescription"],
    additionalProperties: false,
    properties: {
      animationDescription: {
        type: "string",
        title: "Animation description",
        minLength: 1,
        maxLength: 12000,
        default:
          "Create a concise 3Blue1Brown-style animation explaining the derivative of sin(x), with a moving point, clipped tangent line, and synchronized cos(x) slope readout from x=0 to 2*pi.",
        description:
          "Describe the 3Blue1Brown-style animation the agent should build.",
      },
      sandboxTemplate: {
        type: "string",
        title: "Browser sandbox template",
        default: "dapr-agent",
      },
    },
  },
};

const input = args ?? {};
const template = input.sandboxTemplate ?? "dapr-agent";
const description = input.animationDescription;
const sourceAppPath = "/sandbox/work/pydantic-ai-k3-math-animation";
const appPath = "/sandbox/pydantic-ai-k3-math-animation";
const buildSchema = {
  type: "object",
  additionalProperties: false,
  required: ["files", "summary", "verification"],
  properties: {
    files: {
      type: "array",
      minItems: 4,
      maxItems: 8,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 512 },
    },
    summary: { type: "string", minLength: 1, maxLength: 2000 },
    verification: { type: "string", minLength: 1, maxLength: 4000 },
  },
};

function payload(result) {
  const base = result?.data ?? result ?? {};
  return base.result ?? base;
}

function shell(result) {
  const base = result?.data ?? result ?? {};
  const value = base.result ?? base;
  return {
    exitCode: value.exitCode ?? base.exitCode ?? 1,
    stdout: value.stdout ?? base.stdout ?? "",
    stderr: value.stderr ?? base.stderr ?? "",
  };
}

function requiredString(name, value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} was not returned by workspace/profile`);
  }
  return value;
}

function requireCommand(name, result) {
  const value = shell(result);
  if (value.exitCode !== 0) {
    throw new Error(
      `${name} failed: ${String(value.stderr || value.stdout).slice(0, 2000)}`,
    );
  }
  return value;
}

function requireFile(name, result) {
  const value = requireCommand(name, result);
  if (typeof value.stdout !== "string" || value.stdout.length === 0) {
    throw new Error(`${name} returned an empty file`);
  }
  return value.stdout;
}

phase("Setup");
const profile = await action(
  "workspace/profile",
  {
    name: "pydantic-ai-k3-animation-preview-workspace",
    rootPath: "/sandbox",
    sandboxTemplate: template,
    ttlSeconds: 7200,
    keepAfterRun: true,
    managedBy: "workflow-builder:demos:pydantic-ai-k3-animation",
    commandTimeoutMs: 900000,
    timeoutMs: 1200000,
    enabledTools: [
      "execute_command",
      "read_file",
      "write_file",
      "edit_file",
      "list_files",
      "mkdir",
      "file_stat",
    ],
    sandboxPolicy: {
      mode: "per-run",
      template,
      ttlSeconds: 7200,
      keepAfterRun: true,
    },
  },
  { label: "workspace_profile_pydantic_preview" },
);
const profileData = payload(profile);
const workspaceRef = requiredString("workspaceRef", profileData.workspaceRef);
const sandboxName = requiredString(
  "sandboxName",
  profileData.sandboxName ??
    profileData.sandbox?.details?.sandboxName ??
    profileData.sandbox?.sandboxName,
);

phase("Build");
const animation = await agent(
  `${description} - Build a compact, self-contained browser animation in ${sourceAppPath} with exactly these required files: index.html, styles.css, script.js, and README.md. Work only in the shared workspace rooted at /sandbox/work. Use Canvas or SVG with plain HTML, CSS, and JavaScript so the result runs through a simple static file server. Treat 1280x720 at 100% zoom as a hard viewport: the complete title, formula, plot, live readout, and both controls must fit without page scrolling, clipping, or overlap. Size the stage from both available width and height, and keep it usable without horizontal overflow at 390x844. Reserve distinct title/formula, plot, readout, and control safe zones. Clip every tangent and animated plot primitive to the plot rectangle with Canvas ctx.clip() or an SVG clipPath, restoring the drawing context before title/readout UI. Do not scale font size with viewport width, and use zero letter spacing. Use these stable DOM ids: <canvas id="canvas">, <button id="btn-play">, and <button id="btn-restart">. Do not install Manim, start a preview server, create package.json, embed base64 media, or read environment credentials. Keep index.html at most 24 KiB, styles.css at most 48 KiB, script.js at most 96 KiB, and README.md at most 16 KiB. Verify JavaScript syntax and the required files before returning their paths, a concise summary, and verification performed.`,
  {
    label: "build_pydantic_3b1b_animation",
    phase: "Build",
    agent: __PYDANTIC_AGENT_ID_JSON__,
    agentVersion: __PYDANTIC_AGENT_VERSION__,
    agentType: "pydantic-ai-agent-py",
    model: "kimi/kimi-k3",
    effort: "max",
    isolation: "shared",
    schema: buildSchema,
    sandbox: {
      cwd: "/sandbox/work",
      maxTurns: 40,
      timeoutMinutes: 60,
    },
  },
);
if (
  !animation ||
  !Array.isArray(animation.files) ||
  animation.files.length < 4 ||
  typeof animation.summary !== "string" ||
  !animation.summary.trim() ||
  typeof animation.verification !== "string" ||
  !animation.verification.trim()
) {
  throw new Error(
    "Pydantic AI Kimi K3 did not produce a complete animation result",
  );
}

phase("Materialize");
const sourceGate = await action(
  "workspace/command",
  {
    cliWorkspace: true,
    helperPod: true,
    helperTimeoutMinutes: 120,
    cwd: "/sandbox/work",
    command: `set -eu
APP="${sourceAppPath}"
test -d "$APP"
test ! -L "$APP"
test -f "$APP/index.html" && test ! -L "$APP/index.html" && test -s "$APP/index.html"
test -f "$APP/styles.css" && test ! -L "$APP/styles.css" && test -s "$APP/styles.css"
test -f "$APP/script.js" && test ! -L "$APP/script.js" && test -s "$APP/script.js"
test -f "$APP/README.md" && test ! -L "$APP/README.md" && test -s "$APP/README.md"
test "$(wc -c < "$APP/index.html")" -le 24576
test "$(wc -c < "$APP/styles.css")" -le 49152
test "$(wc -c < "$APP/script.js")" -le 98304
test "$(wc -c < "$APP/README.md")" -le 16384
test ! -e "$APP/package.json"
node --check "$APP/script.js"
printf 'PYDANTIC_SOURCE_OK\n'`,
    timeoutMs: 120000,
  },
  {
    label: "validate_pydantic_source",
    phase: "Materialize",
    allowFailure: true,
  },
);
requireCommand("Pydantic source validation", sourceGate);

const readIndex = await action(
  "workspace/command",
  {
    cliWorkspace: true,
    helperPod: true,
    helperTimeoutMinutes: 120,
    cwd: "/sandbox/work",
    command: `test -s "${sourceAppPath}/index.html"`,
    readFile: `${sourceAppPath}/index.html`,
    timeoutMs: 60000,
  },
  { label: "read_pydantic_index", phase: "Materialize", allowFailure: true },
);
const indexHtml = requireFile("Pydantic index.html read", readIndex);

const readStyles = await action(
  "workspace/command",
  {
    cliWorkspace: true,
    helperPod: true,
    helperTimeoutMinutes: 120,
    cwd: "/sandbox/work",
    command: `test -s "${sourceAppPath}/styles.css"`,
    readFile: `${sourceAppPath}/styles.css`,
    timeoutMs: 60000,
  },
  { label: "read_pydantic_styles", phase: "Materialize", allowFailure: true },
);
const stylesCss = requireFile("Pydantic styles.css read", readStyles);

const readScript = await action(
  "workspace/command",
  {
    cliWorkspace: true,
    helperPod: true,
    helperTimeoutMinutes: 120,
    cwd: "/sandbox/work",
    command: `test -s "${sourceAppPath}/script.js"`,
    readFile: `${sourceAppPath}/script.js`,
    timeoutMs: 60000,
  },
  { label: "read_pydantic_script", phase: "Materialize", allowFailure: true },
);
const scriptJs = requireFile("Pydantic script.js read", readScript);

const readReadme = await action(
  "workspace/command",
  {
    cliWorkspace: true,
    helperPod: true,
    helperTimeoutMinutes: 120,
    cwd: "/sandbox/work",
    command: `test -s "${sourceAppPath}/README.md"`,
    readFile: `${sourceAppPath}/README.md`,
    timeoutMs: 60000,
  },
  { label: "read_pydantic_readme", phase: "Materialize", allowFailure: true },
);
const readmeMd = requireFile("Pydantic README.md read", readReadme);

const prepareDestination = await action(
  "workspace/command",
  {
    workspaceRef,
    command: `set -eu
rm -rf "${appPath}"
mkdir -p "${appPath}"`,
    timeoutMs: 60000,
  },
  {
    label: "prepare_materialized_app",
    phase: "Materialize",
    allowFailure: true,
  },
);
requireCommand("OpenShell destination preparation", prepareDestination);

const materialized = await action(
  "workspace/materialize-files",
  {
    workspaceRef,
    files: [
      { path: `${appPath}/index.html`, content: indexHtml },
      { path: `${appPath}/styles.css`, content: stylesCss },
      { path: `${appPath}/script.js`, content: scriptJs },
      { path: `${appPath}/README.md`, content: readmeMd },
    ],
    timeoutMs: 120000,
  },
  {
    label: "materialize_pydantic_app",
    phase: "Materialize",
    allowFailure: true,
  },
);
const materializedData = payload(materialized);
if (
  materializedData.success !== true ||
  !Array.isArray(materializedData.files) ||
  materializedData.files.length !== 4
) {
  throw new Error(
    `OpenShell app materialization failed: ${JSON.stringify(materializedData).slice(0, 2000)}`,
  );
}

const materializedGate = await action(
  "workspace/command",
  {
    workspaceRef,
    command: `set -eu
APP="${appPath}"
test -s "$APP/index.html"
test -s "$APP/styles.css"
test -s "$APP/script.js"
test -s "$APP/README.md"
test ! -e "$APP/package.json"
node --check "$APP/script.js"
printf 'OPENSHELL_DESTINATION_OK\n'`,
    timeoutMs: 120000,
  },
  {
    label: "validate_materialized_app",
    phase: "Materialize",
    allowFailure: true,
  },
);
requireCommand("Materialized OpenShell app validation", materializedGate);

phase("Validate");
const screenshots = await action(
  "browser/validate",
  {
    workspaceRef,
    sandboxName,
    repoPath: appPath,
    installCommand: "",
    baseUrl: "http://127.0.0.1:0",
    steps: [
      {
        id: "initial",
        label: "Animation loaded",
        action: "visit",
        path: "/",
        goal: "Initial render of the canvas before any interaction.",
        waitForSelector: "canvas#canvas",
        pauseMs: 1500,
        fullPage: false,
      },
      {
        id: "after-play",
        label: "After play",
        action: "click",
        selector: "button#btn-play",
        goal: "Trigger the play control once.",
        waitForSelector: "canvas#canvas",
        pauseMs: 2000,
        fullPage: false,
      },
      {
        id: "after-second-play",
        label: "After second play",
        action: "click",
        selector: "button#btn-play",
        goal: "Capture a later animation state after a second play interaction.",
        waitForSelector: "canvas#canvas",
        pauseMs: 1500,
        fullPage: false,
      },
      {
        id: "after-restart",
        label: "After restart",
        action: "click",
        selector: "button#btn-restart",
        goal: "Restart the animation and capture the reset state.",
        waitForSelector: "canvas#canvas",
        pauseMs: 1500,
        fullPage: false,
      },
    ],
    captureVideo: true,
    captureTrace: true,
    viewportPreset: "desktop",
    captureMode: "demo",
    demoTitle: `Pydantic AI 3Blue1Brown-style animation: ${description}`,
    demoSummary:
      "Pydantic AI with Kimi K3 generated the animation in JuiceFS; the workflow materialized it into the retained browser sandbox and captured its interaction states.",
    metadata: {
      appPath,
      sourceAppPath,
      workflowStage: "post-pydantic-ai-k3-animation",
      runtimeSandboxName: sandboxName,
    },
    timeoutMs: 900000,
  },
  { label: "browser_validate_pydantic_capture" },
);

phase("Preview");
const preview = await action(
  "browser/start-preview",
  {
    previewId: `pydantic-ai-k3-animation-preview-${workspaceRef}`,
    workspaceRef,
    sandboxName,
    repoPath: appPath,
    rootPath: "/sandbox",
    workingDir: "/sandbox",
    installCommand: "",
    devServerCommand: "",
    baseUrl: "http://127.0.0.1:0",
    keepAlive: true,
    timeoutSeconds: 7200,
    timeoutMs: 7200000,
  },
  { label: "start_pydantic_preview" },
);

return {
  appPath,
  sourceAppPath,
  workspaceRef,
  sandboxName,
  runtimeSandboxName: sandboxName,
  animation,
  screenshots: payload(screenshots),
  preview: payload(preview),
};
