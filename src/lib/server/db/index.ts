import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '$env/dynamic/private';

const connectionString = env.DATABASE_URL;

if (!connectionString) {
	console.warn('[DB] DATABASE_URL not set — database queries will fail');
}

const client = connectionString
	? postgres(connectionString, { max: 10 })
	: (null as unknown as ReturnType<typeof postgres>);

export const sql = client;
export const db = client ? drizzle(client) : (null as unknown as ReturnType<typeof drizzle>);
