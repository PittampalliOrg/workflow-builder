export const meta = {
  "name": "microservice-dev-session",
  "description": "Provision a per-run isolated dev preview for one or more microservices, seed the shared workspace with the repo, and hand off into a persistent interactive coding session.",
  "phases": [
    {
      "title": "Provision"
    },
    {
      "title": "Seed"
    },
    {
      "title": "Handoff"
    }
  ],
  "launch": {
    "surface": "dev-environment"
  },
  "input": {
    "type": "object",
    "properties": {
      "service": {
        "type": "string",
        "title": "Microservice to develop",
        "default": "workflow-orchestrator",
        "description": "workflow-builder | workflow-orchestrator | function-router | mcp-gateway | workflow-mcp-server (catalog-backed preview services)."
      },
      "services": {
        "type": "array",
        "title": "Microservices to develop",
        "items": {
          "type": "string"
        },
        "default": [
          "workflow-builder",
          "workflow-orchestrator",
          "function-router",
          "mcp-gateway",
          "workflow-mcp-server"
        ]
      },
      "mode": {
        "type": "string",
        "title": "Dev-preview mode",
        "default": "preview-native",
        "description": "preview-native runs inside an isolated Tier-2 vCluster and adopts each selected service for live edits. host-throwaway remains an explicit compatibility mode for legacy host-cluster sessions."
      },
      "keepPreview": {
        "type": "string",
        "title": "Keep the preview alive after the run",
        "default": "true"
      },
      "repoUrl": {
        "type": "string",
        "title": "Repo (owner/repo)",
        "default": "PittampalliOrg/workflow-builder"
      },
      "sourceRevision": {
        "type": "string",
        "title": "Immutable source revision"
      },
      "previewOrigin": {
        "type": "string",
        "title": "Preview HTTPS origin"
      }
    }
  }
}

// Ported from the SW 1.0 fixture (cutover P3, item 15). dev/preview keeps its
// durable activation contract: action() routes preview-native activations to the
// action_runner child, which reuses the interpreter's ready-set poll (blocker B1).
// jq's @sh / @base64 become the two helpers below; the seed shell + handoff prose
// are preserved VERBATIM from the fixture.

