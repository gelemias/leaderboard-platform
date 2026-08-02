import { beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { INITIAL_SCHEMA_SQL } from "../src/db/schema";

beforeAll(async () => {
	const statements = INITIAL_SCHEMA_SQL.split(";")
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);
	await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
});
