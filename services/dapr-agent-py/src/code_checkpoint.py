"""Git-backed workspace checkpoints for mutating agent tools.

The checkpoint metadata is intentionally small so Dapr workflow history only
records commit references and changed-file summaries. Git stores the actual
workspace state efficiently inside the sandbox repository.
"""

from __future__ import annotations

import json
import logging
import os
from textwrap import dedent
from typing import Any
import urllib.parse
import urllib.request

from src.openshell_runtime import DEFAULT_CWD, OpenShellRuntime

logger = logging.getLogger(__name__)

MUTATING_TOOL_NAMES = {
    "bash",
    "bash_run",
    "edit",
    "edit_file",
    "multi_edit",
    "notebookedit",
    "str_replace",
    "write",
    "write_file",
}


def _dapr_configuration_values(keys: list[str]) -> dict[str, str]:
    store = os.environ.get("DAPR_CONFIG_STORE", "azureappconfig-workflow-runtime")
    host = os.environ.get("DAPR_HOST", "127.0.0.1")
    port = os.environ.get("DAPR_HTTP_PORT", "3500")
    params = "".join(f"&key={urllib.parse.quote(key)}" for key in keys)
    url = f"http://{host}:{port}/v1.0/configuration/{store}?{params.lstrip('&')}"
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:
        return {}
    values: dict[str, str] = {}
    if isinstance(payload, dict):
        for key, item in payload.items():
            if isinstance(item, dict) and isinstance(item.get("value"), str):
                values[str(key)] = str(item["value"])
    return values


def _dapr_secret_value(secret_name: str) -> str:
    if not secret_name:
        return ""
    store = os.environ.get("DAPR_SECRETS_STORE", "azure-keyvault")
    host = os.environ.get("DAPR_HOST", "127.0.0.1")
    port = os.environ.get("DAPR_HTTP_PORT", "3500")
    url = f"http://{host}:{port}/v1.0/secrets/{store}/{urllib.parse.quote(secret_name)}"
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:
        return ""
    if isinstance(payload, dict):
        direct = payload.get(secret_name)
        if isinstance(direct, str):
            return direct
        for value in payload.values():
            if isinstance(value, str):
                return value
    return ""


def should_checkpoint_tool(tool_name: str | None) -> bool:
    """Return whether a tool is likely to mutate workspace files."""
    normalized = str(tool_name or "").strip().lower().replace("-", "_")
    normalized_compact = normalized.replace("_", "")
    if normalized in MUTATING_TOOL_NAMES or normalized_compact in MUTATING_TOOL_NAMES:
        return True
    return any(token in normalized for token in ("write", "edit", "patch", "bash"))


def _fallback_checkpoint(
    *,
    runtime: OpenShellRuntime,
    execution_id: str,
    instance_id: str,
    workspace_ref: str | None,
    tool_call_id: str,
    tool_name: str,
    status: str,
    error: str | None = None,
) -> dict[str, Any]:
    sandbox_name = ""
    try:
        sandbox_name = runtime.sandbox_name
    except Exception:
        sandbox_name = ""
    return {
        "checkpointKind": "tool_mutation",
        "workflowExecutionId": execution_id,
        "daprInstanceId": instance_id,
        "workspaceRef": workspace_ref or None,
        "sandboxName": sandbox_name or None,
        "repoPath": runtime.cwd or DEFAULT_CWD,
        "toolCallId": tool_call_id,
        "sourceEventId": f"{tool_call_id}:end" if tool_call_id else None,
        "toolName": tool_name,
        "beforeSha": None,
        "afterSha": None,
        "remoteUrl": None,
        "remoteRef": None,
        "remoteStatus": "skipped",
        "remoteError": error,
        "remotePushedAt": None,
        "changedFiles": [],
        "fileCount": 0,
        "status": status,
        "error": error,
        "metadata": {"createdBy": "dapr-agent-py"},
    }


