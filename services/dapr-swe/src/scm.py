"""SCM provider helpers for dapr-swe workflow execution."""

from __future__ import annotations

import shlex
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import quote

import httpx

from src.dapr_runtime import get_configuration_values, get_secret_value
from src.config import (
    DAPR_CONFIG_STORE,
    DAPR_SECRETS_STORE,
    GITEA_API_URL,
    GITEA_INTERNAL_CLONE_BASE_URL,
    GITEA_TOKEN,
    GITEA_TOKEN_SECRET_NAME,
    GITEA_USERNAME,
    GITEA_USERNAME_SECRET_NAME,
)

ScmProvider = Literal["github", "gitea"]


@dataclass(frozen=True)
class ScmAuth:
    provider: ScmProvider
    username: str
    secret: str


@dataclass(frozen=True)
class CloneConfig:
    canonical_remote_url: str
    credential_url: str
    repository_username: str
    repository_token: str
    git_user_name: str
    git_user_email: str


def normalize_provider(value: Any) -> ScmProvider:
    if isinstance(value, str) and value.strip().lower() == "gitea":
        return "gitea"
    return "github"


def get_gitea_auth(
    *,
    username: str | None = None,
    secret: str | None = None,
) -> ScmAuth | None:
    runtime_config = get_configuration_values(
        DAPR_CONFIG_STORE,
        [
            "GITEA_USERNAME",
            "GITEA_API_URL",
            "GITEA_INTERNAL_CLONE_BASE_URL",
        ],
    )
    resolved_username = (
        username
        or runtime_config.get("GITEA_USERNAME")
        or get_secret_value(DAPR_SECRETS_STORE, GITEA_USERNAME_SECRET_NAME)
        or GITEA_USERNAME
        or "giteaadmin"
    ).strip()
    resolved_secret = (
        secret
        or GITEA_TOKEN
        or get_secret_value(DAPR_SECRETS_STORE, GITEA_TOKEN_SECRET_NAME)
    ).strip()
    if not resolved_secret:
        return None
    return ScmAuth(provider="gitea", username=resolved_username, secret=resolved_secret)


def build_clone_config(provider: ScmProvider, owner: str, repo: str, auth: ScmAuth) -> CloneConfig:
    if provider == "github":
        return CloneConfig(
            canonical_remote_url=f"https://github.com/{owner}/{repo}.git",
            credential_url=f"https://x-access-token:{auth.secret}@github.com/{owner}/{repo}.git",
            repository_username="x-access-token",
            repository_token=auth.secret,
            git_user_name="dapr-swe[bot]",
            git_user_email="dapr-swe[bot]@users.noreply.github.com",
        )

    runtime_config = get_configuration_values(
        DAPR_CONFIG_STORE,
        [
            "GITEA_API_URL",
            "GITEA_INTERNAL_CLONE_BASE_URL",
        ],
    )
    clone_base = (
        runtime_config.get("GITEA_INTERNAL_CLONE_BASE_URL")
        or GITEA_INTERNAL_CLONE_BASE_URL
    ).rstrip("/")
    api_base = (runtime_config.get("GITEA_API_URL") or GITEA_API_URL).rstrip("/")
    auth_prefix = f"{quote(auth.username)}:{quote(auth.secret)}@"
    return CloneConfig(
        canonical_remote_url=f"{api_base}/{owner}/{repo}.git",
        credential_url=clone_base.replace("://", f"://{auth_prefix}") + f"/{owner}/{repo}.git",
        repository_username=auth.username or "giteaadmin",
        repository_token=auth.secret,
        git_user_name=auth.username or "dapr-swe",
        git_user_email=f"{auth.username or 'dapr-swe'}@gitea.local",
    )


def remote_matches(provider: ScmProvider, current_remote: str, owner: str, repo: str) -> bool:
    normalized = current_remote.strip().lower()
    if provider == "github":
        return f"github.com/{owner.lower()}/{repo.lower()}.git" in normalized
    return f"/{owner.lower()}/{repo.lower()}.git" in normalized


def configure_git_identity_command(working_dir: str, clone: CloneConfig) -> str:
    quoted_dir = shlex.quote(working_dir)
    return (
        f"cd {quoted_dir} && "
        f"git config user.email {shlex.quote(clone.git_user_email)} && "
        f"git config user.name {shlex.quote(clone.git_user_name)}"
    )


