"""
Custom Function Template (Python)

This is a template for creating custom functions that can be executed
as OCI containers by the function-runner service.

Input:
  - Received via INPUT environment variable (JSON string)
  - Additional context available via EXECUTION_ID, WORKFLOW_ID, NODE_ID, NODE_NAME
  - Credentials injected as environment variables (e.g., API_KEY)

Output:
  - Write JSON to stdout (the function-runner captures this)
  - Use stderr for logs (not captured as output)

Example:
  INPUT='{"name":"World"}' python main.py
  => {"success":true,"result":"Hello, World!"}
"""
import json
import os
import sys
from typing import Optional

from pydantic import BaseModel, Field


# ============================================================================
# CUSTOMIZE THESE TYPES AND SCHEMAS FOR YOUR FUNCTION
# ============================================================================

class Input(BaseModel):
    """Input schema - define what your function expects"""
    name: str = Field(default="World")
    count: int = Field(default=1, ge=1)


class Output(BaseModel):
    """Output type - define what your function returns"""
    success: bool
    result: Optional[str] = None
    error: Optional[str] = None


# ============================================================================
# MAIN FUNCTION LOGIC
# ============================================================================

def execute(input_data: Input) -> Output:
    """Your main function logic goes here"""
    try:
        # Your custom logic here
        messages = []
        for i in range(input_data.count):
            messages.append(f"Hello, {input_data.name}!")

        return Output(
            success=True,
            result="\n".join(messages),
        )
    except Exception as e:
        return Output(
            success=False,
            error=str(e),
        )


# ============================================================================
# RUNNER (DO NOT MODIFY BELOW)
# ============================================================================

def main():
    # Parse input from environment variable
    input_json = os.environ.get("INPUT", "{}")

    # Log context for debugging (goes to stderr, not captured as output)
    print(f"[Function] Execution ID: {os.environ.get('EXECUTION_ID', 'unknown')}", file=sys.stderr)
    print(f"[Function] Workflow ID: {os.environ.get('WORKFLOW_ID', 'unknown')}", file=sys.stderr)
    print(f"[Function] Node ID: {os.environ.get('NODE_ID', 'unknown')}", file=sys.stderr)

    try:
        # Parse and validate input
        raw_input = json.loads(input_json)
        input_data = Input(**raw_input)

        print(f"[Function] Input: {input_data.model_dump_json()}", file=sys.stderr)

        # Execute the function
        output = execute(input_data)

        # Write output to stdout (this is captured by function-runner)
        print(output.model_dump_json())

        # Exit with appropriate code
        sys.exit(0 if output.success else 1)

    except Exception as e:
        # Handle parsing/validation errors
        output = Output(success=False, error=str(e))
        print(output.model_dump_json())
        sys.exit(1)


if __name__ == "__main__":
    main()
