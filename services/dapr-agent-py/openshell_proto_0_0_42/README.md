Generated protobuf stubs for NVIDIA OpenShell v0.0.42.

The upstream PyPI wheels for OpenShell 0.0.29 through 0.0.42 currently omit
these generated Python modules while openshell._proto.__init__ imports them.
Our images copy these files into the installed openshell package after uv sync.

Source: https://github.com/NVIDIA/OpenShell/tree/v0.0.42/proto
Generation command mirrors OpenShell tasks/python.toml python:proto.
