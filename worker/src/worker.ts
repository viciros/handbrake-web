import { CreateConsoleLogger } from '@handbrake-web/shared/logger';
import { CheckDirectoryPermissions } from '@handbrake-web/shared/scripts/permissions';
import { getDataPath, InitializeDataPath } from 'scripts/data';

const workerLogger = CreateConsoleLogger('worker');

async function Worker() {
	// Check critical permissions
	await InitializeDataPath(workerLogger);
	await CheckDirectoryPermissions([getDataPath()], workerLogger);

	// Startup only occurs if the previous functions ever finish
	const startup = await import('./worker-startup');
	await startup.default();
}

void Worker().catch((err) => {
	workerLogger.error(`[startup] [error] Worker startup failed.`);
	workerLogger.error(err);
	process.exitCode = 1;
});
