import { Kysely } from 'kysely';
import logger from 'logging';

export async function up(db: Kysely<any>): Promise<void> {
	logger.info(`[database] [migration-6] Adding worker auth token enabled state.`);

	await db.schema
		.alterTable('worker_auth_tokens')
		.addColumn('is_enabled', 'boolean', (col) => col.notNull().defaultTo(true))
		.execute();
}

export async function down(db: Kysely<any>): Promise<void> {
	logger.info(`[database] [migration-6] Removing worker auth token enabled state.`);

	await db.schema.alterTable('worker_auth_tokens').dropColumn('is_enabled').execute();
}
