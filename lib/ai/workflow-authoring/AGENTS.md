# Workflow Authoring Agent Guide

You are generating CNCF Serverless Workflow definitions for workflow-builder.

## Required Output Contract

- Emit a complete Serverless Workflow 1.0 definition.
- Always use `document.dsl: "1.0.0"`.
- Use `document.summary`, never `document.description`.
- Use only supported task types:
  - `call`
  - `set`
  - `switch`
  - `for`
  - `do`
  - `emit`
  - `wait`
  - `fork`
  - `try`
  - `run`
  - `listen`
  - `raise`
- Prefer `call`, `set`, `switch`, `for`, and `emit` unless the user explicitly needs more.

## Platform Rules

- Reference only catalog function names in `call` tasks.
- Do not invent raw URLs or direct external MCP tool names.
- Do not invent placeholder `use.functions` entries.
- Keep graphs shallow and easy to visualize.
- Prefer linear workflows first.
- Add loops and branching only when they are clearly required by the user request.
- Reuse the `dapr-swe` resolve-issue pattern for repo and PR automation when applicable.

## Common Invalid Shapes To Avoid

- Invalid: `document.description`
- Valid: `document.summary`

- Invalid:
  ```yaml
  reviewLoop:
    for:
      each: attempt
      in: ${ [1, 2, 3] }
      do:
        - review:
            call: daprSweReview
  ```
- Valid:
  ```yaml
  reviewLoop:
    for:
      each: attempt
      in: ${ [1, 2, 3] }
    do:
      - review:
          call: daprSweReview
  ```

- Invalid:
  ```yaml
  emitDone:
    emit:
      event:
        type: com.example.done
        source: workflow
  ```
- Valid:
  ```yaml
  emitDone:
    emit:
      event:
        with:
          type: com.example.done
          source: workflow
  ```

- Invalid:
  ```yaml
  use:
    functions:
      daprSwePlan:
        type: custom
  ```
- Valid:
  Omit the `use.functions` placeholder entirely if you do not know the full function definition.

## Switch Rules

- Each `switch` array entry must contain exactly one case key.
- Each case may contain `when` and `then`.
- Keep `then` targets simple and stable.

## Authoring Policy

- If the user asks for a simple automation, avoid loops and nested review cycles.
- If the user asks for multi-agent behavior, use a small number of named phases:
  - initialize
  - plan
  - implement
  - review
  - commitPR
- If PR creation is not required, do not include `daprSweCommitPR`.
- If project MCP capabilities are provided, treat them as optional context for downstream agents, not as direct SW call targets unless a catalog function explicitly exposes them.
