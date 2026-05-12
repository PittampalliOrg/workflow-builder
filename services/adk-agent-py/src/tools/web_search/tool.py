"""WebSearch tool -- web search via DuckDuckGo or configurable API."""

from __future__ import annotations

import os

_MAX_RESULTS = 10


def web_search(
    query: str,
    allowed_domains: list[str] | None = None,
    blocked_domains: list[str] | None = None,
) -> str:
    """Search the web for information. Optionally filter by allowed or blocked domains."""
    if not query or len(query.strip()) < 2:
        return "Error: Query must be at least 2 characters."

    if allowed_domains and blocked_domains:
        return "Error: Cannot specify both allowed_domains and blocked_domains."

    query = query.strip()

    # Apply domain filters to query
    search_query = query
    if allowed_domains:
        site_filter = " OR ".join(f"site:{d}" for d in allowed_domains)
        search_query = f"{query} ({site_filter})"

    # Try DuckDuckGo search (no API key needed)
    try:
        return _search_duckduckgo(search_query, blocked_domains)
    except ImportError:
        pass
    except Exception as exc:
        # Fall through to other backends
        ddg_error = str(exc)

    # Try SerpAPI if configured
    serpapi_key = os.environ.get("SERPAPI_API_KEY")
    if serpapi_key:
        try:
            return _search_serpapi(search_query, serpapi_key, blocked_domains)
        except Exception as exc:
            return f"Error: SerpAPI search failed: {exc}"

    # Try Tavily if configured
    tavily_key = os.environ.get("TAVILY_API_KEY")
    if tavily_key:
        try:
            return _search_tavily(search_query, tavily_key, blocked_domains)
        except Exception as exc:
            return f"Error: Tavily search failed: {exc}"

    return (
        "Error: No search backend available. Install 'duckduckgo-search' package "
        "or set SERPAPI_API_KEY or TAVILY_API_KEY environment variable."
    )


def _search_duckduckgo(
    query: str, blocked_domains: list[str] | None
) -> str:
    # Try the new 'ddgs' package first, fall back to legacy 'duckduckgo_search'
    try:
        from ddgs import DDGS
    except ImportError:
        from duckduckgo_search import DDGS

    ddgs = DDGS()
    raw_results = list(ddgs.text(query, max_results=_MAX_RESULTS))

    if not raw_results:
        return "No results found."

    results = _filter_domains(raw_results, blocked_domains)
    return _format_results(results)


def _search_serpapi(
    query: str, api_key: str, blocked_domains: list[str] | None
) -> str:
    import json
    import urllib.request

    params = urllib.parse.urlencode({"q": query, "api_key": api_key, "engine": "google"})
    import urllib.parse

    url = f"https://serpapi.com/search?{params}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read())

    organic = data.get("organic_results", [])
    results = [
        {"title": r.get("title", ""), "href": r.get("link", ""), "body": r.get("snippet", "")}
        for r in organic[:_MAX_RESULTS]
    ]
    results = _filter_domains(results, blocked_domains)
    return _format_results(results)


def _search_tavily(
    query: str, api_key: str, blocked_domains: list[str] | None
) -> str:
    import json
    import urllib.request

    payload = json.dumps({"query": query, "max_results": _MAX_RESULTS}).encode()
    req = urllib.request.Request(
        "https://api.tavily.com/search",
        data=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read())

    raw = data.get("results", [])
    results = [
        {"title": r.get("title", ""), "href": r.get("url", ""), "body": r.get("content", "")}
        for r in raw[:_MAX_RESULTS]
    ]
    results = _filter_domains(results, blocked_domains)
    return _format_results(results)


def _filter_domains(
    results: list[dict], blocked_domains: list[str] | None
) -> list[dict]:
    if not blocked_domains:
        return results
    blocked_set = {d.lower() for d in blocked_domains}
    filtered = []
    for r in results:
        href = r.get("href", "")
        try:
            from urllib.parse import urlparse

            domain = urlparse(href).netloc.lower()
            if not any(domain == bd or domain.endswith(f".{bd}") for bd in blocked_set):
                filtered.append(r)
        except Exception:
            filtered.append(r)
    return filtered


def _format_results(results: list[dict]) -> str:
    if not results:
        return "No results found."

    lines: list[str] = []
    for r in results:
        lines.append(f"Title: {r.get('title', 'N/A')}")
        lines.append(f"URL: {r.get('href', 'N/A')}")
        body = r.get("body", "").strip()
        if body:
            lines.append(f"Snippet: {body}")
        lines.append("---")

    return "\n".join(lines)

from .prompt import get_web_search_description
web_search.__doc__ = get_web_search_description()
