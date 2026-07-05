import type { CreateConsoleLogger } from '@handbrake-web/shared/logger';
import { mkdir, stat } from 'fs/promises';

export const getDataPath = () => process.env.DATA_PATH || '/tmp/handbrake-web';

export async function InitializeDataPath(logger: ReturnType<typeof CreateConsoleLogger>) {
	const dataPath = getDataPath();

	try {
		const dataPathStats = await stat(dataPath);
		if (!dataPathStats.isDirectory()) {
			throw new Error(`The data path '${dataPath}' exists, but it is not a directory.`);
		}

		logger.info(`Using existing data directory '${dataPath}'.`);
	} catch (err) {
		const code =
			err && typeof err == 'object' && 'code' in err
				? (err as { code?: string }).code
				: undefined;
		if (code != 'ENOENT') {
			logger.error(`[error] The data path '${dataPath}' is not usable.`);
			throw err;
		}

		try {
			logger.info(`Creating the data directory at '${dataPath}'.`);
			await mkdir(dataPath, { recursive: true });
		} catch (err) {
			logger.error(`[error] Could not create the data directory at '${dataPath}'.`);
			throw err;
		}
	}
}
