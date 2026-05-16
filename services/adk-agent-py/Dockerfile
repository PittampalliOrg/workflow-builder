FROM ghcr.io/astral-sh/uv:python3.12-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends git curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY openshell_proto_0_0_42/ ./openshell_proto_0_0_42/
RUN /app/.venv/bin/python - <<'PY'
from pathlib import Path
import shutil
import sysconfig

source = Path("/app/openshell_proto_0_0_42")
target = Path(sysconfig.get_paths()["purelib"]) / "openshell" / "_proto"
for path in source.iterdir():
    if path.name != "README.md":
        shutil.copy2(path, target / path.name)
PY
COPY src/ src/
EXPOSE 8002
CMD ["uv", "run", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8002"]
