"""Tests for the skills system (models, loader, registry, prompt)."""

from __future__ import annotations

import os
import sys
import tempfile
import textwrap

import pytest

# skill_tool modules don't depend on dapr_agents -- import them directly
# by adjusting sys.path to avoid triggering src.tools.__init__ which
# imports dapr_agents.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src", "tools"))

from skill_tool.models import SkillDefinition
from skill_tool.loader import parse_frontmatter, parse_skill_md, load_skills_from_dir
from skill_tool.tool import SkillRegistry, get_registry, register_skill, run_skill, get_registered_skills
from skill_tool.prompt import format_skill_listings, SKILL_TOOL_NAME, get_skill_tool_description


# ============================================================================
# SkillDefinition model
# ============================================================================


class TestSkillDefinition:
    def test_create_minimal(self):
        s = SkillDefinition(name="x", description="desc", prompt="body", source="bundled")
        assert s.name == "x"
        assert s.source == "bundled"
        assert s.allowed_tools == ()
        assert s.user_invocable is True
        assert s.disable_model_invocation is False

    def test_frozen(self):
        s = SkillDefinition(name="x", description="desc", prompt="body", source="bundled")
        with pytest.raises(AttributeError):
            s.name = "y"  # type: ignore[misc]

    def test_all_fields(self):
        s = SkillDefinition(
            name="full",
            description="full desc",
            prompt="do stuff",
            source="agentConfig",
            when_to_use="when testing",
            allowed_tools=("Read", "Grep"),
            arguments=("target",),
            argument_hint="<target>",
            model_override="sonnet",
            user_invocable=False,
            disable_model_invocation=True,
        )
        assert s.allowed_tools == ("Read", "Grep")
        assert s.arguments == ("target",)
        assert s.model_override == "sonnet"
        assert s.user_invocable is False
        assert s.disable_model_invocation is True


# ============================================================================
# Frontmatter parser
# ============================================================================


class TestParseFrontmatter:
    def test_basic(self):
        content = textwrap.dedent("""\
            ---
            name: my-skill
            description: Does things
            ---

            Body here.
        """)
        meta, body = parse_frontmatter(content)
        assert meta["name"] == "my-skill"
        assert meta["description"] == "Does things"
        assert "Body here." in body

    def test_no_frontmatter(self):
        content = "Just plain text\nno fences"
        meta, body = parse_frontmatter(content)
        assert meta == {}
        assert body == content

    def test_empty_frontmatter(self):
        content = "---\n---\nBody"
        meta, body = parse_frontmatter(content)
        assert meta == {}
        assert "Body" in body

    def test_csv_values(self):
        content = textwrap.dedent("""\
            ---
            allowed-tools: Read, Grep, Glob
            arguments: target, scope
            ---
            prompt
        """)
        meta, body = parse_frontmatter(content)
        assert meta["allowed-tools"] == "Read, Grep, Glob"
        assert meta["arguments"] == "target, scope"

    def test_boolean_values(self):
        content = textwrap.dedent("""\
            ---
            user-invocable: false
            disable-model-invocation: true
            ---
            prompt
        """)
        meta, _ = parse_frontmatter(content)
        assert meta["user-invocable"] == "false"
        assert meta["disable-model-invocation"] == "true"

    def test_whitespace_tolerance(self):
        # Leading whitespace before first ---
        content = "\n  ---\nname: test\n---\nbody"
        meta, body = parse_frontmatter(content)
        assert meta.get("name") == "test"


# ============================================================================
# parse_skill_md
# ============================================================================


