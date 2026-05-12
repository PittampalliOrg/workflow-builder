"""Prompt and constants for the WebFetch tool.

Ported from claude-code-src/main/tools/WebFetchTool/prompt.ts
"""

WEB_FETCH_TOOL_NAME = "web_fetch"


def get_web_fetch_description() -> str:
    return """- Fetches content from a specified URL and processes it
- Takes a URL and a prompt as input
- Fetches the URL content, converts HTML to markdown
- Returns the processed content
- Use this tool when you need to retrieve and analyze web content

Usage notes:
  - The URL must be a fully-formed valid URL
  - HTTP URLs will be automatically upgraded to HTTPS
  - The prompt should describe what information you want to extract from the page
  - This tool is read-only and does not modify any files
  - Results may be summarized if the content is very large
  - For GitHub URLs, prefer using the gh CLI via bash_run instead (e.g., gh pr view, gh issue view, gh api)."""
