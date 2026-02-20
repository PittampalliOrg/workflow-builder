-- Upgrade coding agent profile for opencode durable code-edit workflows.

INSERT INTO "agent_instruction_facet_versions" (
  "id",
  "facet_id",
  "version",
  "config",
  "is_default"
)
VALUES (
  'fv_instr_coding_v2',
  'f_instr_coding',
  2,
  '{"instructions":"You are an autonomous coding agent operating on a real git workspace. Inspect relevant files before changing code, then make concrete file edits instead of returning only a plan. When code changes are requested, run targeted validation commands and iterate until failures are addressed. Prefer direct replacement of stale legacy code when a better implementation is required. Before finishing, confirm git diff is non-empty and report changed files, validation commands, and any remaining risks."}',
  true
);

INSERT INTO "agent_tool_policy_facet_versions" (
  "id",
  "facet_id",
  "version",
  "config",
  "compatibility",
  "is_default"
)
VALUES (
  'fv_tool_coding_v2',
  'f_tool_coding',
  2,
  '{"tools":[{"type":"workspace","ref":"glob"},{"type":"workspace","ref":"grep"},{"type":"workspace","ref":"read"},{"type":"workspace","ref":"edit"},{"type":"workspace","ref":"write"},{"type":"workspace","ref":"bash"}]}',
  NULL,
  true
);

INSERT INTO "agent_execution_facet_versions" (
  "id",
  "facet_id",
  "version",
  "config",
  "is_default"
)
VALUES (
  'fv_exec_coding_v2',
  'f_exec_coding',
  2,
  '{"maxTurns":260,"timeoutMinutes":120}',
  true
);

UPDATE "agent_instruction_facet_versions"
SET "is_default" = false
WHERE "facet_id" = 'f_instr_coding' AND "id" <> 'fv_instr_coding_v2';

UPDATE "agent_tool_policy_facet_versions"
SET "is_default" = false
WHERE "facet_id" = 'f_tool_coding' AND "id" <> 'fv_tool_coding_v2';

UPDATE "agent_execution_facet_versions"
SET "is_default" = false
WHERE "facet_id" = 'f_exec_coding' AND "id" <> 'fv_exec_coding_v2';

UPDATE "agent_profile_template_versions"
SET "is_default" = false
WHERE "template_id" = 'tpl_coding_agent';

INSERT INTO "agent_profile_template_versions" (
  "id",
  "template_id",
  "version",
  "instruction_facet_version_id",
  "model_facet_version_id",
  "tool_policy_facet_version_id",
  "memory_facet_version_id",
  "execution_facet_version_id",
  "interaction_facet_version_id",
  "output_facet_version_id",
  "capability_facet_version_id",
  "is_default"
)
VALUES (
  'tpv_coding_v2',
  'tpl_coding_agent',
  2,
  'fv_instr_coding_v2',
  'fv_model_reasoning_v1',
  'fv_tool_coding_v2',
  'fv_memory_thread_v1',
  'fv_exec_coding_v2',
  'fv_interaction_reasoning_v1',
  'fv_output_freeform_v1',
  'fv_cap_code_v1',
  true
);

UPDATE "agent_profile_templates"
SET
  "description" = 'Durable coding profile for repository edits, validation, and diff-based review in opencode workflows.',
  "source_repo_url" = 'https://github.com/PittampalliOrg/opencode',
  "source_path" = 'dev/packages/opencode/src/server/routes/durable.ts'
WHERE "id" = 'tpl_coding_agent';

UPDATE "agent_profile_template_examples"
SET
  "label" = 'Opencode Durable Coding Agent',
  "source_repo_url" = 'https://github.com/PittampalliOrg/opencode',
  "source_path" = 'dev/packages/opencode/src/server/routes/durable.ts',
  "notes" = 'Profile aligned to durable code-edit runs that must produce real file diffs and validation output.'
WHERE "id" = 'tpe_coding_v1';
