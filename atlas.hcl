// Atlas configuration for workflow-builder.
//
// Source of truth:
// - Schema: Drizzle TypeScript schema in lib/db/schema.ts (exported via drizzle-kit)
// - Migrations: Versioned SQL files under atlas/migrations (applied by Atlas CLI)

data "external_schema" "drizzle" {
  program = [
    "bash",
    "-lc",
    // drizzle-kit export generates the full schema SQL from an empty state.
    // drizzle.config.ts loads dotenv; DOTENV_CONFIG_QUIET prevents dotenv
    // from printing to stdout (which would corrupt the SQL stream).
    "DOTENV_CONFIG_QUIET=true pnpm -s drizzle-kit export --sql",
  ]
}

env "local" {
  // Current state (requires DATABASE_URL).
  url = getenv("DATABASE_URL")

  // Desired state (from Drizzle schema).
  schema {
    src = data.external_schema.drizzle.url
  }

  // Atlas uses a disposable dev database for planning/diffing.
  // This requires Docker locally (available in this environment).
  dev = "docker://postgres/16/dev?search_path=public"

  migration {
    dir = "file://atlas/migrations"
  }

  // We keep legacy Drizzle migrations in-repo, but Atlas should ignore them.
  exclude = ["drizzle"]
}

// Kubernetes/CI environment: migrations only (no schema inspection program needed).
env "k8s" {
  url = getenv("DATABASE_URL")
  migration {
    dir = "file://atlas/migrations"
  }
}