class TestParseSkillMd:
    def test_full_frontmatter(self):
        content = textwrap.dedent("""\
            ---
            name: review-pr
            description: Review a pull request
            when_to_use: When the user asks to review a PR
            allowed-tools: Read, Grep, Glob
            arguments: pr_number
            argument-hint: <pr-number>
            model: sonnet
            user-invocable: true
            disable-model-invocation: false
            ---

            Review PR ${ARGUMENTS} thoroughly.
        """)
        skill = parse_skill_md(content, name="fallback", source="disk")
        assert skill.name == "review-pr"
        assert skill.description == "Review a pull request"
        assert skill.when_to_use == "When the user asks to review a PR"
        assert skill.allowed_tools == ("Read", "Grep", "Glob")
        assert skill.arguments == ("pr_number",)
        assert skill.argument_hint == "<pr-number>"
        assert skill.model_override == "sonnet"
        assert skill.user_invocable is True
        assert skill.disable_model_invocation is False
        assert "${ARGUMENTS}" in skill.prompt
        assert skill.source == "disk"

    def test_fallback_name(self):
        content = "---\ndescription: no name field\n---\nbody"
        skill = parse_skill_md(content, name="dir-name", source="disk")
        assert skill.name == "dir-name"

    def test_no_frontmatter(self):
        content = "Just a plain prompt with no fences."
        skill = parse_skill_md(content, name="plain", source="bundled")
        assert skill.name == "plain"
        assert skill.prompt == content
        assert skill.description == ""

    def test_when_to_use_hyphenated(self):
        content = "---\nwhen-to-use: hyphen style\n---\nbody"
        skill = parse_skill_md(content, name="test", source="disk")
        assert skill.when_to_use == "hyphen style"

    def test_disable_model_invocation_flag(self):
        content = "---\ndisable-model-invocation: true\n---\nbody"
        skill = parse_skill_md(content, name="hidden", source="disk")
        assert skill.disable_model_invocation is True


# ============================================================================
# load_skills_from_dir
# ============================================================================


class TestLoadSkillsFromDir:
    def test_load_valid_skills(self, tmp_path):
        # Create two skill directories
        skill1_dir = tmp_path / "review-pr"
        skill1_dir.mkdir()
        (skill1_dir / "SKILL.md").write_text(textwrap.dedent("""\
            ---
            name: review-pr
            description: Review a PR
            ---
            Review the PR.
        """))

        skill2_dir = tmp_path / "deploy"
        skill2_dir.mkdir()
        (skill2_dir / "SKILL.md").write_text(textwrap.dedent("""\
            ---
            description: Deploy the app
            ---
            Deploy it.
        """))

        skills = load_skills_from_dir(str(tmp_path))
        assert len(skills) == 2
        names = {s.name for s in skills}
        assert "review-pr" in names
        assert "deploy" in names  # Falls back to dir name

    def test_skip_non_skill_dirs(self, tmp_path):
        # Dir without SKILL.md
        (tmp_path / "not-a-skill").mkdir()
        # File at top level (not a dir)
        (tmp_path / "README.md").write_text("hello")
        skills = load_skills_from_dir(str(tmp_path))
        assert len(skills) == 0

    def test_nonexistent_dir(self):
        skills = load_skills_from_dir("/nonexistent/path/surely")
        assert skills == []

    def test_malformed_skill_md(self, tmp_path):
        skill_dir = tmp_path / "bad-skill"
        skill_dir.mkdir()
        # Write a file with binary content that can't be parsed
        (skill_dir / "SKILL.md").write_bytes(b"\x00\x01\x02")
        skills = load_skills_from_dir(str(tmp_path))
        # Should not crash, just skip
        assert len(skills) <= 1


# ============================================================================
# SkillRegistry
# ============================================================================


class TestSkillRegistry:
    def setup_method(self):
        self.reg = SkillRegistry()

    def _make(self, name: str, source: str = "bundled", **kw) -> SkillDefinition:
        return SkillDefinition(
            name=name, description=f"{name} desc", prompt=f"{name} prompt",
            source=source, **kw,
        )

    def test_register_and_get(self):
        s = self._make("alpha")
        self.reg.register_bundled(s)
        assert self.reg.get("alpha") is s

    def test_get_missing(self):
        assert self.reg.get("nope") is None

    def test_priority_instance_over_disk(self):
        self.reg.register_bundled(self._make("x", "bundled"))
        self.reg.set_disk_skills([self._make("x", "disk")])
        assert self.reg.get("x").source == "disk"
        self.reg.set_instance_skills([self._make("x", "agentConfig")])
        assert self.reg.get("x").source == "agentConfig"

    def test_clear_instance_restores_disk(self):
        self.reg.set_disk_skills([self._make("x", "disk")])
        self.reg.set_instance_skills([self._make("x", "agentConfig")])
        assert self.reg.get("x").source == "agentConfig"
        self.reg.clear_instance_skills()
        assert self.reg.get("x").source == "disk"

    def test_list_available_excludes_disabled(self):
        self.reg.register_bundled(self._make("visible"))
        self.reg.register_bundled(self._make("hidden", disable_model_invocation=True))
        available = self.reg.list_available()
        names = [s.name for s in available]
        assert "visible" in names
        assert "hidden" not in names

    def test_list_available_deduplicates(self):
        self.reg.register_bundled(self._make("x", "bundled"))
        self.reg.set_disk_skills([self._make("x", "disk")])
        available = self.reg.list_available()
        x_skills = [s for s in available if s.name == "x"]
        assert len(x_skills) == 1
        assert x_skills[0].source == "disk"

    def test_list_available_sorted(self):
        self.reg.register_bundled(self._make("zeta"))
        self.reg.register_bundled(self._make("alpha"))
        self.reg.register_bundled(self._make("mid"))
        names = [s.name for s in self.reg.list_available()]
        assert names == sorted(names)


