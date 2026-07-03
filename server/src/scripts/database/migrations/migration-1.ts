import { Kysely } from 'kysely';
import logger from 'logging';

export async function up(db: Kysely<any>): Promise<void> {
	logger.info(
		`[database] [migration-1] Dropping old manual migration table 'database_version' if it exists.`
	);

	await db.schema.dropTable('database_version').ifExists().execute();
}

export async function down(db: Kysely<any>): Promise<void> {
	// Migration code
}
