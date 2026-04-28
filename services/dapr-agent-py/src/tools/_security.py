"""Shared security validators for agent tools.

Centralizes blocked-path detection, binary-file checks, destructive-command
warnings, and path expansion used across all file and shell tools.
"""

from __future__ import annotations

import re
import os
import posixpath

# ---------------------------------------------------------------------------
# Blocked device paths (mirrors FileReadTool.ts blocked list)
# ---------------------------------------------------------------------------

BLOCKED_DEVICE_PATHS: frozenset[str] = frozenset(
    [
        "/dev/zero",
        "/dev/random",
        "/dev/urandom",
        "/dev/full",
        "/dev/stdin",
        "/dev/tty",
        "/dev/console",
        "/dev/stdout",
        "/dev/stderr",
        "/dev/fd/0",
        "/dev/fd/1",
        "/dev/fd/2",
    ]
)

_PROC_FD_RE = re.compile(r"^/proc/\d+/fd/[012]$")


def is_blocked_path(path: str) -> bool:
    """Return True if *path* points to a device or pseudo-file that should never be read."""
    normalized = posixpath.normpath(path)
    if normalized in BLOCKED_DEVICE_PATHS:
        return True
    if _PROC_FD_RE.match(normalized):
        return True
    return False


# ---------------------------------------------------------------------------
# Binary file detection
# ---------------------------------------------------------------------------

BINARY_EXTENSIONS: frozenset[str] = frozenset(
    [
        ".exe",
        ".dll",
        ".so",
        ".dylib",
        ".o",
        ".obj",
        ".a",
        ".lib",
        ".pyc",
        ".pyo",
        ".class",
        ".jar",
        ".war",
        ".ear",
        ".wasm",
        ".bin",
        ".dat",
        ".db",
        ".sqlite",
        ".sqlite3",
        ".ico",
        ".ttf",
        ".otf",
        ".woff",
        ".woff2",
        ".eot",
        ".zip",
        ".tar",
        ".gz",
        ".bz2",
        ".xz",
        ".7z",
        ".rar",
        ".iso",
        ".dmg",
        ".deb",
        ".rpm",
        ".msi",
        ".pkg",
        ".mp3",
        ".mp4",
        ".avi",
        ".mov",
        ".mkv",
        ".flac",
        ".wav",
        ".ogg",
        ".webm",
    ]
)

# Image and PDF extensions are intentionally excluded from the binary set
# so that the read tool can handle them specially if needed.
_IMAGE_EXTENSIONS: frozenset[str] = frozenset(
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".tiff", ".tif"]
)
_PDF_EXTENSION = ".pdf"


def is_binary_file(path: str) -> bool:
    """Return True if the file extension indicates a binary format."""
    suffix = posixpath.splitext(path)[1].lower()
    if suffix in _IMAGE_EXTENSIONS or suffix == _PDF_EXTENSION:
        return False
    return suffix in BINARY_EXTENSIONS


# ---------------------------------------------------------------------------
# Path expansion
# ---------------------------------------------------------------------------


def expand_path(file_path: str) -> str:
    """Expand paths relative to the current OpenShell sandbox working directory."""
    try:
        from src.openshell_runtime import get_runtime

        return get_runtime().resolve_path(file_path)
    except Exception:
        pass

    raw = os.path.expanduser(file_path)
    if raw == "~":
        raw = "/sandbox"
    elif raw.startswith("~/"):
        raw = posixpath.join("/sandbox", raw[2:])
    if posixpath.isabs(raw):
        return posixpath.normpath(raw)
    cwd = os.environ.get("OPENSHELL_CWD", "/sandbox")
    return posixpath.normpath(posixpath.join(cwd, raw))


# ---------------------------------------------------------------------------
# Destructive command detection (ported from destructiveCommandWarning.ts)
# ---------------------------------------------------------------------------

_DESTRUCTIVE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (
        re.compile(r"\bgit\s+reset\s+--hard\b"),
        "may discard uncommitted changes",
    ),
    (
        re.compile(
            r"\bgit\s+push\b[^;&|\n]*(?:--force|--force-with-lease|-f)\b"
        ),
        "may overwrite remote history",
    ),
    (
        re.compile(
            r"\bgit\s+clean\b(?![^;&|\n]*(?:-[a-zA-Z]*n|--dry-run))[^;&|\n]*-[a-zA-Z]*f"
        ),
        "may permanently delete untracked files",
    ),
    (
        re.compile(
            r"\bgit\s+checkout\s+(?:--\s+)?\.[ \t]*(?:$|[;&|\n])"
        ),
        "may discard all working tree changes",
    ),
    (
        re.compile(
            r"\bgit\s+restore\s+(?:--\s+)?\.[ \t]*(?:$|[;&|\n])"
        ),
        "may discard all working tree changes",
    ),
    (
        re.compile(r"\bgit\s+stash[ \t]+(?:drop|clear)\b"),
        "may permanently remove stashed changes",
    ),
    (
        re.compile(
            r"\bgit\s+branch\s+(?:-D[ \t]|--delete\s+--force|--force\s+--delete)\b"
        ),
        "may force-delete a branch",
    ),
    (
        re.compile(
            r"\bgit\s+(?:commit|push|merge)\b[^;&|\n]*--no-verify\b"
        ),
        "may skip safety hooks",
    ),
    (
        re.compile(r"\bgit\s+commit\b[^;&|\n]*--amend\b"),
        "may rewrite the last commit",
    ),
    (
        re.compile(
            r"(?:^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR][a-zA-Z]*f|(?:^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]"
        ),
        "may recursively force-remove files",
    ),
    (
        re.compile(r"(?:^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR]"),
        "may recursively remove files",
    ),
    (
        re.compile(r"(?:^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f"),
        "may force-remove files",
    ),
    (
        re.compile(
            r"\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b",
            re.IGNORECASE,
        ),
        "may drop or truncate database objects",
    ),
    (
        re.compile(
            r"\bDELETE\s+FROM\s+\w+[ \t]*(?:;|\"|\x27|\n|$)",
            re.IGNORECASE,
        ),
        "may delete all rows from database",
    ),
    (
        re.compile(r"\bkubectl\s+delete\b"),
        "may delete Kubernetes resources",
    ),
    (
        re.compile(r"\bterraform\s+destroy\b"),
        "may destroy Terraform infrastructure",
    ),
]


def get_destructive_warning(command: str) -> str | None:
    """Return the first matching destructive-command warning, or ``None``."""
    for pattern, warning in _DESTRUCTIVE_PATTERNS:
        if pattern.search(command):
            return warning
    return None