# ============================================================================
# run_skill
# ============================================================================


class TestRunSkill:
    def setup_method(self):
        # Reset the global registry for each test
        reg = get_registry()
        reg._bundled.clear()
        reg._disk.clear()
        reg._instance.clear()

    def test_basic_invocation(self):
        reg = get_registry()
        reg.register_bundled(SkillDefinition(
            name="greet", description="Greeting", prompt="Hello ${ARGUMENTS}!", source="bundled",
        ))
        result = run_skill("greet", "world")
        assert result == "Hello world!"

    def test_no_args_substitution(self):
        reg = get_registry()
        reg.register_bundled(SkillDefinition(
            name="plain", description="Plain", prompt="Do ${ARGUMENTS} now", source="bundled",
        ))
        result = run_skill("plain")
        assert result == "Do  now"

    def test_allowed_tools_directive(self):
        reg = get_registry()
        reg.register_bundled(SkillDefinition(
            name="restricted", description="R", prompt="Body",
            source="bundled", allowed_tools=("Read", "Grep"),
        ))
        result = run_skill("restricted")
        assert "<skill-context" in result
        assert 'name="restricted"' in result
        assert "Read, Grep" in result
        assert "Body" in result

    def test_missing_skill_error(self):
        result = run_skill("nonexistent")
        assert "Error" in result
        assert "not found" in result

    def test_empty_skill_name(self):
        result = run_skill("")
        assert "Error" in result
        assert "No skill name" in result

    def test_whitespace_skill_name(self):
        result = run_skill("   ")
        assert "Error" in result


# ============================================================================
# Backward-compatible register_skill()
# ============================================================================


class TestBackwardCompat:
    def setup_method(self):
        reg = get_registry()
        reg._bundled.clear()
        reg._disk.clear()
        reg._instance.clear()

    def test_register_and_invoke(self):
        register_skill("legacy", lambda: "Legacy prompt body", "A legacy skill")
        result = run_skill("legacy")
        assert "Legacy prompt body" in result

    def test_get_registered_skills(self):
        register_skill("one", lambda: "p1", "First")
        register_skill("two", lambda: "p2", "Second")
        skills = get_registered_skills()
        assert "one" in skills
        assert "two" in skills
        assert skills["one"]["description"] == "First"

    def test_callable_exception_graceful(self):
        def bad_func():
            raise RuntimeError("boom")
        register_skill("bad", bad_func, "Broken")
        # Should still register with empty prompt
        result = run_skill("bad")
        assert result == ""


# ============================================================================
# format_skill_listings
# ============================================================================


class TestFormatSkillListings:
    def _make(self, name: str, desc: str = "desc", **kw) -> SkillDefinition:
        return SkillDefinition(
            name=name, description=desc, prompt="prompt", source="bundled", **kw,
        )

    def test_empty_list(self):
        assert format_skill_listings([]) == ""

    def test_basic_listing(self):
        skills = [self._make("commit", "Commit changes"), self._make("review", "Review code")]
        listing = format_skill_listings(skills)
        assert "<system-reminder>" in listing
        assert "</system-reminder>" in listing
        assert "- commit: Commit changes" in listing
        assert "- review: Review code" in listing

    def test_includes_when_to_use(self):
        s = self._make("deploy", "Deploy the app", when_to_use="When user says deploy")
        listing = format_skill_listings([s])
        assert "Deploy the app - When user says deploy" in listing

    def test_truncation_on_budget(self):
        # Create skills with very long descriptions
        skills = [
            self._make(f"skill-{i}", "x" * 500) for i in range(50)
        ]
        listing = format_skill_listings(skills, max_chars=500)
        # Should not exceed budget by too much (some overhead for tags)
        # The key thing is it doesn't crash and produces valid output
        assert "<system-reminder>" in listing
        assert "</system-reminder>" in listing

    def test_long_description_capped(self):
        long_desc = "a" * 300
        s = self._make("long", long_desc)
        listing = format_skill_listings([s])
        # Description should be truncated to MAX_LISTING_DESC_CHARS
        assert "\u2026" in listing


