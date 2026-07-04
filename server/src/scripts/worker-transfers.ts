import type {
	WorkerTransferLease,
	WorkerTransferPurpose,
} from '@handbrake-web/shared/types/worker-transfer';
import type { Express, Request, Response } from 'express';
import { createReadStream, createWriteStream } from 'fs';
import { rename, rm, stat } from 'fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'path';
import { Transform, type TransformCallback } from 'stream';
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
const outputLeaseTokensByJob = new Map<number, string>();
const outputUploadsInProgress = new Set<number>();
const completedOutputTransfers = new Map<number, { workerID: string; outputPath: string }>();

export class UploadTooLargeError extends Error {}

export class ByteLimitTransform extends Transform {
	private bytesSeen = 0;

	constructor(private readonly maxBytes: number) {
		super();
	}

	_transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
		this.bytesSeen += chunk.length;
		if (this.bytesSeen > this.maxBytes) {
			callback(new UploadTooLargeError('Output upload is larger than the job input.'));
			return;
		}

		callback(null, chunk);
	}
}

const deleteExpiredTransferLeases = () => {
	const now = Date.now();

	for (const [token, lease] of transferLeases.entries()) {
		if (lease.expiresAt <= now) {
			transferLeases.delete(token);
			if (
				lease.purpose == 'output' &&
				outputLeaseTokensByJob.get(lease.jobID) == token
			) {
				outputLeaseTokensByJob.delete(lease.jobID);
			}
		}
	}
};

const deleteTransferLease = (token: string, lease: TransferLeaseRecord) => {
	transferLeases.delete(token);
	if (lease.purpose == 'output' && outputLeaseTokensByJob.get(lease.jobID) == token) {
		outputLeaseTokensByJob.delete(lease.jobID);
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

	if (!lease || lease.expiresAt <= Date.now()) {
		res.status(401).send('Invalid transfer token.');
		return undefined;
	}
	deleteTransferLease(token, lease);

	if (lease.jobID != jobID || lease.purpose != expectedPurpose) {
		res.status(403).send('Transfer token does not match this request.');
		return undefined;
	}

	const status = await DatabaseGetJobStatusByIDOrUndefined(jobID);
	if (!status || status.worker_id != lease.workerID) {
		res.status(403).send('Worker no longer owns this job.');
		return undefined;
	}

	return { job: await DatabaseGetSimpleJobByID(jobID), lease };
};

const getRequestContentLength = (req: Request) => {
	const value = req.header('content-length');
	if (!value) return undefined;
	if (!/^\d+$/.test(value)) return null;

	const contentLength = Number(value);
	if (!Number.isSafeInteger(contentLength) || contentLength < 0) return null;

	return contentLength;
};

export function ValidateOutputUploadContentLength(
	contentLength: number | null | undefined,
	maxBytes: number
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
			message: 'Output upload is larger than the job input.',
		};
	}

	return { ok: true as const, contentLength };
}

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
		if (outputLeaseTokensByJob.has(jobID) || outputUploadsInProgress.has(jobID)) {
			throw new Error(`Job '${jobID}' already has an active output transfer.`);
		}
	}

	const token = randomBytes(32).toString('base64url');
	const expiresAt = Date.now() + transferLeaseLifetimeMs;
	transferLeases.set(token, { workerID, jobID, purpose, expiresAt });
	if (purpose == 'output') {
		outputLeaseTokensByJob.set(jobID, token);
		completedOutputTransfers.delete(jobID);
	}

	return {
		path: getTransferPath(jobID, purpose),
		token,
		purpose,
		expiresAt,
		contentLength,
	};
}

export async function HasCompletedWorkerOutputTransfer(workerID: string, jobID: number) {
	const completedTransfer = completedOutputTransfers.get(jobID);
	if (!completedTransfer || completedTransfer.workerID != workerID) return false;

	try {
		const outputPath = await AssertOutputPathInMediaRoots(
			completedTransfer.outputPath,
			'job output'
		);
		const outputStats = await stat(outputPath);
		return outputStats.isFile();
	} catch {
		return false;
	}
}

export function ClearCompletedWorkerOutputTransfer(jobID: number) {
	completedOutputTransfers.delete(jobID);
}

export function RegisterWorkerTransferRoutes(app: Express) {
	app.get('/worker/transfers/jobs/:jobID/input', async (req, res) => {
		req.setTimeout(0);
		res.setTimeout(0);

		try {
			const transfer = await getTransferJob(req, res, 'input');
			if (!transfer) return;
			const { job } = transfer;

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
		let jobID: number | undefined;

		try {
			const transfer = await getTransferJob(req, res, 'output');
			if (!transfer) return;
			const { job, lease } = transfer;
			jobID = job.job_id;
			if (outputUploadsInProgress.has(job.job_id)) {
				res.status(409).send('An output upload is already in progress for this job.');
				return;
			}
			outputUploadsInProgress.add(job.job_id);

			const inputPath = await AssertExistingPathInMediaRoots(job.input_path, 'job input');
			const inputStats = await stat(inputPath);
			if (!inputStats.isFile()) {
				res.status(400).send('Job input is not a file.');
				return;
			}
			const contentLengthResult = ValidateOutputUploadContentLength(
				getRequestContentLength(req),
				inputStats.size
			);
			if (!contentLengthResult.ok) {
				res.status(contentLengthResult.status).send(contentLengthResult.message);
				return;
			}

			const outputPath = await AssertOutputPathInMediaRoots(job.output_path, 'job output');
			tempOutputPath = getUploadTempPath(outputPath, job.job_id);

			await pipeline(
				req,
				new ByteLimitTransform(inputStats.size),
				createWriteStream(tempOutputPath, { flags: 'wx' })
			);
			await rename(tempOutputPath, outputPath);
			completedOutputTransfers.set(job.job_id, {
				workerID: lease.workerID,
				outputPath,
			});
			tempOutputPath = undefined;
			res.status(204).end();
		} catch (err) {
			logger.error('[transfer] [error] Could not receive job output from worker.');
			logger.error(err);

			if (tempOutputPath) {
				await rm(tempOutputPath, { force: true });
			}

			if (!res.headersSent) {
				if (err instanceof UploadTooLargeError) {
					res.status(413).send('Output upload is larger than the job input.');
				} else {
					res.status(500).send('Could not receive job output.');
				}
			}
		} finally {
			if (jobID != undefined) {
				outputUploadsInProgress.delete(jobID);
			}
		}
	});
}
