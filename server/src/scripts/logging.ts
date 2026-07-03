import { CreateRotatingFileLogger } from '@handbrake-web/shared/logger';
import { mkdir, readdir, rm, writeFile } from 'fs/promises';
import path from 'path';
import { cwd } from 'process';
import { IsSubPath, SanitizePathSegment } from './path-safety';

export const logPath = path.join(process.env.DATA_PATH || path.join(cwd(), '../data'), 'log');

const logger = CreateRotatingFileLogger('server', 'server', logPath);

export default logger;

export async function WriteWorkerLogToFile(workerID: string, logName: string, logContents: string) {
	try {
		const maxLogSizeBytes = parseInt(process.env.HANDBRAKE_MAX_WORKER_LOG_BYTES || '10485760');
		const logSizeBytes = Buffer.byteLength(logContents, 'utf-8');

		if (logSizeBytes > maxLogSizeBytes) {
			throw new Error(`Worker log '${logName}' is ${logSizeBytes} bytes, above the limit.`);
		}

		await mkdir(logPath, { recursive: true });

		const safeLogName = SanitizePathSegment(path.basename(logName));
		const newLogPath = path.resolve(logPath, safeLogName);
		if (!IsSubPath(logPath, newLogPath)) {
			throw new Error(`Worker log path '${newLogPath}' escapes '${logPath}'.`);
		}

		await writeFile(newLogPath, logContents);
		logger.info(
			`[log] Log file from worker '${workerID}' has been written to '${newLogPath}'.`
		);
	} catch (error) {
		logger.error(`[log] Could not write log to file at '${logPath}'.`);
		console.error(error);
	}
}

export async function GetJobLogByID(jobID: number) {
	try {
		const logs = await readdir(logPath);
		const log = logs.find((log) => log.includes(`job-${jobID}.log`));
		if (log) {
			return path.join(logPath, log);
		}
	} catch (error) {
		logger.error(`[log] Could not get a log for the job with ID '${jobID}'.`);
		console.error(error);
	}
}

export async function RemoveJobLogByID(jobID: number) {
	try {
		const logs = await readdir(logPath);
		const log = logs.find((log) => log.includes(`job-${jobID}.log`));
		if (log) {
			const newLogPath = path.join(logPath, log);
			await rm(newLogPath);
			logger.info(`[log] Removing a log for job '${jobID}' at '${newLogPath}'.`);
		}
	} catch (error) {
		logger.error(`[log] Could not remove a log for the job with ID '${jobID}'.`);
		console.error(error);
	}
}
