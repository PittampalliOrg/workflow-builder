-- Phase C — gold-patch comparison columns. Populated by the
-- evaluation-results endpoint when the SWE-bench harness reports back.
-- Surfaces in the run-instance-drawer Harness tab.
ALTER TABLE benchmark_run_instances
	ADD COLUMN IF NOT EXISTS patch_added_lines integer,
	ADD COLUMN IF NOT EXISTS patch_removed_lines integer,
	ADD COLUMN IF NOT EXISTS patch_files_touched integer,
	ADD COLUMN IF NOT EXISTS patch_files_overlap_gold integer,
	ADD COLUMN IF NOT EXISTS patch_well_formed boolean;