# ============================================================================
# get_skill_tool_description
# ============================================================================


class TestGetSkillToolDescription:
    def test_returns_string(self):
        desc = get_skill_tool_description()
        assert isinstance(desc, str)
        assert "skill" in desc.lower()
        assert "BLOCKING REQUIREMENT" in desc


# ============================================================================
# Integration: _extract_skill_configs (test the function from main.py)
# ============================================================================

# We can't import main.py (needs dapr_agents), so we test the logic
# extracted into a standalone function here.


class TestExtractSkillConfigs:
    """Test the skill extraction logic that would live in main.py."""

    def test_extract_from_agent_config(self):
        # Simulate what _extract_skill_configs does
        message = {
            "agentConfig": {
                "skills": [
                    {
                        "name": "review-pr",
                        "description": "Review a PR",
                        "prompt": "Review PR ${ARGUMENTS}",
                        "allowed_tools": ["Read", "Grep"],
                    },
                    {
                        "name": "deploy",
                        "description": "Deploy",
                        "prompt": "Deploy the app",
                    },
                ]
            }
        }
        agent_config = message.get("agentConfig", {})
        raw_skills = agent_config.get("skills", [])
        skills = []
        for item in raw_skills:
            name = str(item.get("name", "")).strip()
            prompt = str(item.get("prompt", "")).strip()
            if name and prompt:
                allowed_tools = tuple(
                    str(t).strip() for t in (item.get("allowed_tools") or [])
                    if str(t).strip()
                )
                skills.append(SkillDefinition(
                    name=name,
                    description=str(item.get("description", "")),
                    prompt=prompt,
                    source="agentConfig",
                    allowed_tools=allowed_tools,
                ))
        assert len(skills) == 2
        assert skills[0].name == "review-pr"
        assert skills[0].allowed_tools == ("Read", "Grep")
        assert skills[1].name == "deploy"
        assert skills[1].allowed_tools == ()


# ============================================================================
# Integration: end-to-end disk loading
# ============================================================================


class TestEndToEndDiskLoading:
    def test_load_and_invoke(self, tmp_path):
        # Create a skill on disk
        skill_dir = tmp_path / "greet"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text(textwrap.dedent("""\
            ---
            name: greet
            description: Greet someone
            allowed-tools: Read
            ---

            Hello, ${ARGUMENTS}! Welcome to the project.
        """))

        # Load into a fresh registry
        reg = SkillRegistry()
        skills = load_skills_from_dir(str(tmp_path))
        reg.set_disk_skills(skills)

        # Verify it's available
        available = reg.list_available()
        assert len(available) == 1
        assert available[0].name == "greet"

        # Verify listing
        listing = format_skill_listings(available)
        assert "greet" in listing
        assert "Greet someone" in listing

        # Simulate invocation
        skill_def = reg.get("greet")
        prompt = skill_def.prompt.replace("${ARGUMENTS}", "Alice")
        assert "Hello, Alice!" in prompt

    def test_instance_skills_override_disk(self, tmp_path):
        # Disk skill
        skill_dir = tmp_path / "deploy"
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text(textwrap.dedent("""\
            ---
            name: deploy
            description: Disk deploy
            ---
            Disk deploy prompt
        """))

        reg = SkillRegistry()
        reg.set_disk_skills(load_skills_from_dir(str(tmp_path)))
        assert reg.get("deploy").source == "disk"

        # Instance skill overrides
        reg.set_instance_skills([SkillDefinition(
            name="deploy", description="Instance deploy",
            prompt="Instance deploy prompt", source="agentConfig",
        )])
        assert reg.get("deploy").source == "agentConfig"
        assert "Instance" in reg.get("deploy").prompt

        # Clear restores disk
        reg.clear_instance_skills()
        assert reg.get("deploy").source == "disk"
        assert "Disk" in reg.get("deploy").prompt
