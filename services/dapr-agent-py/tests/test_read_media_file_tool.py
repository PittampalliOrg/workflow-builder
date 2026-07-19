"""Tests for the ReadMediaFile tool (kimi-code-aligned vision input)."""

from __future__ import annotations

import base64
import importlib
import io
import sys
import types
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "src"


def _install_src_package() -> None:
    src_pkg = sys.modules.get("src") or types.ModuleType("src")
    src_pkg.__path__ = [str(SRC_DIR)]
    sys.modules["src"] = src_pkg

    tools_pkg = sys.modules.get("src.tools") or types.ModuleType("src.tools")
    tools_pkg.__path__ = [str(SRC_DIR / "tools")]
    sys.modules["src.tools"] = tools_pkg

    media_pkg = sys.modules.get("src.tools.read_media_file") or types.ModuleType(
        "src.tools.read_media_file"
    )
    media_pkg.__path__ = [str(SRC_DIR / "tools" / "read_media_file")]
    sys.modules["src.tools.read_media_file"] = media_pkg


def _load_tool(monkeypatch):
    fake_openshell = types.ModuleType("openshell")
    fake_openshell.SandboxClient = object
    fake_openshell.SandboxSession = object
    monkeypatch.setitem(sys.modules, "openshell", fake_openshell)
    # Snapshot + restore src* modules so the fake packages do not leak into
    # other test files (see test_file_edit_tool.py for the pattern's history).
    saved = {k: v for k, v in sys.modules.items() if k == "src" or k.startswith("src.")}
    try:
        _install_src_package()
        sys.modules.pop("src.tools.read_media_file.tool", None)
        return importlib.import_module("src.tools.read_media_file.tool")
    finally:
        for key in [k for k in sys.modules if k == "src" or k.startswith("src.")]:
            if key not in saved:
                del sys.modules[key]
        sys.modules.update(saved)


def _png_bytes(width: int, height: int, color=(40, 90, 160), fmt="PNG") -> bytes:
    img = Image.new("RGB", (width, height), color)
    out = io.BytesIO()
    img.save(out, format=fmt)
    return out.getvalue()


def _gif_bytes(width: int, height: int) -> bytes:
    f1 = Image.new("RGB", (width, height), (200, 30, 30))
    f2 = Image.new("RGB", (width, height), (30, 30, 200))
    out = io.BytesIO()
    f1.save(out, format="GIF", save_all=True, append_images=[f2], duration=100, loop=0)
    return out.getvalue()


class FakeRuntime:
    def __init__(self, files: dict[str, bytes] | None = None) -> None:
        self.files = files or {}

    def stat_path(self, path: str) -> dict:
        return {"ok": True, "exists": path in self.files}

    def read_bytes_base64(self, path: str, max_bytes: int = 100 * 1024 * 1024) -> dict:
        data = self.files[path]
        if len(data) > max_bytes:
            return {"ok": False, "error": "too_large", "size": len(data)}
        return {
            "ok": True,
            "path": path,
            "size": len(data),
            "base64": base64.b64encode(data).decode("ascii"),
        }


def _run_tool(monkeypatch, tool, runtime, **kwargs):
    monkeypatch.setattr(tool, "get_runtime", lambda: runtime)
    return tool.read_media_file(**kwargs)


def _decode_image_block(result: str) -> tuple[str, dict]:
    from src.mcp_multimodal import decode_multimodal_tool_content

    parts = decode_multimodal_tool_content(result)
    assert parts is not None, f"result is not multimodal marker JSON: {result[:120]}"
    text = "\n".join(p.get("text", "") for p in parts if p.get("type") == "text")
    images = [p for p in parts if p.get("type") == "image"]
    assert len(images) == 1
    return text, images[0]


def _open_block(image_block: dict) -> Image.Image:
    return Image.open(io.BytesIO(base64.b64decode(image_block["data"])))


# ---------------------------------------------------------------------------
# Wire schema
# ---------------------------------------------------------------------------


def test_args_model_wire_schema(monkeypatch) -> None:
    tool = _load_tool(monkeypatch)
    schema = tool.ReadMediaFileArgs.model_json_schema(by_alias=True)
    assert schema["additionalProperties"] is False
    assert schema["required"] == ["path"]
    assert set(schema["properties"]) == {"path", "region", "full_resolution"}
    assert all(
        prop.get("description") for prop in schema["properties"].values()
    ), "every param needs a description (Kimi schema guidance)"
    region = schema["$defs"]["ReadMediaFileRegion"]
    assert region["required"] == ["x", "y", "width", "height"]
    assert region["additionalProperties"] is False
    # Python-side aliases are not needed; the names match kimi-code exactly.
    tool_fn_params = set(tool.read_media_file.__wrapped__.__code__.co_varnames) if hasattr(
        tool.read_media_file, "__wrapped__"
    ) else {"path", "region", "full_resolution"}
    assert {"path", "region", "full_resolution"} <= tool_fn_params


# ---------------------------------------------------------------------------
# Behavior
# ---------------------------------------------------------------------------


def test_small_png_delivered_untouched(monkeypatch) -> None:
    tool = _load_tool(monkeypatch)
    data = _png_bytes(800, 600)
    result = _run_tool(monkeypatch, tool, FakeRuntime({"/sandbox/a.png": data}), path="/sandbox/a.png")

    text, block = _decode_image_block(result)
    assert "Read /sandbox/a.png" in text
    assert "image/png" in text
    assert "800x600" in text
    assert "untouched" in text
    assert block["mimeType"] == "image/png"
    img = _open_block(block)
    assert img.size == (800, 600)