function shq(value) {
  return "'" + String(value ?? '').split("'").join("'\\''") + "'"
}
function b64(text) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < text.length; i += 3) {
    const c1 = text.charCodeAt(i)
    const c2 = text.charCodeAt(i + 1)
    const c3 = text.charCodeAt(i + 2)
    out += chars[c1 >> 2]
    out += chars[((c1 & 3) << 4) | (Number.isNaN(c2) ? 0 : c2 >> 4)]
    out += Number.isNaN(c2) ? '=' : chars[((c2 & 15) << 2) | (Number.isNaN(c3) ? 0 : c3 >> 6)]
    out += Number.isNaN(c3) ? '=' : chars[c3 & 63]
  }
  return out
}
const SEED_SHELL = "\nset -eu\ncd /sandbox/work\nrm -rf repo .syncenv .syncenv.d .preview-services.json .preview-services-summary .sparse-paths .sparse-cones .sparse-cones.unsorted\nrm -f repo.tar repo.tar.sha256 activate-repo.sh sync.sh .syncdeps.* .repo-link.* .repo.tar.tmp.* .repo.tar.sha256.tmp.* .activate-repo.tmp.*\ncat > .gitignore <<'WFB_ROOT_GITIGNORE'\n/repo\n/repo.tar\n/repo.tar.sha256\n/activate-repo.sh\n/sync.sh\n/.syncenv\n/.syncenv.d\n/.preview-services.json\n/.preview-services-summary\n/.sparse-paths\n/.sparse-cones\n/.sparse-cones.unsorted\n/.syncdeps.*\n/.repo-link.*\n/.repo.tar.tmp.*\n/.repo.tar.sha256.tmp.*\n/.activate-repo.tmp.*\nWFB_ROOT_GITIGNORE\ntest \"$REPOURL\" = PittampalliOrg/workflow-builder || { echo 'repoUrl must be PittampalliOrg/workflow-builder' >&2; exit 2; }\ncase \"$MODE\" in host-throwaway|preview-native) ;; *) echo 'unsupported dev-preview mode' >&2; exit 2 ;; esac\nif [ \"$MODE\" = preview-native ]; then printf '%s' \"$SOURCE_REVISION\" | grep -Eq '^[0-9a-f]{40}$' || { echo 'preview-native requires a lowercase 40-hex sourceRevision' >&2; exit 2; }; fi\npython3 - <<'PY_PREVIEW_METADATA'\nimport base64\nimport binascii\nimport json\nimport os\nimport posixpath\nimport re\nimport shlex\nimport sys\nimport urllib.parse\nfrom pathlib import Path\n\nMAX_ENCODED_BYTES = 1024 * 1024\nMAX_DECODED_BYTES = 768 * 1024\nMAX_SERVICES = 32\nSAFE_SERVICE = re.compile(r\"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$\")\nSAFE_PATH = re.compile(r\"^[A-Za-z0-9._+-]+(?:/[A-Za-z0-9._+-]+)*$\")\nSAFE_HEALTH_PATH = re.compile(r\"^/(?:[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*)?$\")\n\n\ndef invalid():\n    raise ValueError(\"invalid preview metadata\")\n\n\ndef safe_text(value, *, allow_empty=False, limit=8192):\n    if not isinstance(value, str) or len(value) > limit:\n        invalid()\n    if not allow_empty and not value:\n        invalid()\n    if any(ord(char) < 32 or ord(char) == 127 for char in value):\n        invalid()\n    return value\n\n\ndef safe_path(value):\n    value = safe_text(value, limit=512)\n    if SAFE_PATH.fullmatch(value) is None:\n        invalid()\n    return value\n\n\ndef mappings(value):\n    if not isinstance(value, list) or len(value) > 128:\n        invalid()\n    result = []\n    for entry in value:\n        if not isinstance(entry, dict):\n            invalid()\n        result.append((safe_path(entry.get(\"from\")), safe_path(entry.get(\"to\"))))\n    return result\n\n\ndef repository_path(base, relative):\n    resolved = posixpath.normpath(posixpath.join(base, relative))\n    if (\n        not resolved\n        or resolved in (\".\", \"..\")\n        or resolved.startswith(\"../\")\n        or posixpath.isabs(resolved)\n    ):\n        invalid()\n    return resolved.removeprefix(\"./\")\n\n\ndef write_private(path, content):\n    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, \"O_NOFOLLOW\", 0)\n    fd = os.open(path, flags, 0o600)\n    with os.fdopen(fd, \"w\", encoding=\"utf-8\", newline=\"\\n\") as handle:\n        handle.write(content)\n    os.chmod(path, 0o600)\n\n\ntry:\n    encoded = os.environ.get(\"PREVIEWS_B64\", \"\")\n    if not encoded or len(encoded) > MAX_ENCODED_BYTES:\n        invalid()\n    decoded = base64.b64decode(encoded, validate=True)\n    if not decoded or len(decoded) > MAX_DECODED_BYTES:\n        invalid()\n    previews = json.loads(decoded.decode(\"utf-8\"))\n    if not isinstance(previews, list) or not 1 <= len(previews) <= MAX_SERVICES:\n        invalid()\n\n    seen = set()\n    services = []\n    sparse_paths = {\"scripts/dev-sync/sync.sh\"}\n    sync_files = []\n    for entry in previews:\n        if not isinstance(entry, dict) or entry.get(\"ok\") is not True:\n            invalid()\n        service = entry.get(\"service\")\n        if not isinstance(service, str) or SAFE_SERVICE.fullmatch(service) is None:\n            invalid()\n        if service in seen:\n            invalid()\n        seen.add(service)\n\n        info = entry.get(\"info\")\n        if not isinstance(info, dict) or info.get(\"ready\") is not True:\n            invalid()\n        repo_subdir = safe_path(info.get(\"repoSubdir\", \".\"))\n        sync_paths = info.get(\"syncPaths\", [\"src\"])\n        if not isinstance(sync_paths, list) or not 1 <= len(sync_paths) <= 128:\n            invalid()\n        sync_paths = [safe_path(path) for path in sync_paths]\n        sync_url = safe_text(info.get(\"syncUrl\"), limit=2048)\n        if re.fullmatch(r\"https?://[^\\s]+\", sync_url) is None:\n            invalid()\n        service_url = safe_text(info.get(\"url\"), limit=2048)\n        parsed_url = urllib.parse.urlsplit(service_url)\n        try:\n            service_port = parsed_url.port\n        except ValueError:\n            invalid()\n        if (\n            parsed_url.scheme not in (\"http\", \"https\")\n            or not parsed_url.hostname\n            or parsed_url.username is not None\n            or parsed_url.password is not None\n            or service_port is None\n            or parsed_url.path not in (\"\", \"/\")\n            or parsed_url.query\n            or parsed_url.fragment\n        ):\n            invalid()\n        health_path = safe_text(info.get(\"healthPath\"), limit=512)\n        if (\n            SAFE_HEALTH_PATH.fullmatch(health_path) is None\n            or posixpath.normpath(health_path) != health_path\n        ):\n            invalid()\n        health_url = service_url.rstrip(\"/\") + health_path\n        sync_token = safe_text(info.get(\"syncCapability\"), limit=16384)\n        extra_sync = mappings(info.get(\"extraSync\", []))\n        capture_only = mappings(info.get(\"captureOnly\", []))\n        combined_mappings = extra_sync + capture_only\n\n        for path in sync_paths:\n            sparse_paths.add(repository_path(repo_subdir, path))\n        for source, _target in combined_mappings:\n            sparse_paths.add(repository_path(repo_subdir, source))\n\n        env_values = {\n            \"SERVICE\": service,\n            \"SUBDIR\": repo_subdir,\n            \"PATHS\": \" \".join(sync_paths),\n            \"SYNCURL\": sync_url,\n            \"HEALTHURL\": health_url,\n            \"SYNC_TOKEN\": sync_token,\n            \"EXTRASYNC\": \" \".join(\n                f\"{source}:{target}\" for source, target in combined_mappings\n            ),\n        }\n        sync_files.append(\n            (\n                service,\n                \"\".join(\n                    f\"{key}={shlex.quote(value)}\\n\"\n                    for key, value in env_values.items()\n                ),\n            )\n        )\n        services.append(service)\n\n    sync_dir = Path(\".syncenv.d\")\n    sync_dir.mkdir(mode=0o700)\n    os.chmod(sync_dir, 0o700)\n    write_private(\n        \".preview-services.json\",\n        json.dumps(previews, ensure_ascii=True, separators=(\",\", \":\")) + \"\\n\",\n    )\n    write_private(\".sparse-paths\", \"\".join(f\"{path}\\n\" for path in sorted(sparse_paths)))\n    for service, content in sync_files:\n        write_private(sync_dir / service, content)\n    write_private(\".preview-services-summary\", \",\".join(services) + \"\\n\")\nexcept (binascii.Error, OSError, TypeError, UnicodeError, ValueError):\n    print(\"failed to materialize trusted preview service metadata\", file=sys.stderr)\n    raise SystemExit(4)\nPY_PREVIEW_METADATA\ntest -s .sparse-paths || { echo 'preview source metadata produced no checkout paths' >&2; exit 4; }\nLOCAL_ROOT=$(mktemp -d /tmp/wfb-preview-checkout.XXXXXX)\nSHARED_ARCHIVE_TMP=/sandbox/work/.repo.tar.tmp.$$\nSHARED_DIGEST_TMP=/sandbox/work/.repo.tar.sha256.tmp.$$\nSHARED_ACTIVATOR_TMP=/sandbox/work/.activate-repo.tmp.$$\ntrap 'rm -rf \"$LOCAL_ROOT\"; rm -f \"$SHARED_ARCHIVE_TMP\" \"$SHARED_DIGEST_TMP\" \"$SHARED_ACTIVATOR_TMP\"' EXIT HUP INT TERM\nCLONE_URL=\"https://github.com/$REPOURL.git\"\nexport GIT_TERMINAL_PROMPT=0\nif [ -n \"${GITHUB_TOKEN:-}\" ]; then\n  GIT_ASKPASS=\"$LOCAL_ROOT/git-askpass\"\n  printf '%s\\n' '#!/bin/sh' 'case \"$1\" in' '  *Username*) printf \"%s\\n\" x-access-token ;;' '  *Password*) printf \"%s\\n\" \"$GITHUB_TOKEN\" ;;' '  *) exit 1 ;;' 'esac' > \"$GIT_ASKPASS\"\n  chmod 700 \"$GIT_ASKPASS\"\n  export GIT_ASKPASS\nfi\nLOCAL_REPO=\"$LOCAL_ROOT/repo\"\ngit clone --filter=blob:none --no-checkout --depth 1 --single-branch \"$CLONE_URL\" \"$LOCAL_REPO\"\nif [ -n \"${GITHUB_TOKEN:-}\" ]; then\n  git -C \"$LOCAL_REPO\" config credential.username x-access-token\n  git -C \"$LOCAL_REPO\" config credential.helper '!f() { test -n \"$GITHUB_TOKEN\" || exit 1; printf \"%s\\n\" \"password=$GITHUB_TOKEN\"; }; f'\nfi\nif [ -n \"$SOURCE_REVISION\" ]; then\n  printf '%s' \"$SOURCE_REVISION\" | grep -Eq '^[0-9a-f]{40}$' || { echo 'sourceRevision must be a lowercase 40-hex Git SHA' >&2; exit 2; }\n  git -C \"$LOCAL_REPO\" fetch --no-tags --depth 1 origin \"$SOURCE_REVISION\"\n  TARGET_REVISION=\"$SOURCE_REVISION\"\nelse\n  TARGET_REVISION=$(git -C \"$LOCAL_REPO\" rev-parse HEAD)\nfi\n: > .sparse-cones.unsorted\nwhile IFS= read -r path; do\n  TREE_ENTRY=$(git -C \"$LOCAL_REPO\" ls-tree \"$TARGET_REVISION\" -- \"$path\") || { echo 'failed to inspect preview source path at target revision' >&2; exit 4; }\n  SOURCE_TYPE=$(printf '%s\\n' \"$TREE_ENTRY\" | awk 'NR == 1 { print $2 }')\n  case \"$SOURCE_TYPE\" in\n    tree) printf '%s\\n' \"$path\" >> .sparse-cones.unsorted ;;\n    blob)\n      case \"$path\" in\n        */*) printf '%s\\n' \"${path%/*}\" >> .sparse-cones.unsorted ;;\n      esac\n      ;;\n    \"\") printf '%s\\n' \"$path\" >> .sparse-cones.unsorted ;;\n    *) echo 'preview source metadata resolved to an unsupported Git object' >&2; exit 4 ;;\n  esac\ndone < .sparse-paths\nsort -u .sparse-cones.unsorted > .sparse-cones\ngit -C \"$LOCAL_REPO\" sparse-checkout init --cone\ngit -C \"$LOCAL_REPO\" sparse-checkout set --stdin < .sparse-cones\ngit -C \"$LOCAL_REPO\" checkout --detach \"$TARGET_REVISION\"\nACTUAL_REVISION=$(git -C \"$LOCAL_REPO\" rev-parse HEAD)\nif [ -n \"$SOURCE_REVISION\" ]; then test \"$ACTUAL_REVISION\" = \"$SOURCE_REVISION\" || { echo 'checked-out revision does not match sourceRevision' >&2; exit 3; }; fi\ngit -C \"$LOCAL_REPO\" remote set-url origin \"$CLONE_URL\"\ntest -z \"$(git -C \"$LOCAL_REPO\" status --porcelain --untracked-files=all)\" || { echo 'local preview checkout is not clean' >&2; exit 3; }\nprintf '%s\\n' \"$ACTUAL_REVISION\" > \"$LOCAL_REPO/.git/wfb-preview-source-revision\"\nchmod 600 \"$LOCAL_REPO/.git/wfb-preview-source-revision\"\ntar -C \"$LOCAL_REPO\" -cf \"$LOCAL_ROOT/repo.tar\" .\nARCHIVE_DIGEST=$(sha256sum \"$LOCAL_ROOT/repo.tar\")\nARCHIVE_DIGEST=${ARCHIVE_DIGEST%% *}\nprintf '%s' \"$ARCHIVE_DIGEST\" | grep -Eq '^[0-9a-f]{64}$' || { echo 'failed to hash preview source archive' >&2; exit 3; }\ncp \"$LOCAL_ROOT/repo.tar\" \"$SHARED_ARCHIVE_TMP\"\nchmod 600 \"$SHARED_ARCHIVE_TMP\"\nmv -f \"$SHARED_ARCHIVE_TMP\" /sandbox/work/repo.tar\nprintf '%s  repo.tar\\n' \"$ARCHIVE_DIGEST\" > \"$SHARED_DIGEST_TMP\"\nchmod 600 \"$SHARED_DIGEST_TMP\"\nmv -f \"$SHARED_DIGEST_TMP\" /sandbox/work/repo.tar.sha256\n{\n  printf '%s\\n' '#!/bin/sh' \"EXPECTED_DIGEST=$ARCHIVE_DIGEST\" \"EXPECTED_REVISION=$ACTUAL_REVISION\"\n  cat <<'ACTIVATE_REPO'\nset -eu\nWORKSPACE=/sandbox/work\nLOCAL_REPO=/tmp/wfb-dev-repo\nARCHIVE=\"$WORKSPACE/repo.tar\"\nDIGEST_FILE=\"$WORKSPACE/repo.tar.sha256\"\nREPO_LINK=\"$WORKSPACE/repo\"\nREPO_STAGING=\nLOCAL_ARCHIVE=\nLINK_STAGING=\"$WORKSPACE/.repo-link.$$\"\n\nfail() {\n  echo \"preview repository activation failed\" >&2\n  exit 6\n}\n\ncleanup() {\n  [ -z \"$REPO_STAGING\" ] || rm -rf \"$REPO_STAGING\"\n  [ -z \"$LOCAL_ARCHIVE\" ] || rm -f \"$LOCAL_ARCHIVE\"\n  rm -f \"$LINK_STAGING\"\n}\ntrap cleanup EXIT HUP INT TERM\n\ncase \"$WORKSPACE\" in /*) ;; *) fail ;; esac\ncase \"$LOCAL_REPO\" in /tmp/*) ;; *) fail ;; esac\nprintf '%s' \"$EXPECTED_DIGEST\" | grep -Eq '^[0-9a-f]{64}$' || fail\nprintf '%s' \"$EXPECTED_REVISION\" | grep -Eq '^[0-9a-f]{40}$' || fail\n[ ! -L \"$LOCAL_REPO\" ] || fail\n\nlink_repo() {\n  if [ -e \"$REPO_LINK\" ] && [ ! -L \"$REPO_LINK\" ]; then fail; fi\n  rm -f \"$LINK_STAGING\"\n  ln -s \"$LOCAL_REPO\" \"$LINK_STAGING\"\n  mv -Tf \"$LINK_STAGING\" \"$REPO_LINK\"\n}\n\nif [ -d \"$LOCAL_REPO/.git\" ] && [ -f \"$LOCAL_REPO/.git/wfb-preview-archive-sha256\" ]; then\n  IFS= read -r ACTIVE_DIGEST < \"$LOCAL_REPO/.git/wfb-preview-archive-sha256\" || fail\n  IFS= read -r SOURCE_REVISION < \"$LOCAL_REPO/.git/wfb-preview-source-revision\" || fail\n  ACTIVE_REVISION=$(git -C \"$LOCAL_REPO\" rev-parse HEAD) || fail\n  test \"$ACTIVE_DIGEST\" = \"$EXPECTED_DIGEST\" || fail\n  test \"$SOURCE_REVISION\" = \"$EXPECTED_REVISION\" || fail\n  test \"$ACTIVE_REVISION\" = \"$EXPECTED_REVISION\" || fail\n  link_repo\n  echo REUSED \"$ACTIVE_REVISION\"\n  exit 0\nfi\n\nif [ -e \"$LOCAL_REPO\" ] || [ -L \"$LOCAL_REPO\" ]; then fail; fi\ntest -f \"$ARCHIVE\" && test ! -L \"$ARCHIVE\" || fail\ntest -f \"$DIGEST_FILE\" && test ! -L \"$DIGEST_FILE\" || fail\nIFS= read -r DIGEST_RECORD < \"$DIGEST_FILE\" || fail\ntest \"$DIGEST_RECORD\" = \"$EXPECTED_DIGEST  repo.tar\" || fail\nREPO_STAGING=$(mktemp -d /tmp/wfb-dev-repo.activate.XXXXXX) || fail\nchmod 700 \"$REPO_STAGING\"\nLOCAL_ARCHIVE=$(mktemp /tmp/wfb-dev-repo.archive.XXXXXX) || fail\nchmod 600 \"$LOCAL_ARCHIVE\"\ncp \"$ARCHIVE\" \"$LOCAL_ARCHIVE\" || fail\nACTUAL_DIGEST=$(sha256sum \"$LOCAL_ARCHIVE\") || fail\nACTUAL_DIGEST=${ACTUAL_DIGEST%% *}\ntest \"$ACTUAL_DIGEST\" = \"$EXPECTED_DIGEST\" || fail\n\ntar -C \"$REPO_STAGING\" -xf \"$LOCAL_ARCHIVE\"\ntest -d \"$REPO_STAGING/.git\" || fail\nIFS= read -r SOURCE_REVISION < \"$REPO_STAGING/.git/wfb-preview-source-revision\" || fail\nprintf '%s' \"$SOURCE_REVISION\" | grep -Eq '^[0-9a-f]{40}$' || fail\ntest \"$SOURCE_REVISION\" = \"$EXPECTED_REVISION\" || fail\nACTIVE_REVISION=$(git -C \"$REPO_STAGING\" rev-parse HEAD) || fail\ntest \"$ACTIVE_REVISION\" = \"$EXPECTED_REVISION\" || fail\ntest -z \"$(git -C \"$REPO_STAGING\" status --porcelain --untracked-files=all)\" || fail\nprintf '%s\\n' \"$EXPECTED_DIGEST\" > \"$REPO_STAGING/.git/wfb-preview-archive-sha256\"\nchmod 600 \"$REPO_STAGING/.git/wfb-preview-archive-sha256\"\nmv \"$REPO_STAGING\" \"$LOCAL_REPO\"\nlink_repo\necho ACTIVATED \"$ACTIVE_REVISION\"\nACTIVATE_REPO\n} > \"$SHARED_ACTIVATOR_TMP\"\nchmod 700 \"$SHARED_ACTIVATOR_TMP\"\nmv -f \"$SHARED_ACTIVATOR_TMP\" /sandbox/work/activate-repo.sh\ncp \"$LOCAL_REPO/scripts/dev-sync/sync.sh\" /sandbox/work/sync.sh\nchmod 700 /sandbox/work/sync.sh\nIFS= read -r SERVICES_SUMMARY < .preview-services-summary\necho ARCHIVED \"$ACTUAL_REVISION\"\necho SERVICES \"$SERVICES_SUMMARY\"\n"
const HANDOFF_PROSE = "\n\n- Your session starts in /sandbox/work. Before replying 'ready', run /sandbox/work/activate-repo.sh once, verify it reports ACTIVATED or REUSED, then cd /sandbox/work/repo. The exact checkout is pod-local behind that symlink; later turns in this same persistent pod reuse it without reactivation.\n- The per-service source mappings remain in /sandbox/work/.syncenv.d/. The full isolated system is already running. Edit any selected service in that checkout. After completing one logical edit generation, run exactly `/sandbox/work/sync.sh > /sandbox/work/sync.log 2>&1` once; it pushes that generation to every selected service and hot-reloads UI and backend processes while preserving stdout and stderr in the persistent workspace. After the command exits, inspect `/sandbox/work/sync.log` and verify an `APPLIED ...` receipt for every selected service plus the final global `SYNCED ...` line before claiming the live system was updated.\n- Never rerun the sync command merely to recover tool output that was truncated or hidden; inspect the persistent log instead. Rerun only after the log and exit status prove a real sync failure and you have diagnosed it, or after further source changes intentionally create a new logical generation.\n- The sync helper detects dependency-manifest changes and runs the cataloged dependency action. Cataloged in-pod tests are available through each service's /__run endpoint. After syncing a workflow-builder drizzle/ change, run its allowlisted migrate action before testing the live schema.\n- Run the relevant fast tests after edits, then inspect the functioning system at "

