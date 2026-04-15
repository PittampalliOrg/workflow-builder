import importlib.util
import sys
import types
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL_TOOL_DIR = ROOT / "src" / "tools" / "skill_tool"


def _load_skill_tool_modules():
    for name in ["src", "src.tools", "src.tools.skill_tool"]:
        if name not in sys.modules:
            module = types.ModuleType(name)
            module.__path__ = [str(SKILL_TOOL_DIR)]
            sys.modules[name] = module
    for name in ["models", "prompt", "tool"]:
        fq_name = f"src.tools.skill_tool.{name}"
        if fq_name in sys.modules:
            continue
        spec = importlib.util.spec_from_file_location(fq_name, SKILL_TOOL_DIR / f"{name}.py")
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        sys.modules[fq_name] = module
        spec.loader.exec_module(module)
    return sys.modules["src.tools.skill_tool.models"], sys.modules["src.tools.skill_tool.tool"]


def test_run_skill_includes_materialized_package_path():
    models, tool = _load_skill_tool_modules()
    SkillDefinition = models.SkillDefinition
    get_registry = tool.get_registry
    run_skill = tool.run_skill

    registry = get_registry()
    registry.clear_instance_skills()
    registry.set_disk_skills([])
    registry.set_instance_skills(
        [
            SkillDefinition(
                name="demo",
                description="Demo packaged skill",
                prompt="Follow the package instructions for ${ARGUMENTS}.",
                source="agentConfig",
                package_path="/sandbox/.workflow-builder/skills/run-1/demo",
                package_files=("SKILL.md", "references/demo.md"),
            )
        ]
    )

    output = run_skill("demo", "the target")

    assert "Directory: /sandbox/.workflow-builder/skills/run-1/demo" in output
    assert "- references/demo.md" in output
    assert "Follow the package instructions for the target." in output