def test_large_png_downsampled_to_long_edge(monkeypatch) -> None:
    tool = _load_tool(monkeypatch)
    data = _png_bytes(3000, 2000)
    result = _run_tool(monkeypatch, tool, FakeRuntime({"/sandbox/big.png": data}), path="/sandbox/big.png")

    text, block = _decode_image_block(result)
    assert "3000x2000 -> 1568x1045" in text
    assert "downsampled" in text
    img = _open_block(block)
    assert img.size == (1568, 1045)


def test_region_crop_delivered_at_native_size(monkeypatch) -> None:
    tool = _load_tool(monkeypatch)
    data = _png_bytes(3000, 2000)
    result = _run_tool(
        monkeypatch,
        tool,
        FakeRuntime({"/sandbox/big.png": data}),
        path="/sandbox/big.png",
        region={"x": 100, "y": 50, "width": 400, "height": 300},
    )

    text, block = _decode_image_block(result)
    assert "cropped to region" in text
    img = _open_block(block)
    assert img.size == (400, 300)


def test_region_outside_bounds_errors(monkeypatch) -> None:
    tool = _load_tool(monkeypatch)
    data = _png_bytes(100, 100)
    result = _run_tool(
        monkeypatch,
        tool,
        FakeRuntime({"/sandbox/a.png": data}),
        path="/sandbox/a.png",
        region={"x": 500, "y": 500, "width": 10, "height": 10},
    )
    assert result.startswith("Error:") and "outside" in result


def test_full_resolution_skips_downsample(monkeypatch) -> None:
    tool = _load_tool(monkeypatch)
    data = _png_bytes(3000, 2000)
    result = _run_tool(
        monkeypatch,
        tool,
        FakeRuntime({"/sandbox/big.png": data}),
        path="/sandbox/big.png",
        full_resolution=True,
    )

    text, block = _decode_image_block(result)
    assert "native resolution" in text
    img = _open_block(block)
    assert img.size == (3000, 2000)


def test_jpeg_stays_jpeg(monkeypatch) -> None:
    tool = _load_tool(monkeypatch)
    data = _png_bytes(200, 100, fmt="JPEG")
    result = _run_tool(monkeypatch, tool, FakeRuntime({"/sandbox/a.jpg": data}), path="/sandbox/a.jpg")

    _text, block = _decode_image_block(result)
    assert block["mimeType"] == "image/jpeg"


def test_animated_gif_first_frame_as_png(monkeypatch) -> None:
    tool = _load_tool(monkeypatch)
    data = _gif_bytes(120, 90)
    result = _run_tool(monkeypatch, tool, FakeRuntime({"/sandbox/a.gif": data}), path="/sandbox/a.gif")

    text, block = _decode_image_block(result)
    assert "120x90" in text
    assert block["mimeType"] == "image/png"  # re-encoded, first frame
    img = _open_block(block)
    assert img.size == (120, 90)
    # First frame color wins (red), not the second frame (blue).
    assert img.convert("RGB").getpixel((0, 0)) == (200, 30, 30)


def test_missing_file_errors(monkeypatch) -> None:
    tool = _load_tool(monkeypatch)
    result = _run_tool(monkeypatch, tool, FakeRuntime({}), path="/sandbox/nope.png")
    assert result == "Error: file not found: /sandbox/nope.png"


def test_non_image_file_errors(monkeypatch) -> None:
    tool = _load_tool(monkeypatch)
    result = _run_tool(monkeypatch, tool, FakeRuntime({"/sandbox/a.txt": b"hi"}), path="/sandbox/a.txt")
    assert result.startswith("Error:") and "not a supported image file" in result


def test_video_file_errors(monkeypatch) -> None:
    tool = _load_tool(monkeypatch)
    result = _run_tool(monkeypatch, tool, FakeRuntime({"/sandbox/a.mp4": b"\x00"}), path="/sandbox/a.mp4")
    assert result.startswith("Error:") and "video file" in result


def test_over_100mb_errors(monkeypatch) -> None:
    tool = _load_tool(monkeypatch)
    big = b"\x00" * (101 * 1024 * 1024)
    result = _run_tool(monkeypatch, tool, FakeRuntime({"/sandbox/huge.png": big}), path="/sandbox/huge.png")
    assert "100 MB" in result and result.startswith("Error:")


def test_corrupt_image_errors(monkeypatch) -> None:
    tool = _load_tool(monkeypatch)
    result = _run_tool(
        monkeypatch,
        tool,
        FakeRuntime({"/sandbox/bad.png": b"not really a png"}),
        path="/sandbox/bad.png",
    )
    assert result.startswith("Error:") and "not a readable image" in result


# ---------------------------------------------------------------------------
# Downstream vision flow (marker -> kimi history parts)
# ---------------------------------------------------------------------------


def test_marker_flows_into_kimi_vision_parts(monkeypatch) -> None:
    tool = _load_tool(monkeypatch)
    data = _png_bytes(64, 48)
    result = _run_tool(monkeypatch, tool, FakeRuntime({"/sandbox/a.png": data}), path="/sandbox/a.png")

    from src.kimi_adapter import _to_kimi_content_parts

    parts, has_media = _to_kimi_content_parts(result)
    assert has_media is True
    image_urls = [p for p in parts if p.get("type") == "image_url"]
    assert len(image_urls) == 1
    url = image_urls[0]["image_url"]["url"]
    assert url.startswith("data:image/png;base64,")
    texts = [p for p in parts if p.get("type") == "text"]
    assert any("<system>" in (p.get("text") or "") for p in texts)
