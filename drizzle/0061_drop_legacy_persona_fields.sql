-- Cutover the agent persona fields to a single `systemPrompt` (mirrors CMA's
-- agent schema, which has one `system` field — no role/goal/instructions
-- split, no separate append slot. Those structures were workflow-builder
-- inventions; CMA's flat shape is the cleaner mental model).
--
-- For each agent_versions row:
--   • If `customSystemPrompt` is populated → use it verbatim as the base
--     (the prior renderer ignored legacy fields when customSystemPrompt was
--     set, so this preserves the agent's actual prompt).
--   • Otherwise → render `role`, `goal`, `systemPrompt` (legacy), `instructions`,
--     `styleGuidelines` into a single Markdown block (preserving the
--     `## Role` / `## Goal` / `## Agent System Prompt` / `## Primary
--     Instructions` / `## Communication Style` headers the renderer used to
--     emit), and use that as the base.
--   • Append `appendSystemPrompt` content to the end (separated by blank line)
--     since it carries semantic content the user authored — moving it into
--     the static prefix is strictly better (was per-turn / non-cacheable in
--     the prior pipeline) and we want zero data loss.
--
-- Then drop `role`, `goal`, `instructions`, `styleGuidelines`,
-- `customSystemPrompt`, AND `appendSystemPrompt` from the JSONB. The new
-- persona surface is just `systemPrompt`, plus the static/dynamic preset
-- bindings.
--
-- Idempotent: rows with no legacy or custom content are skipped; running
-- twice yields identical state.
--> statement-breakpoint
DO $$
DECLARE
  r RECORD;
  rendered TEXT;
  prefix_done BOOLEAN;
  final_value TEXT;
BEGIN
  FOR r IN
    SELECT id, config FROM agent_versions
    WHERE
      coalesce(config->>'role', '') <> ''
      OR coalesce(config->>'goal', '') <> ''
      OR coalesce(config->>'systemPrompt', '') <> ''
      OR coalesce(config->>'customSystemPrompt', '') <> ''
      OR coalesce(config->>'appendSystemPrompt', '') <> ''
      OR (jsonb_typeof(config->'instructions') = 'array' AND jsonb_array_length(config->'instructions') > 0)
      OR (jsonb_typeof(config->'styleGuidelines') = 'array' AND jsonb_array_length(config->'styleGuidelines') > 0)
  LOOP
    -- customSystemPrompt wins (matches the prior renderer's override semantics).
    final_value := coalesce(r.config->>'customSystemPrompt', '');

    IF final_value = '' THEN
      rendered := '';
      prefix_done := FALSE;

      -- ## Agent System Prompt (the legacy `systemPrompt` field, before rename)
      IF coalesce(r.config->>'systemPrompt', '') <> '' THEN
        IF prefix_done THEN rendered := rendered || E'\n\n'; END IF;
        rendered := rendered || E'## Agent System Prompt\n' || (r.config->>'systemPrompt');
        prefix_done := TRUE;
      END IF;
      -- ## Role
      IF coalesce(r.config->>'role', '') <> '' THEN
        IF prefix_done THEN rendered := rendered || E'\n\n'; END IF;
        rendered := rendered || E'## Role\n' || (r.config->>'role');
        prefix_done := TRUE;
      END IF;
      -- ## Goal
      IF coalesce(r.config->>'goal', '') <> '' THEN
        IF prefix_done THEN rendered := rendered || E'\n\n'; END IF;
        rendered := rendered || E'## Goal\n' || (r.config->>'goal');
        prefix_done := TRUE;
      END IF;
      -- ## Primary Instructions
      IF jsonb_typeof(r.config->'instructions') = 'array' AND jsonb_array_length(r.config->'instructions') > 0 THEN
        IF prefix_done THEN rendered := rendered || E'\n\n'; END IF;
        rendered := rendered || E'## Primary Instructions\n'
          || coalesce((SELECT string_agg(E'- ' || trim(value), E'\n') FROM jsonb_array_elements_text(r.config->'instructions') WHERE trim(value) <> ''), '');
        prefix_done := TRUE;
      END IF;
      -- ## Communication Style
      IF jsonb_typeof(r.config->'styleGuidelines') = 'array' AND jsonb_array_length(r.config->'styleGuidelines') > 0 THEN
        IF prefix_done THEN rendered := rendered || E'\n\n'; END IF;
        rendered := rendered || E'## Communication Style\n'
          || coalesce((SELECT string_agg(E'- ' || trim(value), E'\n') FROM jsonb_array_elements_text(r.config->'styleGuidelines') WHERE trim(value) <> ''), '');
        prefix_done := TRUE;
      END IF;

      final_value := rendered;
    END IF;

    -- Append `appendSystemPrompt` content (was the per-turn suffix in the
    -- prior pipeline; folding into static prefix is strictly better since it
    -- becomes cache-eligible).
    IF coalesce(r.config->>'appendSystemPrompt', '') <> '' THEN
      IF final_value <> '' THEN final_value := final_value || E'\n\n'; END IF;
      final_value := final_value || (r.config->>'appendSystemPrompt');
    END IF;

    UPDATE agent_versions
    SET config =
      (CASE WHEN final_value <> ''
            THEN r.config || jsonb_build_object('systemPrompt', final_value)
            ELSE r.config - 'systemPrompt'
       END)
      - 'role' - 'goal' - 'instructions' - 'styleGuidelines' - 'customSystemPrompt' - 'appendSystemPrompt'
    WHERE id = r.id;
  END LOOP;
END $$;