def _checkpoint_remote_config() -> dict[str, Any]:
    enabled = os.environ.get("WORKFLOW_CHECKPOINT_GIT_REMOTE_ENABLED", "true").strip().lower()
    if enabled in {"0", "false", "no", "off"}:
        return {"enabled": False, "reason": "disabled"}

    config = _dapr_configuration_values([
        "WORKFLOW_CHECKPOINT_GIT_API_URL",
        "WORKFLOW_CHECKPOINT_GIT_CLONE_BASE_URL",
        "WORKFLOW_CHECKPOINT_GIT_OWNER",
        "WORKFLOW_CHECKPOINT_GIT_REPO",
        "WORKFLOW_CHECKPOINT_GIT_USERNAME",
        "WORKFLOW_CHECKPOINT_GIT_REMOTE_URL",
        "GITEA_API_URL",
        "GITEA_INTERNAL_CLONE_BASE_URL",
        "GITEA_REPO_OWNER",
        "GITEA_USERNAME",
    ])
    token_secret_name = (
        os.environ.get("WORKFLOW_CHECKPOINT_GIT_TOKEN_SECRET_NAME")
        or os.environ.get("GITEA_TOKEN_SECRET_NAME")
        or "GITEA-TOKEN"
    ).strip()

    owner = (
        os.environ.get("WORKFLOW_CHECKPOINT_GIT_OWNER")
        or config.get("WORKFLOW_CHECKPOINT_GIT_OWNER")
        or os.environ.get("GITEA_REPO_OWNER")
        or config.get("GITEA_REPO_OWNER")
        or "giteaadmin"
    ).strip()
    repo = (
        os.environ.get("WORKFLOW_CHECKPOINT_GIT_REPO")
        or config.get("WORKFLOW_CHECKPOINT_GIT_REPO")
        or "workflow-checkpoints"
    ).strip()
    clone_base_url = (
        os.environ.get("WORKFLOW_CHECKPOINT_GIT_CLONE_BASE_URL")
        or config.get("WORKFLOW_CHECKPOINT_GIT_CLONE_BASE_URL")
        or os.environ.get("GITEA_INTERNAL_CLONE_BASE_URL")
        or config.get("GITEA_INTERNAL_CLONE_BASE_URL")
        or "http://gitea-http.gitea.svc.cluster.local:3000"
    ).strip().rstrip("/")
    api_url = (
        os.environ.get("WORKFLOW_CHECKPOINT_GIT_API_URL")
        or config.get("WORKFLOW_CHECKPOINT_GIT_API_URL")
        or os.environ.get("GITEA_API_URL")
        or config.get("GITEA_API_URL")
        or clone_base_url
    ).strip().rstrip("/")
    username = (
        os.environ.get("WORKFLOW_CHECKPOINT_GIT_USERNAME")
        or config.get("WORKFLOW_CHECKPOINT_GIT_USERNAME")
        or os.environ.get("GITEA_USERNAME")
        or config.get("GITEA_USERNAME")
        or "giteaadmin"
    ).strip()
    token = (
        os.environ.get("WORKFLOW_CHECKPOINT_GIT_TOKEN")
        or os.environ.get("GITEA_TOKEN")
        or os.environ.get("GITEA_PASSWORD")
        or _dapr_secret_value(token_secret_name)
        or _dapr_secret_value("GITEA-REGISTRY-PASSWORD")
        or ""
    ).strip()
    remote_url = (
        os.environ.get("WORKFLOW_CHECKPOINT_GIT_REMOTE_URL")
        or config.get("WORKFLOW_CHECKPOINT_GIT_REMOTE_URL")
        or (f"{clone_base_url}/{owner}/{repo}.git" if owner and repo and clone_base_url else "")
    ).strip()

    if not remote_url:
        return {"enabled": False, "reason": "remote url not configured"}

    return {
        "enabled": bool(token and username),
        "reason": "" if token and username else "remote credentials not configured",
        "apiUrl": api_url,
        "owner": owner,
        "repo": repo,
        "remoteUrl": remote_url,
        "username": username,
        "token": token,
    }


