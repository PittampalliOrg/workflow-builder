"""Tests for the if-field permission-rule parser."""
from __future__ import annotations

from src.hooks.permission_rules import evaluate, parse


class TestParse:
    def test_single_term_tool_only(self):
        terms = parse("Bash")
        assert len(terms) == 1
        assert terms[0].tool == "Bash"
        assert terms[0].arg_pattern is None
        assert terms[0].negate is False

    def test_tool_with_glob(self):
        terms = parse("Bash(git *)")
        assert terms[0].tool == "Bash"
        assert terms[0].arg_pattern == "git *"

    def test_compound_and(self):
        terms = parse("Bash(git *) and !Bash(git push*)")
        assert len(terms) == 2
        assert terms[0].negate is False
        assert terms[1].negate is True

    def test_empty(self):
        assert parse("") == []
        assert parse("   ") == []


class TestEvaluate:
    def test_empty_rule_always_passes(self):
        assert evaluate("", "Bash", {"command": "rm -rf /"}) is True

    def test_simple_tool_match(self):
        assert evaluate("Bash", "Bash", {"command": "ls"}) is True
        assert evaluate("Bash", "Read", {"file_path": "foo.py"}) is False

    def test_arg_glob_match_bash(self):
        assert evaluate("Bash(git *)", "Bash", {"command": "git status"}) is True
        assert evaluate("Bash(git *)", "Bash", {"command": "ls"}) is False

    def test_arg_glob_match_read(self):
        assert evaluate("Read(*.ts)", "Read", {"file_path": "src/main.ts"}) is True
        assert evaluate("Read(*.ts)", "Read", {"file_path": "src/main.py"}) is False

    def test_negation_blocks_matching_case(self):
        assert evaluate("!Bash(git push*)", "Bash", {"command": "git status"}) is True
        assert evaluate("!Bash(git push*)", "Bash", {"command": "git push origin"}) is False

    def test_compound_and_requires_all(self):
        rule = "Bash(git *) and !Bash(git push*)"
        assert evaluate(rule, "Bash", {"command": "git status"}) is True
        assert evaluate(rule, "Bash", {"command": "git push origin"}) is False
        assert evaluate(rule, "Bash", {"command": "ls"}) is False

    def test_unparseable_rule_defaults_to_pass(self):
        # Defensive: don't silently skip hooks on malformed rules.
        assert evaluate("!!!", "Bash", {"command": "ls"}) is True
