import { Kysely } from 'kysely';
import logger from 'logging';

export async function up(db: Kysely<any>): Promise<void> {
	logger.info(`[database] [migration-7] Renaming worker enabled state to job acceptance state.`);

	await db.schema
		.alterTable('worker_auth_tokens')
		.renameColumn('is_enabled', 'accepts_jobs')
		.execute();
}

export async function down(db: Kysely<any>): Promise<void> {
	logger.info(`[database] [migration-7] Restoring worker token enabled state column name.`);

	await db.schema
		.alterTable('worker_auth_tokens')
		.renameColumn('accepts_jobs', 'is_enabled')
		.execute();
}
