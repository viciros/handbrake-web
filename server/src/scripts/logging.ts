import { CreateRotatingFileLogger } from '@handbrake-web/shared/logger';
import { createWriteStream } from 'fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'path';
import { cwd } from 'process';
import { Transform, type Readable, type TransformCallback } from 'stream';
import { pipeline } from 'stream/promises';
import { IsSubPath, SanitizePathSegment } from './path-safety';

export const logPath = path.join(process.env.DATA_PATH || path.join(cwd(), '../data'), 'log');

const logger = CreateRotatingFileLogger('server', 'server', logPath);
const defaultMaxWorkerLogBytes = 10 * 1024 * 1024;

export default logger;

export class WorkerLogTooLargeError extends Error {}

export class WorkerLogByteLimitTransform extends Transform {
	private bytesSeen = 0;

	constructor(private readonly maxBytes: number) {
		super();
	}

	_transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
		this.bytesSeen += chunk.length;
		if (this.bytesSeen > this.maxBytes) {
			callback(new WorkerLogTooLargeError('Worker log is larger than the allowed limit.'));
			return;
		}

		callback(null, chunk);
	}
}

const getMaxWorkerLogBytes = () => {
	const parsedMaxBytes = Number.parseInt(
		process.env.HANDBRAKE_MAX_WORKER_LOG_BYTES || String(defaultMaxWorkerLogBytes),
		10
	);

	return Number.isSafeInteger(parsedMaxBytes) && parsedMaxBytes > 0
		? parsedMaxBytes
		: defaultMaxWorkerLogBytes;
};

const getJobLogMatch = (jobID: number) => `job-${jobID}.log`;

const getWorkerLogPath = (workerID: string, logName: string) => {
	const safeLogName = SanitizePathSegment(path.basename(logName));
	const safeWorkerID = SanitizePathSegment(workerID);
	const nonce = randomBytes(8).toString('hex');
	const serverLogName = `${safeWorkerID}-${Date.now()}-${nonce}-${safeLogName}`;
	const newLogPath = path.resolve(logPath, serverLogName);
	if (!IsSubPath(logPath, newLogPath)) {
		throw new Error(`Worker log path '${newLogPath}' escapes '${logPath}'.`);
	}

	return newLogPath;
};

const getMatchingJobLogs = async (jobID: number) => {
	const logs = await readdir(logPath);
	const matchingLogNames = logs.filter((log) => log.endsWith(getJobLogMatch(jobID)));
	const matchingLogs = await Promise.all(
		matchingLogNames.map(async (logName) => {
			const currentLogPath = path.join(logPath, logName);

			try {
				const currentLogStats = await stat(currentLogPath);
				if (!currentLogStats.isFile()) return undefined;

				return {
					path: currentLogPath,
					mtimeMs: currentLogStats.mtimeMs,
				};
			} catch {
				return undefined;
			}
		})
	);

	return matchingLogs.filter(
		(log): log is { path: string; mtimeMs: number } => log != undefined
	);
};

export function ValidateWorkerLogUploadContentLength(
	contentLength: number | null | undefined,
	maxBytes = getMaxWorkerLogBytes()
) {
	if (contentLength === undefined) {
		return { ok: false as const, status: 411, message: 'Missing Content-Length.' };
	}
	if (contentLength === null) {
		return { ok: false as const, status: 400, message: 'Invalid Content-Length.' };
	}
	if (contentLength > maxBytes) {
		return {
			ok: false as const,
			status: 413,
			message: 'Worker log is larger than the allowed limit.',
		};
	}

	return { ok: true as const, contentLength };
}

export async function WriteWorkerLogToFile(workerID: string, logName: string, logContents: string) {
	try {
		const maxLogSizeBytes = getMaxWorkerLogBytes();
		const logSizeBytes = Buffer.byteLength(logContents, 'utf-8');

		if (logSizeBytes > maxLogSizeBytes) {
			throw new Error(`Worker log '${logName}' is ${logSizeBytes} bytes, above the limit.`);
		}

		await mkdir(logPath, { recursive: true });
		const newLogPath = getWorkerLogPath(workerID, logName);
		await writeFile(newLogPath, logContents, { flag: 'wx' });
		logger.info(
			`[log] Log file from worker '${workerID}' has been written to '${newLogPath}'.`
		);
	} catch (error) {
		logger.error(`[log] Could not write log to file at '${logPath}'.`);
		console.error(error);
	}
}

export async function WriteWorkerLogStreamToFile(
	workerID: string,
	logName: string,
	source: Readable,
	maxLogSizeBytes = getMaxWorkerLogBytes()
) {
	await mkdir(logPath, { recursive: true });
	const newLogPath = getWorkerLogPath(workerID, logName);
	const tempLogPath = `${newLogPath}.uploading-${randomBytes(8).toString('hex')}`;

	try {
		await pipeline(
			source,
			new WorkerLogByteLimitTransform(maxLogSizeBytes),
			createWriteStream(tempLogPath, { flags: 'wx' })
		);
		await rename(tempLogPath, newLogPath);
		logger.info(`[log] Log file from worker '${workerID}' has been written to '${newLogPath}'.`);
		return newLogPath;
	} catch (error) {
		await rm(tempLogPath, { force: true });
		throw error;
	}
}

export async function GetJobLogByID(jobID: number) {
	try {
		const logs = await getMatchingJobLogs(jobID);
		const newestLog = logs.sort(
			(logA, logB) => logB.mtimeMs - logA.mtimeMs || logB.path.localeCompare(logA.path)
		)[0];

		return newestLog?.path;
	} catch (error) {
		logger.error(`[log] Could not get a log for the job with ID '${jobID}'.`);
		console.error(error);
	}
}

export async function RemoveJobLogByID(jobID: number) {
	try {
		const logs = await getMatchingJobLogs(jobID);
		await Promise.all(
			logs.map(async (log) => {
				await rm(log.path, { force: true });
				logger.info(`[log] Removing a log for job '${jobID}' at '${log.path}'.`);
			})
		);
	} catch (error) {
		logger.error(`[log] Could not remove a log for the job with ID '${jobID}'.`);
		console.error(error);
	}
}