def _gitea_api_base_url() -> str:
    return (
        get_configuration_values(DAPR_CONFIG_STORE, ["GITEA_API_URL"]).get("GITEA_API_URL")
        or GITEA_API_URL
    ).rstrip("/")


def create_repository(
    *,
    provider: ScmProvider,
    owner: str,
    repo: str,
    auth: ScmAuth,
    description: str = "",
    private: bool = False,
    default_branch: str = "main",
    auto_init: bool = True,
    gitignore_template: str = "Node",
) -> dict[str, Any]:
    if provider != "gitea":
        return {
            "status": "error",
            "error": "Greenfield repository creation is currently supported only for Gitea",
        }

    base_url = _gitea_api_base_url()
    headers = {"Authorization": f"token {auth.secret}"}
    payload = {
        "name": repo,
        "description": description,
        "private": bool(private),
        "default_branch": default_branch,
        "auto_init": bool(auto_init),
        "gitignores": gitignore_template,
        "readme": "Default",
    }

    with httpx.Client(timeout=30) as client:
        if owner.strip().lower() == auth.username.strip().lower():
            create_url = f"{base_url}/api/v1/user/repos"
        else:
            create_url = f"{base_url}/api/v1/orgs/{owner}/repos"

        response = client.post(create_url, headers=headers, json=payload)
        if response.status_code == 201:
            repo_payload = response.json()
            return {
                "status": "created",
                "repo_url": repo_payload.get("html_url", ""),
                "clone_url": repo_payload.get("clone_url", ""),
                "default_branch": repo_payload.get("default_branch", default_branch),
            }

        if response.status_code in {409, 422}:
            existing = client.get(f"{base_url}/api/v1/repos/{owner}/{repo}", headers=headers)
            if existing.status_code == 200:
                repo_payload = existing.json()
                return {
                    "status": "exists",
                    "repo_url": repo_payload.get("html_url", ""),
                    "clone_url": repo_payload.get("clone_url", ""),
                    "default_branch": repo_payload.get("default_branch", default_branch),
                }

        return {"status": "error", "error": response.text}


def build_pr_body(
    plan: dict[str, Any],
    issue_number: int,
    *,
    validation: dict[str, Any] | None = None,
) -> str:
    summary = plan.get("summary", "Automated implementation")
    steps = plan.get("steps", [])

    parts = [
        "## Summary",
        "",
        summary,
        "",
        f"Closes #{issue_number}",
        "",
    ]

    if steps:
        parts.append("## Changes")
        parts.append("")
        for step in steps:
            parts.append(f"- **{step.get('title', '')}**: {step.get('description', '')}")
        parts.append("")

    if validation:
        status = str(validation.get("status") or "skipped").strip() or "skipped"
        parts.append("## UX Validation")
        parts.append("")
        parts.append(f"- Status: {status}")
        screenshots = validation.get("screenshots")
        if isinstance(screenshots, int):
            parts.append(f"- Screenshots: {screenshots}")
        artifact_id = str(validation.get("artifactId") or "").strip()
        if artifact_id:
            parts.append(f"- Artifact: `{artifact_id}`")
        trace_ref = str(validation.get("traceAssetRef") or "").strip()
        if trace_ref:
            parts.append(f"- Trace: `{trace_ref}`")
        video_ref = str(validation.get("videoAssetRef") or "").strip()
        if video_ref:
            parts.append(f"- Video: `{video_ref}`")
        validation_error = str(validation.get("error") or "").strip()
        if validation_error:
            parts.append(f"- Error: {validation_error}")
        parts.append("")

    parts.append("---")
    parts.append("*Generated by dapr-swe*")
    return "\n".join(parts)


