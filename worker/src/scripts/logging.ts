import { CreateConsoleLogger, FormatLogError } from '@handbrake-web/shared/logger';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import path from 'path';
import { env } from 'process';

const logger = CreateConsoleLogger(env.WORKER_ID!);
const responseBodyMaxLogLength = 1000;

export default logger;

const truncateForLog = (value: string) =>
	value.length > responseBodyMaxLogLength
		? `${value.slice(0, responseBodyMaxLogLength)}... [truncated]`
		: value;

const getResponseBodyForLog = async (response: Response) => {
	try {
		const responseBody = (await response.text()).trim();
		return responseBody ? truncateForLog(responseBody) : '<empty>';
	} catch (err) {
		return `<could not read response body: ${FormatLogError(err)}>`;
	}
};

export async function SendLogToServer(logPath: string, serverBaseAddress: string) {
	try {
		const logName = path.basename(logPath);
		const logStats = await stat(logPath);
		if (!logStats.isFile()) {
			throw new Error(`Log path '${logPath}' is not a file.`);
		}
		if (!env.WORKER_ID || !env.WORKER_TOKEN) {
			throw new Error('Worker ID or token is not configured.');
		}

		logger.info(`[log] Sending the log '${logName}' to the server.`);
		const response = await fetch(new URL('/worker/logs', serverBaseAddress), {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${env.WORKER_TOKEN}`,
				'Content-Length': logStats.size.toString(),
				'Content-Type': 'text/plain; charset=utf-8',
				'X-Log-Name': logName,
				'X-Worker-ID': env.WORKER_ID,
			},
			body: createReadStream(logPath) as unknown as RequestInit['body'],
			duplex: 'half',
		} as RequestInit & { duplex: 'half' });

		if (!response.ok) {
			const statusText = response.statusText ? ` ${response.statusText}` : '';
			const responseBody = await getResponseBodyForLog(response);
			throw new Error(
				`Log upload failed with HTTP ${response.status}${statusText}. Response body: ${responseBody}`
			);
		}

		logger.info(`[log] Finished sending the log '${logName}' to the server.`);
	} catch (error) {
		logger.error(`[log] Could not read/send the log at '${logPath}' to the server.`);
		logger.error(FormatLogError(error));
	}
}
