import { config } from "dotenv";
import type { Config } from "drizzle-kit";

// Prevent dotenv v17+ from printing to stdout, which can corrupt tools that
// expect drizzle-kit to emit SQL-only output (e.g. Atlas external_schema).
process.env.DOTENV_CONFIG_QUIET ??= "true";

config();

export default {
	schema: "./lib/db/schema.ts",
	out: "./drizzle",
	dialect: "postgresql",
	dbCredentials: {
		url: process.env.DATABASE_URL || "postgres://localhost:5432/workflow",
	},
} satisfies Config;
