"""Prompt and constants for the WebSearch tool.

Ported from claude-code-src/main/tools/WebSearchTool/prompt.ts
"""

WEB_SEARCH_TOOL_NAME = "web_search"


def get_web_search_description() -> str:
    return """- Allows you to search the web and use the results to inform responses
- Provides up-to-date information for current events and recent data
- Returns search result information formatted as search result blocks, including links as markdown hyperlinks
- Use this tool for accessing information beyond your knowledge cutoff

CRITICAL REQUIREMENT - You MUST follow this:
  - After answering the user's question, you MUST include a "Sources:" section at the end of your response
  - In the Sources section, list all relevant URLs from the search results as markdown hyperlinks: [Title](URL)
  - This is MANDATORY - never skip including sources in your response

Usage notes:
  - Domain filtering is supported to include or block specific websites via allowed_domains and blocked_domains parameters"""
