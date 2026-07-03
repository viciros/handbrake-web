import { Kysely, sql } from 'kysely';
import logger from 'logging';

export async function up(db: Kysely<any>): Promise<void> {
	logger.info(
		`[database] [migration-3] Deduplicating job side tables and adding job_id uniqueness.`
	);

	await sql`
		DELETE FROM jobs_status
		WHERE rowid NOT IN (
			SELECT MAX(rowid)
			FROM jobs_status
			GROUP BY job_id
		);
	`.execute(db);

	await sql`
		DELETE FROM jobs_order
		WHERE rowid NOT IN (
			SELECT MAX(rowid)
			FROM jobs_order
			GROUP BY job_id
		);
	`.execute(db);

	await db.schema
		.createIndex('jobs_status_job_id_unique')
		.ifNotExists()
		.on('jobs_status')
		.column('job_id')
		.unique()
		.execute();

	await db.schema
		.createIndex('jobs_order_job_id_unique')
		.ifNotExists()
		.on('jobs_order')
		.column('job_id')
		.unique()
		.execute();
}

export async function down(db: Kysely<any>): Promise<void> {
	logger.info(`[database] [migration-3] Removing job_id uniqueness indexes.`);

	await db.schema.dropIndex('jobs_status_job_id_unique').ifExists().execute();
	await db.schema.dropIndex('jobs_order_job_id_unique').ifExists().execute();
}
