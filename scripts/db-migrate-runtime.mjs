import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
	console.error('DATABASE_URL is required');
	process.exit(1);
}

const client = postgres(databaseUrl, { max: 1 });

try {
	await migrate(drizzle(client), { migrationsFolder: './drizzle' });
} finally {
	await client.end({ timeout: 5 });
}