CHECKPOINT_SCRIPT = dedent(
    r"""
    import json
    import os
    import pathlib
    import subprocess
    import sys
    import time
    import urllib.error
    import urllib.parse
    import urllib.request
    from datetime import datetime, timezone

    payload = json.loads(sys.stdin.read() or "{}")
    repo = pathlib.Path(payload.get("repoPath") or "/sandbox").resolve()
    repo.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("GIT_SSL_NO_VERIFY", "true")

    def add_no_proxy_hosts():
        hosts = [
            "gitea-http",
            "gitea-http.gitea",
            "gitea-http.gitea.svc",
            "gitea-http.gitea.svc.cluster.local",
            ".svc",
            ".svc.cluster.local",
        ]
        existing = []
        for key in ("no_proxy", "NO_PROXY"):
            existing.extend(
                part.strip()
                for part in os.environ.get(key, "").split(",")
                if part.strip()
            )
        merged = []
        seen = set()
        for item in [*existing, *hosts]:
            if item not in seen:
                seen.add(item)
                merged.append(item)
        value = ",".join(merged)
        os.environ["no_proxy"] = value
        os.environ["NO_PROXY"] = value

    add_no_proxy_hosts()

    def run(args, check=False, timeout=30):
        proc = subprocess.run(
            args,
            cwd=str(repo),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
        if check and proc.returncode != 0:
            raise RuntimeError((proc.stderr or proc.stdout or f"{args[0]} failed").strip())
        return proc

    def emit(extra):
        result = {
            "checkpointKind": "tool_mutation",
            "workflowExecutionId": payload.get("executionId"),
            "daprInstanceId": payload.get("instanceId"),
            "workspaceRef": payload.get("workspaceRef") or None,
            "sandboxName": payload.get("sandboxName") or None,
            "repoPath": str(repo),
            "toolCallId": payload.get("toolCallId") or None,
            "sourceEventId": f"{payload.get('toolCallId')}:end" if payload.get("toolCallId") else None,
            "toolName": payload.get("toolName") or "unknown",
            "metadata": {
                "createdBy": "dapr-agent-py",
                "gitRef": (
                    f"refs/workflow-builder/checkpoints/{payload.get('executionId')}/{payload.get('toolCallId')}"
                    if payload.get("executionId") and payload.get("toolCallId")
                    else None
                ),
            },
        }
        result.update(extra)
        print(json.dumps(result))

    def basic_auth_header(username, token):
        import base64
        raw = f"{username}:{token}".encode("utf-8")
        return "Basic " + base64.b64encode(raw).decode("ascii")

    def http_request(url, method="GET", body=None, auth=None):
        headers = {}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        if auth:
            headers["Authorization"] = basic_auth_header(auth["username"], auth["token"])
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            for attempt in range(5):
                try:
                    with urllib.request.urlopen(req, timeout=10) as response:
                        return response.status, response.read().decode("utf-8", errors="replace")
                except urllib.error.HTTPError:
                    raise
                except urllib.error.URLError as exc:
                    if attempt == 4:
                        raise
                    time.sleep(0.5 * (attempt + 1))
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read().decode("utf-8", errors="replace")

    def transient_git_error(text):
        lowered = str(text or "").lower()
        return any(
            marker in lowered
            for marker in (
                "temporary failure in name resolution",
                "could not resolve host",
                "failed to connect",
                "connection timed out",
                "connection reset",
                "tls handshake timeout",
            )
        )

    def authed_git_url(url, username, token):
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            return url
        user = urllib.parse.quote(username, safe="")
        password = urllib.parse.quote(token, safe="")
        return urllib.parse.urlunparse(parsed._replace(netloc=f"{user}:{password}@{parsed.netloc}"))

    def ensure_remote_repo(remote):
        if not remote.get("apiUrl") or not remote.get("owner") or not remote.get("repo"):
            return
        auth = {"username": remote.get("username") or "", "token": remote.get("token") or ""}
        if not auth["username"] or not auth["token"]:
            return
        base = str(remote["apiUrl"]).rstrip("/")
        owner = urllib.parse.quote(str(remote["owner"]), safe="")
        repo_name = urllib.parse.quote(str(remote["repo"]), safe="")
        status, body = http_request(f"{base}/api/v1/repos/{owner}/{repo_name}", auth=auth)
        if status == 200:
            return
        if status != 404:
            raise RuntimeError(f"Gitea repo lookup failed ({status}): {body[:300]}")
        create_path = (
            f"{base}/api/v1/user/repos"
            if remote.get("owner") == remote.get("username")
            else f"{base}/api/v1/orgs/{owner}/repos"
        )
        status, body = http_request(
            create_path,
            method="POST",
            auth=auth,
            body={
                "name": remote["repo"],
                "private": True,
                "auto_init": False,
                "description": "Workflow Builder durable agent code checkpoints",
            },
        )
        if status not in {201, 409}:
            raise RuntimeError(f"Gitea repo create failed ({status}): {body[:300]}")

    def push_checkpoint_ref(remote, remote_ref, after_sha):
        if not remote.get("enabled"):
            return {
                "remoteStatus": "skipped",
                "remoteError": remote.get("reason") or "remote disabled",
                "remoteUrl": remote.get("remoteUrl") or None,
                "remoteRef": remote_ref,
                "remotePushedAt": None,
            }
        ensure_remote_repo(remote)
        remote_name = "workflow-builder-checkpoints"
        existing = run(["git", "remote", "get-url", remote_name], timeout=10)
        if existing.returncode == 0:
            run(["git", "remote", "set-url", remote_name, remote["remoteUrl"]], check=True, timeout=10)
        else:
            run(["git", "remote", "add", remote_name, remote["remoteUrl"]], check=True, timeout=10)
        push_args = [
            "git",
            "-c",
            f"http.extraHeader=Authorization: {basic_auth_header(remote['username'], remote['token'])}",
            "push",
            remote_name,
            f"{after_sha}:{remote_ref}",
        ]
        push = None
        for attempt in range(5):
            push = run(push_args, timeout=90)
            if push.returncode == 0 or not transient_git_error(push.stderr or push.stdout):
                break
            time.sleep(0.75 * (attempt + 1))
        if push.returncode != 0:
            raise RuntimeError((push.stderr or push.stdout or "git push failed").strip()[:1000])
        return {
            "remoteStatus": "pushed",
            "remoteError": None,
            "remoteUrl": remote["remoteUrl"],
            "remoteRef": remote_ref,
            "remotePushedAt": datetime.now(timezone.utc).isoformat(),
        }

    try:
        run(["git", "--version"], check=True, timeout=10)
    except Exception as exc:
        emit({
            "status": "skipped",
            "error": f"git unavailable: {exc}",
            "beforeSha": None,
            "afterSha": None,
            "changedFiles": [],
            "fileCount": 0,
        })
        raise SystemExit(0)

    try:
        inside = run(["git", "rev-parse", "--is-inside-work-tree"], timeout=10)
        if inside.returncode != 0 or inside.stdout.strip() != "true":
            run(["git", "init"], check=True, timeout=20)

        run(["git", "config", "user.email", "workflow-builder-checkpoints@local"], timeout=10)
        run(["git", "config", "user.name", "Workflow Builder Checkpoints"], timeout=10)

        info_dir = repo / ".git" / "info"
        info_dir.mkdir(parents=True, exist_ok=True)
        exclude_path = info_dir / "exclude"
        excludes = [
            "node_modules/",
            ".svelte-kit/",
            ".next/",
            "dist/",
            "build/",
            "coverage/",
            ".pnpm-store/",
            ".cache/",
            "playwright-report/",
            "test-results/",
            "*.log",
        ]
        existing_excludes = exclude_path.read_text(encoding="utf-8", errors="ignore") if exclude_path.exists() else ""
        with exclude_path.open("a", encoding="utf-8") as handle:
            for pattern in excludes:
                if pattern not in existing_excludes:
                    handle.write(f"\n{pattern}")

        head = run(["git", "rev-parse", "--verify", "HEAD"], timeout=10)
        if head.returncode != 0:
            run(["git", "commit", "--allow-empty", "-m", "checkpoint: initial empty workspace"], check=True, timeout=20)

        before = run(["git", "rev-parse", "HEAD"], check=True, timeout=10).stdout.strip()
        status = run(["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"], timeout=20)
        if not status.stdout:
            emit({
                "status": "no_changes",
                "beforeSha": before,
                "afterSha": before,
                "remoteUrl": None,
                "remoteRef": None,
                "remoteStatus": "skipped",
                "remoteError": "no changes",
                "remotePushedAt": None,
                "changedFiles": [],
                "fileCount": 0,
            })
            raise SystemExit(0)

        run(["git", "add", "-A"], check=True, timeout=60)
        staged = run(["git", "diff", "--cached", "--quiet"], timeout=30)
        if staged.returncode == 0:
            emit({
                "status": "no_changes",
                "beforeSha": before,
                "afterSha": before,
                "remoteUrl": None,
                "remoteRef": None,
                "remoteStatus": "skipped",
                "remoteError": "no staged changes",
                "remotePushedAt": None,
                "changedFiles": [],
                "fileCount": 0,
            })
            raise SystemExit(0)

        tool_name = str(payload.get("toolName") or "tool").strip()[:80]
        tool_call_id = str(payload.get("toolCallId") or "").strip()[:80]
        message = f"checkpoint: {tool_name} {tool_call_id}".strip()
        run(["git", "commit", "-m", message], check=True, timeout=60)
        after = run(["git", "rev-parse", "HEAD"], check=True, timeout=10).stdout.strip()

        files = []
        name_status = run(["git", "diff", "--name-status", "--find-renames", before, after], timeout=30).stdout
        numstat = run(["git", "diff", "--numstat", before, after], timeout=30).stdout
        stats_by_path = {}
        for line in numstat.splitlines():
            parts = line.split("\t")
            if len(parts) >= 3:
                path = parts[-1]
                additions = None if parts[0] == "-" else int(parts[0])
                deletions = None if parts[1] == "-" else int(parts[1])
                stats_by_path[path] = {
                    "additions": additions,
                    "deletions": deletions,
                    "binary": parts[0] == "-" or parts[1] == "-",
                }
        for line in name_status.splitlines():
            parts = line.split("\t")
            if not parts:
                continue
            status_code = parts[0]
            if status_code.startswith("R") and len(parts) >= 3:
                previous_path = parts[1]
                path = parts[2]
            else:
                previous_path = None
                path = parts[-1] if len(parts) >= 2 else ""
            if not path:
                continue
            item = {
                "path": path,
                "status": status_code,
                "previousPath": previous_path,
            }
            item.update(stats_by_path.get(path, {}))
            files.append(item)

        ref_name = None
        if payload.get("executionId") and payload.get("toolCallId"):
            ref_name = f"refs/workflow-builder/checkpoints/{payload['executionId']}/{payload['toolCallId']}"
            run(["git", "update-ref", ref_name, after], timeout=10)

        try:
            run(["git", "gc", "--auto"], timeout=5)
        except Exception:
            pass

        remote_result = {
            "remoteStatus": "skipped",
            "remoteError": "remote ref unavailable",
            "remoteUrl": None,
            "remoteRef": ref_name,
            "remotePushedAt": None,
        }
        if ref_name:
            try:
                remote_result = push_checkpoint_ref(payload.get("remote") or {}, ref_name, after)
            except Exception as remote_exc:
                remote = payload.get("remote") or {}
                remote_result = {
                    "remoteStatus": "error",
                    "remoteError": str(remote_exc)[:1000],
                    "remoteUrl": remote.get("remoteUrl") or None,
                    "remoteRef": ref_name,
                    "remotePushedAt": None,
                }

        emit({
            "status": "created",
            "beforeSha": before,
            "afterSha": after,
            **remote_result,
            "changedFiles": files,
            "fileCount": len(files),
        })
    except Exception as exc:
        emit({
            "status": "error",
            "error": str(exc)[:1000],
            "beforeSha": None,
            "afterSha": None,
            "remoteUrl": None,
            "remoteRef": None,
            "remoteStatus": "error",
            "remoteError": str(exc)[:1000],
            "remotePushedAt": None,
            "changedFiles": [],
            "fileCount": 0,
        })
    """
).strip()


