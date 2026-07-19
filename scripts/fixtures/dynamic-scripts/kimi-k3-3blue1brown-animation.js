export const meta = {
  name: "kimi-k3-3blue1brown-animation",
  description:
    "Build a 3Blue1Brown-style Canvas or SVG animation with Kimi K3 in a retained sandbox, capture the play and restart states, and start a live preview.",
  phases: [
    { title: "Setup" },
    { title: "Build", model: "kimi/kimi-k3" },
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
          "Create a concise 3Blue1Brown-style derivative animation for x^2",
        description:
          "Describe the 3Blue1Brown-style animation the agent should build.",
      },
      sandboxTemplate: {
        type: "string",
        title: "Sandbox template",
        default: "dapr-agent",
      },
    },
  },
};

const input = args ?? {};
const template = input.sandboxTemplate ?? "dapr-agent";
const description = input.animationDescription;
const appPath = "/sandbox/kimi-k3-math-animation";
const buildSchema = {
  type: "object",
  additionalProperties: false,
  required: ["files", "summary", "verification"],
  properties: {
    files: {
      type: "array",
      minItems: 4,
      uniqueItems: true,
      items: { type: "string", minLength: 1 },
    },
    summary: { type: "string", minLength: 1 },
    verification: { type: "string", minLength: 1 },
  },
};

function payload(result) {
  const base = result?.data ?? result ?? {};
  return base.result ?? base;
}

function requiredString(name, value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} was not returned by workspace/profile`);
  }
  return value;
}

phase("Setup");
const profile = await action(
  "workspace/profile",
  {
    name: "kimi-k3-dynamic-animation",
    rootPath: "/sandbox",
    sandboxTemplate: template,
    ttlSeconds: 7200,
    keepAfterRun: true,
    managedBy: "workflow-builder:demos:kimi-k3-dynamic-animation",
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
  { label: "workspace_profile" },
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
  `${description} - Build a self-contained browser animation in ${appPath} with index.html, styles.css, script.js, and README.md. Use Canvas or SVG so the result runs via a simple static file server. The browser animation is the required deliverable. Treat 1280x720 at 100% zoom as a hard required viewport. The complete title, formula, plot, live readout, and both controls must fit in one viewport without page scrolling, clipping, or overlap; size the stage responsively from both the available viewport width and height, not width alone. In a real browser at 1280x720, verify document.documentElement.scrollWidth <= 1280, document.documentElement.scrollHeight <= 720, canvas.getBoundingClientRect().top >= 0, canvas.getBoundingClientRect().bottom <= 720, and both control buttons are fully inside the viewport. Hiding overflow is not a substitute for satisfying those bounds. Also keep the layout usable without horizontal overflow at 390x844. Reserve distinct title/formula, plot, readout, and control safe zones. Clip every tangent and other animated plot primitive to the plot rectangle with Canvas ctx.clip() or an SVG clipPath, restore the drawing context before rendering title/readout UI, and ensure no tangent pixel can enter a UI safe zone at x = 0, pi/2, pi, 3pi/2, or 2pi. Do not scale font size with viewport width, and use zero letter spacing. Use stable DOM ids for validation: the main canvas must be <canvas id="canvas">, the play/pause control <button id="btn-play">, and the restart control <button id="btn-restart">. Do not install Manim; if a scene is useful, include scene.py as optional source only. Do not start a preview server; the downstream browser actions do that. The page must work as static files with only relative script.js imports. Do not create package.json because that selects the npm dev-server path. Verify syntax, interactions, and the measured viewport invariants, then return the file paths, a concise animation summary, and the verification performed.`,
  {
    label: "build_3b1b_animation",
    phase: "Build",
    agent: __KIMI_AGENT_ID_JSON__,
    agentVersion: __KIMI_AGENT_VERSION__,
    agentType: "dapr-agent-py",
    model: "kimi/kimi-k3",
    effort: "max",
    isolation: "shared",
    schema: buildSchema,
    sandbox: {
      workspaceRef,
      sandboxName,
      cwd: "/sandbox",
      maxTurns: 60,
      timeoutMinutes: 60,
      policy: {
        mode: "per-run",
        template,
        ttlSeconds: 7200,
        keepAfterRun: true,
      },
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
  throw new Error("Kimi K3 did not produce a complete animation result");
}

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
    demoTitle: `3Blue1Brown-style animation: ${description}`,
    demoSummary:
      "Kimi K3 generated the browser animation; validation captured the initial, play, second-play, and restart states.",
    metadata: {
      appPath,
      workflowStage: "post-kimi-k3-animation",
      runtimeSandboxName: sandboxName,
    },
    timeoutMs: 900000,
  },
  { label: "browser_validate_capture" },
);

phase("Preview");
const preview = await action(
  "browser/start-preview",
  {
    previewId: `kimi-k3-animation-preview-${workspaceRef}`,
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
  { label: "start_preview" },
);

return {
  appPath,
  workspaceRef,
  sandboxName,
  runtimeSandboxName: sandboxName,
  animation:
    typeof animation === "string" ? animation.slice(0, 4000) : animation,
  screenshots: payload(screenshots),
  preview: payload(preview),
};
