import type {
	WorkerTransferLease,
	WorkerTransferPurpose,
} from '@handbrake-web/shared/types/worker-transfer';
import type { Express, Request, Response } from 'express';
import { createReadStream, createWriteStream } from 'fs';
import { rename, rm, stat } from 'fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'path';
import { pipeline } from 'stream/promises';

import logger from 'logging';
import {
	DatabaseGetJobStatusByIDOrUndefined,
	DatabaseGetSimpleJobByID,
} from './database/database-queue';
import { AssertExistingPathInMediaRoots, AssertOutputPathInMediaRoots } from './path-safety';

type TransferLeaseRecord = {
	workerID: string;
	jobID: number;
	purpose: WorkerTransferPurpose;
	expiresAt: number;
};

const transferLeaseLifetimeMs = 10 * 60 * 1000;
const transferLeases = new Map<string, TransferLeaseRecord>();

const deleteExpiredTransferLeases = () => {
	const now = Date.now();

	for (const [token, lease] of transferLeases.entries()) {
		if (lease.expiresAt <= now) {
			transferLeases.delete(token);
		}
	}
};

const getTransferPath = (jobID: number, purpose: WorkerTransferPurpose) =>
	`/worker/transfers/jobs/${jobID}/${purpose}`;

const getUploadTempPath = (outputPath: string, jobID: number) => {
	const parsedOutput = path.parse(outputPath);
	const nonce = randomBytes(8).toString('hex');

	return path.join(
		parsedOutput.dir,
		`${parsedOutput.name}.uploading-${jobID}-${nonce}${parsedOutput.ext}`
	);
};

const getBearerToken = (req: Request) => {
	const authHeader = req.header('authorization');
	const match = authHeader?.match(/^Bearer\s+(.+)$/i);

	return match?.[1];
};

const getTransferJob = async (
	req: Request,
	res: Response,
	expectedPurpose: WorkerTransferPurpose
) => {
	deleteExpiredTransferLeases();

	const jobID = Number.parseInt(String(req.params.jobID), 10);
	if (!Number.isInteger(jobID)) {
		res.status(400).send('Invalid job ID.');
		return undefined;
	}

	const token = getBearerToken(req);
	if (!token) {
		res.status(401).send('Missing transfer token.');
		return undefined;
	}

	const lease = transferLeases.get(token);
	transferLeases.delete(token);

	if (!lease || lease.expiresAt <= Date.now()) {
		res.status(401).send('Invalid transfer token.');
		return undefined;
	}

	if (lease.jobID != jobID || lease.purpose != expectedPurpose) {
		res.status(403).send('Transfer token does not match this request.');
		return undefined;
	}

	const status = await DatabaseGetJobStatusByIDOrUndefined(jobID);
	if (!status || status.worker_id != lease.workerID) {
		res.status(403).send('Worker no longer owns this job.');
		return undefined;
	}

	return await DatabaseGetSimpleJobByID(jobID);
};

export async function CreateWorkerTransferLease(
	workerID: string,
	jobID: number,
	purpose: WorkerTransferPurpose
): Promise<WorkerTransferLease> {
	deleteExpiredTransferLeases();

	const status = await DatabaseGetJobStatusByIDOrUndefined(jobID);
	if (!status || status.worker_id != workerID) {
		throw new Error(`Worker '${workerID}' does not own job '${jobID}'.`);
	}

	const job = await DatabaseGetSimpleJobByID(jobID);
	let contentLength: number | undefined;

	if (purpose == 'input') {
		const inputPath = await AssertExistingPathInMediaRoots(job.input_path, 'job input');
		contentLength = (await stat(inputPath)).size;
	} else {
		await AssertOutputPathInMediaRoots(job.output_path, 'job output');
	}

	const token = randomBytes(32).toString('base64url');
	const expiresAt = Date.now() + transferLeaseLifetimeMs;
	transferLeases.set(token, { workerID, jobID, purpose, expiresAt });

	return {
		path: getTransferPath(jobID, purpose),
		token,
		purpose,
		expiresAt,
		contentLength,
	};
}

export function RegisterWorkerTransferRoutes(app: Express) {
	app.get('/worker/transfers/jobs/:jobID/input', async (req, res) => {
		req.setTimeout(0);
		res.setTimeout(0);

		try {
			const job = await getTransferJob(req, res, 'input');
			if (!job) return;

			const inputPath = await AssertExistingPathInMediaRoots(job.input_path, 'job input');
			const inputStats = await stat(inputPath);
			if (!inputStats.isFile()) {
				res.status(400).send('Job input is not a file.');
				return;
			}

			res.setHeader('Content-Type', 'application/octet-stream');
			res.setHeader('Content-Length', inputStats.size.toString());
			await pipeline(createReadStream(inputPath), res);
		} catch (err) {
			logger.error('[transfer] [error] Could not stream job input to worker.');
			logger.error(err);
			if (!res.headersSent) {
				res.status(500).send('Could not stream job input.');
			}
		}
	});

	app.put('/worker/transfers/jobs/:jobID/output', async (req, res) => {
		req.setTimeout(0);
		res.setTimeout(0);

		let tempOutputPath: string | undefined;

		try {
			const job = await getTransferJob(req, res, 'output');
			if (!job) return;

			const outputPath = await AssertOutputPathInMediaRoots(job.output_path, 'job output');
			tempOutputPath = getUploadTempPath(outputPath, job.job_id);

			await pipeline(req, createWriteStream(tempOutputPath, { flags: 'wx' }));
			await rename(tempOutputPath, outputPath);
			tempOutputPath = undefined;
			res.status(204).end();
		} catch (err) {
			logger.error('[transfer] [error] Could not receive job output from worker.');
			logger.error(err);

			if (tempOutputPath) {
				await rm(tempOutputPath, { force: true });
			}

			if (!res.headersSent) {
				res.status(500).send('Could not receive job output.');
			}
		}
	});
}