RESTORE_SCRIPT = dedent(
    r"""
    import json
    import os
    import pathlib
    import subprocess
    import sys

    payload = json.loads(sys.stdin.read() or "{}")
    restore = payload.get("restore") if isinstance(payload.get("restore"), dict) else {}
    remote = payload.get("remote") if isinstance(payload.get("remote"), dict) else {}
    repo = pathlib.Path(restore.get("repoPath") or payload.get("repoPath") or "/sandbox").resolve()
    repo.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("GIT_SSL_NO_VERIFY", "true")

    def add_no_proxy_hosts():
        hosts = [
            "gitea-http",
            "gitea-http.gitea",
            "gitea-http.gitea.svc",
            "gitea-http.gitea.svc.cluster.local",
            ".svc",
            ".svc.cluster.local",
        ]
        existing = []
        for key in ("no_proxy", "NO_PROXY"):
            existing.extend(
                part.strip()
                for part in os.environ.get(key, "").split(",")
                if part.strip()
            )
        merged = []
        seen = set()
        for item in [*existing, *hosts]:
            if item not in seen:
                seen.add(item)
                merged.append(item)
        value = ",".join(merged)
        os.environ["no_proxy"] = value
        os.environ["NO_PROXY"] = value

    add_no_proxy_hosts()

    def run(args, timeout=60):
        return subprocess.run(
            args,
            cwd=str(repo),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )

    def emit(extra):
        result = {
            "ok": False,
            "repoPath": str(repo),
            "checkpointId": restore.get("checkpointId"),
            "afterSha": restore.get("afterSha"),
            "remoteRef": restore.get("remoteRef"),
        }
        result.update(extra)
        print(json.dumps(result))

    def basic_auth_header(username, token):
        import base64
        raw = f"{username}:{token}".encode("utf-8")
        return "Authorization: Basic " + base64.b64encode(raw).decode("ascii")

    remote_url = str(restore.get("remoteUrl") or "").strip()
    remote_ref = str(restore.get("remoteRef") or "").strip()
    after_sha = str(restore.get("afterSha") or "").strip()
    username = str(remote.get("username") or "").strip()
    token = str(remote.get("token") or "").strip()
    if not remote_url or not remote_ref or not after_sha:
        emit({"ok": False, "error": "remoteUrl, remoteRef, and afterSha are required"})
        raise SystemExit(0)

    run(["git", "init", "-q"], timeout=20)
    run(["git", "remote", "remove", "workflow-builder-checkpoints"], timeout=10)
    add = run(["git", "remote", "add", "workflow-builder-checkpoints", remote_url], timeout=10)
    if add.returncode != 0:
        emit({"ok": False, "error": (add.stderr or add.stdout or "git remote add failed")[:1000]})
        raise SystemExit(0)

    fetch_args = ["git"]
    if username and token:
        fetch_args.extend(["-c", f"http.extraHeader={basic_auth_header(username, token)}"])
    fetch_args.extend(["fetch", "--depth=2", "workflow-builder-checkpoints", remote_ref])
    fetch = run(fetch_args, timeout=120)
    if fetch.returncode != 0:
        emit({"ok": False, "error": (fetch.stderr or fetch.stdout or "git fetch failed")[:1000]})
        raise SystemExit(0)

    reset = run(["git", "reset", "--hard", after_sha], timeout=60)
    if reset.returncode != 0:
        emit({"ok": False, "error": (reset.stderr or reset.stdout or "git reset failed")[:1000]})
        raise SystemExit(0)
    clean = run(["git", "clean", "-fdx"], timeout=60)
    if clean.returncode != 0:
        emit({"ok": False, "error": (clean.stderr or clean.stdout or "git clean failed")[:1000]})
        raise SystemExit(0)
    status = run(["git", "status", "--short"], timeout=10)
    emit({
        "ok": True,
        "status": status.stdout,
        "message": f"Restored {after_sha[:8]} from {remote_ref}",
    })
    """
).strip()


