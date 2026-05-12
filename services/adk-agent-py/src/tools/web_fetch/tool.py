"""WebFetch tool -- fetch URL content and convert HTML to markdown."""

from __future__ import annotations

import urllib.error
import urllib.request

_MAX_CONTENT_SIZE = 100_000  # 100 KB text limit
_REQUEST_TIMEOUT = 30  # seconds

_USER_AGENT = (
    "Mozilla/5.0 (compatible; DaprAgent/1.0; +https://dapr.io)"
)


def web_fetch(url: str, prompt: str = "Extract the main content") -> str:
    """Fetch content from a URL and convert HTML to markdown. Use the prompt parameter to focus on specific content."""
    if not url or not url.strip():
        return "Error: No URL provided."

    url = url.strip()
    if not url.startswith(("http://", "https://")):
        return "Error: URL must start with http:// or https://"

    req = urllib.request.Request(
        url,
        headers={"User-Agent": _USER_AGENT},
    )

    try:
        with urllib.request.urlopen(req, timeout=_REQUEST_TIMEOUT) as resp:
            status = resp.status
            content_type = resp.headers.get("Content-Type", "")
            raw_bytes = resp.read(_MAX_CONTENT_SIZE + 1)
    except urllib.error.HTTPError as exc:
        return f"Error: HTTP {exc.code} {exc.reason} fetching {url}"
    except urllib.error.URLError as exc:
        return f"Error: Could not reach {url}: {exc.reason}"
    except TimeoutError:
        return f"Error: Request timed out after {_REQUEST_TIMEOUT}s fetching {url}"
    except Exception as exc:
        return f"Error fetching URL: {exc}"

    truncated = len(raw_bytes) > _MAX_CONTENT_SIZE
    raw_bytes = raw_bytes[:_MAX_CONTENT_SIZE]

    # Decode content
    encoding = "utf-8"
    if "charset=" in content_type:
        for part in content_type.split(";"):
            part = part.strip()
            if part.startswith("charset="):
                encoding = part.split("=", 1)[1].strip().strip('"')
                break

    try:
        text = raw_bytes.decode(encoding, errors="replace")
    except (LookupError, UnicodeDecodeError):
        text = raw_bytes.decode("utf-8", errors="replace")

    # Convert HTML to markdown if applicable
    is_html = "html" in content_type.lower() or text.strip().startswith(("<!DOCTYPE", "<html", "<!doctype"))
    if is_html:
        text = _html_to_markdown(text)

    # Build result
    parts = [f"URL: {url}", f"Status: {status}"]
    if truncated:
        parts.append("(Content truncated to 100KB)")
    parts.append("")
    parts.append(text)

    return "\n".join(parts)


def _html_to_markdown(html: str) -> str:
    """Convert HTML to markdown, using markdownify if available, else basic stripping."""
    try:
        from markdownify import markdownify as md

        return md(html, heading_style="ATX", strip=["script", "style", "nav", "footer", "header"])
    except ImportError:
        pass

    # Fallback: basic tag stripping
    import re

    # Remove script and style blocks
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", html, flags=re.DOTALL | re.IGNORECASE)
    # Remove HTML tags
    text = re.sub(r"<[^>]+>", "", text)
    # Collapse whitespace
    text = re.sub(r"\n\s*\n", "\n\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    # Decode common HTML entities
    text = (
        text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
    )
    return text.strip()

from .prompt import get_web_fetch_description
web_fetch.__doc__ = get_web_fetch_description()
