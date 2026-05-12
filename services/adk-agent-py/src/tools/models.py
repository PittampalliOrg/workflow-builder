from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from pydantic import BaseModel, Field


@dataclass(frozen=True)
class ToolEntry:
    name: str
    source_hint: str
    responsibility: str


class FindToolsSchema(BaseModel):
    query: str = Field(description="Keyword to search for in tool names and source hints")
    limit: int = Field(default=20, ge=1, le=100, description="Maximum number of results to return")


class ShowToolSchema(BaseModel):
    name: str = Field(description="Exact name of the tool to look up (case-insensitive)")


class ExecuteToolSchema(BaseModel):
    name: str = Field(description="Exact name of the mirrored tool to execute")
    payload: str = Field(default="", description="Payload string to pass to the tool")


class RenderToolIndexSchema(BaseModel):
    limit: int = Field(default=20, ge=1, le=200, description="Maximum number of tools to list")
    query: Optional[str] = Field(default=None, description="Optional keyword to filter the listing")


class RoutePromptSchema(BaseModel):
    prompt: str = Field(description="Natural-language prompt to route to matching tools")
    limit: int = Field(default=5, ge=1, le=20, description="Maximum number of matched tools to return")
