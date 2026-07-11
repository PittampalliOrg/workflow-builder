-- OKF §4.1 recommended field `resource`: a URI uniquely identifying the
-- underlying asset a concept describes (a run URL, a source doc, a dashboard).
-- Absent for abstract concepts. Skipped in the first cut of the knowledge
-- layer; added for spec parity with the reference bundles.
ALTER TABLE "team_knowledge" ADD COLUMN IF NOT EXISTS "resource" text;