def capture_code_checkpoint(
    runtime: OpenShellRuntime,
    *,
    execution_id: str,
    instance_id: str,
    workspace_ref: str | None,
    tool_call_id: str,
    tool_name: str,
) -> dict[str, Any]:
    """Create a sandbox-local Git checkpoint and return compact metadata."""
    if not tool_call_id:
        return _fallback_checkpoint(
            runtime=runtime,
            execution_id=execution_id,
            instance_id=instance_id,
            workspace_ref=workspace_ref,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            status="skipped",
            error="missing tool_call_id",
        )

    try:
        sandbox_name = runtime.sandbox_name
    except Exception as exc:
        return _fallback_checkpoint(
            runtime=runtime,
            execution_id=execution_id,
            instance_id=instance_id,
            workspace_ref=workspace_ref,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            status="skipped",
            error=f"sandbox unavailable: {exc}",
        )

    payload = {
        "executionId": execution_id,
        "instanceId": instance_id,
        "workspaceRef": workspace_ref or None,
        "sandboxName": sandbox_name,
        "repoPath": runtime.cwd or DEFAULT_CWD,
        "toolCallId": tool_call_id,
        "toolName": tool_name,
        "remote": _checkpoint_remote_config(),
    }
    try:
        result = runtime.run_python(CHECKPOINT_SCRIPT, payload, timeout_seconds=120)
    except Exception as exc:
        logger.warning("[checkpoint] failed to execute checkpoint script: %s", exc)
        return _fallback_checkpoint(
            runtime=runtime,
            execution_id=execution_id,
            instance_id=instance_id,
            workspace_ref=workspace_ref,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            status="error",
            error=str(exc)[:1000],
        )

    output = str(result.get("stdout") or result.get("output") or "").strip()
    if not output:
        return _fallback_checkpoint(
            runtime=runtime,
            execution_id=execution_id,
            instance_id=instance_id,
            workspace_ref=workspace_ref,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            status="error",
            error=str(result.get("stderr") or "checkpoint produced no output")[:1000],
        )
    try:
        last_line = output.splitlines()[-1]
        parsed = json.loads(last_line)
    except Exception as exc:
        logger.warning("[checkpoint] invalid checkpoint output: %s", output[-500:])
        return _fallback_checkpoint(
            runtime=runtime,
            execution_id=execution_id,
            instance_id=instance_id,
            workspace_ref=workspace_ref,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            status="error",
            error=f"invalid checkpoint output: {exc}",
        )
    return parsed if isinstance(parsed, dict) else _fallback_checkpoint(
        runtime=runtime,
        execution_id=execution_id,
        instance_id=instance_id,
        workspace_ref=workspace_ref,
        tool_call_id=tool_call_id,
        tool_name=tool_name,
        status="error",
        error="checkpoint output was not an object",
    )


def restore_code_checkpoint(
    runtime: OpenShellRuntime,
    restore: dict[str, Any] | None,
) -> dict[str, Any]:
    """Restore a durable code checkpoint into the active sandbox workspace."""
    if not isinstance(restore, dict) or not restore:
        return {"ok": True, "skipped": True, "message": "no restore requested"}
    remote = _checkpoint_remote_config()
    payload = {
        "repoPath": restore.get("repoPath") or runtime.cwd or DEFAULT_CWD,
        "restore": restore,
        "remote": remote,
    }
    try:
        result = runtime.run_python(RESTORE_SCRIPT, payload, timeout_seconds=180)
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:1000]}
    output = str(result.get("stdout") or result.get("output") or "").strip()
    if not output:
        return {
            "ok": False,
            "error": str(result.get("stderr") or "restore produced no output")[:1000],
        }
    try:
        parsed = json.loads(output.splitlines()[-1])
    except Exception as exc:
        return {"ok": False, "error": f"invalid restore output: {exc}"}
    return parsed if isinstance(parsed, dict) else {"ok": False, "error": "restore output was not an object"}
