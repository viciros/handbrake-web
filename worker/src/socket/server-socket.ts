import type { WorkerProperties } from '@handbrake-web/shared/types/worker';
import logger from 'logging';
import { GetWorkerProperties } from 'scripts/properties';
import { Socket } from 'socket.io-client';
import {
	currentJobID,
	isStartingTranscode,
	isTranscoding,
	StartTranscode,
	type StartTranscodeResult,
	StopTranscode,
} from '../scripts/transcode';
import { serverAddress } from '../worker-startup';

const workerID = process.env.WORKER_ID;

export default function ServerSocket(server: Socket) {
	server.on('connect', () => {
		logger.info(`[socket] Connected to the server '${serverAddress}' with id '${server.id}'.`);
	});

	server.on('connect_error', (error) => {
		if (server.active) {
			logger.info(`[socket] Connection to server lost, will attempt reconnection...`);
		} else {
			logger.error(`[socket] Connection to server lost, will not attempt reconnection...`);
			logger.error(error);
		}
	});

	server.on('disconnect', (reason, details) => {
		logger.info(`[socket] Disconnected from the server with reason '${reason}'.`);
		if (details) {
			logger.info(details);
		}
	});

	server.on('get-properties', async (callback: (properties: WorkerProperties) => void) => {
		logger.info(`[socket] The server is requesting this worker's properties...`);
		callback(await GetWorkerProperties());
	});

	server.on('check-for-existing-job', (callback: (jobID: number | null) => void) => {
		logger.info(`[socket] The server is requesting the status of this worker...`);
		currentJobID
			? logger.info(
					`[socket] This worker is busy with job '${currentJobID}' - reporting to the server.`
			  )
			: logger.info(
					`[socket] This worker is currently not busy with a job - reporting to the server.`
			  );
		callback(currentJobID);
	});

	server.on(
		'start-transcode',
		async (jobID: number, callback: (result: StartTranscodeResult) => void) => {
			logger.info(`[socket] Request to transcode queue entry '${jobID}'.`);
			if (isTranscoding() || isStartingTranscode()) {
				logger.warn(
					`[socket] [warn] This worker is busy with job '${currentJobID}' - reporting to the server.`
				);
				callback({
					ok: false,
					currentJobID,
					error: 'Worker is already busy.',
				});
			} else {
				logger.info(
					`[socket] This worker is currently not busy with a job - starting work on job '${jobID}'.`
				);
				callback(await StartTranscode(jobID, server));
			}
		}
	);

	server.on('stop-transcode', async (jobID: number, callback?: () => void) => {
		logger.info(`[socket] Request to stop transcoding the current job with id '${jobID}'.`);

		try {
			await StopTranscode(jobID, server);
		} catch (err) {
			logger.error(`[socket] [error] Could not stop transcoding job '${jobID}'.`);
			logger.error(err);
		}

		callback?.();
	});
}