def build_greenfield_pr_body(
    *,
    app_name: str,
    request_summary: str,
    plan: dict[str, Any],
    review: dict[str, Any] | None = None,
    validation: dict[str, Any] | None = None,
) -> str:
    summary = plan.get("summary", f"Bootstrap a new SvelteKit app for {app_name}")
    steps = plan.get("steps", [])

    parts = [
        "## Summary",
        "",
        summary,
        "",
        f"App: `{app_name}`",
        "",
    ]

    if request_summary.strip():
        parts.append("## Request")
        parts.append("")
        parts.append(request_summary.strip())
        parts.append("")

    if steps:
        parts.append("## Bootstrap Plan")
        parts.append("")
        for step in steps:
            parts.append(f"- **{step.get('title', '')}**: {step.get('description', '')}")
        parts.append("")

    if review:
        review_status = "approved" if review.get("approved", False) else "needs follow-up"
        parts.append("## Automated Review")
        parts.append("")
        parts.append(f"- Status: {review_status}")
        feedback = str(review.get("feedback") or "").strip()
        if feedback:
            parts.append(f"- Summary: {feedback}")
        suggestions = review.get("suggestions")
        if isinstance(suggestions, list):
            for suggestion in suggestions[:5]:
                if not isinstance(suggestion, dict):
                    continue
                file_ref = str(suggestion.get("file") or "").strip()
                message = str(suggestion.get("message") or "").strip()
                severity = str(suggestion.get("severity") or "").strip()
                line = suggestion.get("line")
                label = file_ref or "repo"
                if line not in (None, ""):
                    label = f"{label}:{line}"
                detail = message or "Follow-up suggested."
                if severity:
                    parts.append(f"- {label} [{severity}]: {detail}")
                else:
                    parts.append(f"- {label}: {detail}")
        parts.append("")

    if validation:
        status = str(validation.get("status") or "skipped").strip() or "skipped"
        parts.append("## UX Validation")
        parts.append("")
        parts.append(f"- Status: {status}")
        screenshots = validation.get("screenshots")
        if isinstance(screenshots, int):
            parts.append(f"- Screenshots: {screenshots}")
        artifact_id = str(validation.get("artifactId") or "").strip()
        if artifact_id:
            parts.append(f"- Artifact: `{artifact_id}`")
        trace_ref = str(validation.get("traceAssetRef") or "").strip()
        if trace_ref:
            parts.append(f"- Trace: `{trace_ref}`")
        video_ref = str(validation.get("videoAssetRef") or "").strip()
        if video_ref:
            parts.append(f"- Video: `{video_ref}`")
        validation_error = str(validation.get("error") or "").strip()
        if validation_error:
            parts.append(f"- Error: {validation_error}")
        parts.append("")

    parts.append("---")
    parts.append("*Generated by dapr-swe*")
    return "\n".join(parts)


def create_pull_request(
    *,
    provider: ScmProvider,
    owner: str,
    repo: str,
    head_branch: str,
    base_branch: str,
    title: str,
    body: str,
    auth: ScmAuth,
    draft: bool = True,
) -> dict[str, Any]:
    with httpx.Client(timeout=30) as client:
        if provider == "github":
            response = client.post(
                f"https://api.github.com/repos/{owner}/{repo}/pulls",
                headers={
                    "Authorization": f"Bearer {auth.secret}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                json={
                    "title": title,
                    "head": head_branch,
                    "base": base_branch,
                    "body": body,
                    "draft": draft,
                },
            )
            if response.status_code == 201:
                payload = response.json()
                return {"status": "success", "pr_url": payload.get("html_url", "")}
            if response.status_code == 422:
                return {"status": "already_exists", "pr_url": "", "detail": response.text}
            return {"status": "error", "pr_url": "", "error": response.text}

        response = client.post(
            f"{(get_configuration_values(DAPR_CONFIG_STORE, ['GITEA_API_URL']).get('GITEA_API_URL') or GITEA_API_URL).rstrip('/')}/api/v1/repos/{owner}/{repo}/pulls",
            headers={"Authorization": f"token {auth.secret}"},
            json={
                "head": head_branch,
                "base": base_branch,
                "title": title,
                "body": body,
            },
        )
        if response.status_code == 201:
            payload = response.json()
            return {"status": "success", "pr_url": payload.get("html_url", "")}
        if response.status_code == 409:
            return {"status": "already_exists", "pr_url": "", "detail": response.text}
        return {"status": "error", "pr_url": "", "error": response.text}


def post_issue_comment(
    *,
    provider: ScmProvider,
    owner: str,
    repo: str,
    issue_number: int,
    body: str,
    auth: ScmAuth,
) -> None:
    with httpx.Client(timeout=30) as client:
        if provider == "github":
            response = client.post(
                f"https://api.github.com/repos/{owner}/{repo}/issues/{issue_number}/comments",
                headers={
                    "Authorization": f"Bearer {auth.secret}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                json={"body": body},
            )
        else:
            response = client.post(
                f"{_gitea_api_base_url()}/api/v1/repos/{owner}/{repo}/issues/{issue_number}/comments",
                headers={"Authorization": f"token {auth.secret}"},
                json={"body": body},
            )

    response.raise_for_status()
