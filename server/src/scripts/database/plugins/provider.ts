import type { Migration, MigrationProvider } from 'kysely/migration';

export class CustomMigrationProvider implements MigrationProvider {
	async getMigrations(): Promise<Record<string, Migration>> {
		const migrations: Record<string, Migration> = {
			'migration-1': await import('../migrations/migration-1'),
			'migration-2': await import('../migrations/migration-2'),
			'migration-3': await import('../migrations/migration-3'),
			'migration-4': await import('../migrations/migration-4'),
			'migration-5': await import('../migrations/migration-5'),
			'migration-6': await import('../migrations/migration-6'),
		};

		return migrations;
	}
}
