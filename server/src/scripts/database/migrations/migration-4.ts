import { Kysely } from 'kysely';
import logger from 'logging';

export async function up(db: Kysely<any>): Promise<void> {
	logger.info(`[database] [migration-4] Adding client auth credential storage.`);

	await db.schema
		.createTable('client_auth')
		.ifNotExists()
		.addColumn('id', 'text', (col) => col.notNull().primaryKey())
		.addColumn('username', 'text', (col) => col.notNull())
		.addColumn('password_hash', 'text', (col) => col.notNull())
		.addColumn('must_change_credentials', 'boolean', (col) => col.notNull().defaultTo(true))
		.addColumn('created_at', 'integer', (col) => col.notNull())
		.addColumn('updated_at', 'integer', (col) => col.notNull())
		.execute();
}

export async function down(db: Kysely<any>): Promise<void> {
	logger.info(`[database] [migration-4] Removing client auth credential storage.`);

	await db.schema.dropTable('client_auth').ifExists().execute();
}