const DEFAULT_SERVICES = ['workflow-builder', 'workflow-orchestrator', 'function-router', 'mcp-gateway', 'workflow-mcp-server']
const t = args ?? {}
const services = t.services ?? (t.service ? [t.service] : DEFAULT_SERVICES)
const primary = t.service ?? services[0]
const mode = t.mode ?? 'preview-native'

phase('Provision')
const preview = await action('dev/preview', {
  "service": primary,
  "services": services,
  "mode": mode,
  "origin": t.previewOrigin,
  "timeoutSeconds": (t.keepPreview ?? 'true') === 'true' ? 86400 : 3600,
  "waitReadySeconds": 180,
  "timeoutMs": 600000,
  "activationTimeoutSeconds": 300,
  "activationPollSeconds": 2,
  "activationMaxAttempts": 151
}, { label: 'provision_preview' })

phase('Seed')
const previewsB64 = b64(JSON.stringify(preview?.services ?? [{ service: primary, ok: preview?.ready ?? false, info: preview }]))
const exportsLine = [
  `export REPOURL=${shq(t.repoUrl ?? 'PittampalliOrg/workflow-builder')}`,
  `export SOURCE_REVISION=${shq(t.sourceRevision ?? '')}`,
  `export MODE=${shq(mode)}`,
  `export PREVIEWS_B64=${shq(previewsB64)}`,
].join('; ')

await action('workspace/command', {
  cliWorkspace: true,
  workspaceRef: workspace,
  command: exportsLine + ';' + SEED_SHELL,
  cwd: "/sandbox/work",
  timeoutMs: 1500000,
}, { label: 'clone_repo' })

phase('Handoff')
const session = await action('session/spawn', {
  instructions: `You are the interactive developer for these microservices: **${services.join(', ')}**.` + HANDOFF_PROSE,
}, { label: 'handoff' })

return {
  services,
  browseUrl: t.previewOrigin ?? preview?.browseUrl ?? '',
  sessionId: session?.sessionId ?? null,
  preview,
}
