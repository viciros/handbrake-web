import { FormatLogError } from '@handbrake-web/shared/logger';
import type { Express, Request } from 'express';
import logger, {
	ValidateWorkerLogUploadContentLength,
	WorkerLogTooLargeError,
	WriteWorkerLogStreamToFile,
} from 'logging';
import { RequireWorkerHttpAuth } from './auth';

const getRequestContentLength = (req: Request) => {
	const value = req.header('content-length');
	if (!value) return undefined;
	if (!/^\d+$/.test(value)) return null;

	const contentLength = Number(value);
	if (!Number.isSafeInteger(contentLength) || contentLength < 0) return null;

	return contentLength;
};

export function RegisterWorkerLogRoutes(app: Express) {
	app.post('/worker/logs', RequireWorkerHttpAuth, async (req, res) => {
		req.setTimeout(0);
		res.setTimeout(0);

		const workerID = String(res.locals.workerID ?? 'unknown');
		const logName = req.header('x-log-name');
		if (!logName) {
			logger.warn(
				`[log] [warn] Rejecting worker log upload from '${workerID}': missing log name.`
			);
			res.status(400).send('Missing log name.');
			return;
		}

		const contentLengthResult = ValidateWorkerLogUploadContentLength(
			getRequestContentLength(req)
		);
		if (!contentLengthResult.ok) {
			logger.warn(
				`[log] [warn] Rejecting worker log upload '${logName}' from '${workerID}': ${contentLengthResult.message}`
			);
			res.status(contentLengthResult.status).send(contentLengthResult.message);
			return;
		}

		try {
			logger.info(`[log] Receiving worker log '${logName}' from '${workerID}'.`);
			await WriteWorkerLogStreamToFile(workerID, logName, req);
			res.status(204).end();
		} catch (err) {
			logger.error(`[log] [error] Could not receive worker log '${logName}' from '${workerID}'.`);
			logger.error(FormatLogError(err));

			if (!res.headersSent) {
				if (err instanceof WorkerLogTooLargeError) {
					res.status(413).send('Worker log is larger than the allowed limit.');
				} else {
					res.status(500).send('Could not receive worker log.');
				}
			}
		}
	});
}
