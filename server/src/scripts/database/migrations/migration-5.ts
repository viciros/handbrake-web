import { Kysely } from 'kysely';
import logger from 'logging';

export async function up(db: Kysely<any>): Promise<void> {
	logger.info(`[database] [migration-5] Adding worker auth token storage.`);

	await db.schema
		.createTable('worker_auth_tokens')
		.ifNotExists()
		.addColumn('worker_id', 'text', (col) => col.notNull().primaryKey())
		.addColumn('token_hash', 'text', (col) => col.notNull())
		.addColumn('created_at', 'integer', (col) => col.notNull())
		.addColumn('updated_at', 'integer', (col) => col.notNull())
		.addColumn('last_used_at', 'integer')
		.execute();
}

export async function down(db: Kysely<any>): Promise<void> {
	logger.info(`[database] [migration-5] Removing worker auth token storage.`);

	await db.schema.dropTable('worker_auth_tokens').ifExists().execute();
}
