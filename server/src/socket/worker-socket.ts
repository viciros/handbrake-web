import { FormatLogError } from '@handbrake-web/shared/logger';
import type { UpdateJobStatusType } from '@handbrake-web/shared/types/database';
import { type HandbrakePresetType } from '@handbrake-web/shared/types/preset';
import { QueueStatus } from '@handbrake-web/shared/types/queue';
import { IsActiveTranscodeStage, TranscodeStage } from '@handbrake-web/shared/types/transcode';
import type {
	WorkerJobData,
	WorkerTransferLease,
	WorkerTransferPurpose,
} from '@handbrake-web/shared/types/worker-transfer';
import type { WorkerProperties } from '@handbrake-web/shared/types/worker';
import logger, { logPath, WriteWorkerLogToFile } from 'logging';
import path from 'path';
import { AuthenticateWorkerSocket } from 'scripts/auth';
import { AddWorker, HasWorkerWithID, RemoveWorker } from 'scripts/connections';
import {
	DatabaseEnsureJobStatusByID,
	DatabaseGetJobStatusByIDOrUndefined,
	DatabaseGetSimpleJobByID,
	DatabaseUpdateJobOrderIndex,
	DatabaseUpdateJobStatus,
} from 'scripts/database/database-queue';
import { GetDefaultPresetByName, GetPresetByName } from 'scripts/presets';
import { AddWorkerProperties, RemoveWorkerProperties } from 'scripts/properties';
import {
	GetBusyWorkers,
	GetQueue,
	SetQueueStatus,
	StopJob,
	UpdateQueue,
	WorkerForAvailableJobs,
} from 'scripts/queue';
import {
	ClearCompletedWorkerOutputTransfer,
	CreateWorkerTransferLease,
	HasCompletedWorkerOutputTransfer,
} from 'scripts/worker-transfers';
import { Server } from 'socket.io';

const workerAckTimeoutMs = 15000;
const workerTerminalStages = [
	TranscodeStage.Error,
	TranscodeStage.Finished,
	TranscodeStage.Stopped,
];

export default function WorkerSocket(io: Server) {
	const namespace = io.of('/worker');
	namespace.use(AuthenticateWorkerSocket);

	namespace.on('connection', async (socket) => {
		const workerID = socket.handshake.query['workerID'] as string;

		if (HasWorkerWithID(workerID)) {
			logger.warn(
				`[socket] [warn] Rejected duplicate worker connection for worker ID '${workerID}' with socket ID '${socket.id}'.`
			);
			socket.disconnect(true);
			return;
		}

		logger.info(`[socket] Worker '${workerID}' has connected with ID '${socket.id}'.`);

		let didCleanup = false;
		const cleanupWorker = async (reason: string, details?: unknown) => {
			if (didCleanup) return;
			didCleanup = true;

			logger.info(
				`[socket] Worker '${workerID}' with ID '${socket.id}' has disconnected with reason '${reason}'.`
			);
			if (details) {
				logger.info(details);
			}

			RemoveWorker(socket);
			RemoveWorkerProperties(workerID);

			const queue = await GetQueue();
			const workersJob = queue.find(
				(job) =>
					job.worker_id == workerID && IsActiveTranscodeStage(job.transcode_stage)
			);
			if (workersJob) {
				logger.info(
					`[socket] Disconnected worker '${workerID}' was working on job '${workersJob.job_id}' when disconnected - setting job to 'unknown'.`
				);
				await DatabaseUpdateJobStatus(workersJob.job_id, {
					transcode_stage: TranscodeStage.Unknown,
				});
				await UpdateQueue();
			}
		};

		socket.on('disconnect', cleanupWorker);
		AddWorker(socket);

		const stopStaleWorkerJob = async (jobID: number) => {
			try {
				await socket.timeout(workerAckTimeoutMs).emitWithAck('stop-transcode', jobID);
				return true;
			} catch (err) {
				logger.error(
					`[socket] [error] Worker '${workerID}' did not acknowledge stop-transcode for stale job '${jobID}'.`
				);
				logger.error(err);
				return false;
			}
		};

		const getOwnedJobStatus = async (jobID: number, eventName: string) => {
			const status = await DatabaseGetJobStatusByIDOrUndefined(jobID);
			if (!status) {
				logger.warn(
					`[socket] [warn] Ignoring '${eventName}' from worker '${workerID}' for unknown job '${jobID}'.`
				);
				return undefined;
			}

			if (status.worker_id != workerID) {
				logger.warn(
					`[socket] [warn] Ignoring '${eventName}' from worker '${workerID}' for job '${jobID}' assigned to '${status.worker_id}'.`
				);
				return undefined;
			}

			return status;
		};

		try {
			logger.info(`[socket] Getting worker '${workerID}' properties...`);
			const properties: WorkerProperties = await socket
				.timeout(workerAckTimeoutMs)
				.emitWithAck('get-properties');
			AddWorkerProperties(workerID, properties);
			logger.info(`[socket] Worker properties = ${JSON.stringify(properties, null, 2)}`);

			logger.info(`[socket] Checking worker '${workerID}' for an existing job in progress...`);
			const existingJobID: number | null = await socket
				.timeout(workerAckTimeoutMs)
				.emitWithAck('check-for-existing-job');
			let workerCanTakeNewJob = false;

			if (existingJobID) {
				logger.info(`[socket] Worker '${workerID}' is busy with job '${existingJobID}'.`);

				const workerJob = await DatabaseEnsureJobStatusByID(existingJobID);

				if (!workerJob) {
					logger.warn(
						`[socket] [warn] Worker '${workerID}' reported job '${existingJobID}', but that job no longer exists in the server database. Stopping the worker's stale transcode state.`
					);
					workerCanTakeNewJob = await stopStaleWorkerJob(existingJobID);
				} else if (workerJob.worker_id != workerID) {
					logger.warn(
						`[socket] [warn] Worker '${workerID}' reported job '${existingJobID}', but the server has that job assigned to '${workerJob.worker_id}'. Stopping the worker's stale transcode state.`
					);
					workerCanTakeNewJob = await stopStaleWorkerJob(existingJobID);
				} else if (!IsActiveTranscodeStage(workerJob.transcode_stage)) {
					logger.warn(
						`[socket] [warn] The server's information about job '${workerJob.job_id}' is out of date. Setting the job's state to 'Unknown' until we hear back from the worker again.`
					);
					await DatabaseUpdateJobStatus(existingJobID, {
						transcode_stage: TranscodeStage.Unknown,
					});
					await UpdateQueue();
				}
			} else {
				logger.info(`[socket] Worker '${workerID}' is not busy with an existing job.`);
				workerCanTakeNewJob = true;
			}

			if (workerCanTakeNewJob) {
				await WorkerForAvailableJobs(workerID);
			}
		} catch (err) {
			logger.error(`[socket] [error] Worker '${workerID}' failed connection initialization.`);
			logger.error(err);
			await cleanupWorker('initialization error');
			socket.disconnect(true);
			return;
		}

		socket.on(
			'get-job-data',
			async (jobID: number, callback: (jobData: WorkerJobData | undefined) => void) => {
				if (!(await getOwnedJobStatus(jobID, 'get-job-data'))) {
					callback(undefined);
					return;
				}

				const jobData = await DatabaseGetSimpleJobByID(jobID);
				callback({
					job_id: jobData.job_id,
					preset_category: jobData.preset_category,
					preset_id: jobData.preset_id,
					input_name: path.basename(jobData.input_path),
					output_name: path.basename(jobData.output_path),
				});
			}
		);

		socket.on(
			'get-transfer-lease',
			async (
				jobID: number,
				purpose: WorkerTransferPurpose,
				callback: (lease: WorkerTransferLease | undefined) => void
			) => {
				if (purpose != 'input' && purpose != 'output') {
					logger.warn(
						`[socket] [warn] Worker '${workerID}' requested an invalid transfer purpose '${purpose}'.`
					);
					callback(undefined);
					return;
				}

				if (!(await getOwnedJobStatus(jobID, 'get-transfer-lease'))) {
					callback(undefined);
					return;
				}

				let lease: WorkerTransferLease;
				try {
					lease = await CreateWorkerTransferLease(workerID, jobID, purpose);
				} catch (err) {
					logger.error(
						`[socket] [error] Could not create '${purpose}' transfer lease for job '${jobID}'.`
					);
					logger.error(FormatLogError(err));
					callback(undefined);
					return;
				}

				callback(lease);
			}
		);

		socket.on(
			'get-preset-data',
			(
				presetCategory: string,
				presetID: string,
				callback: (presetData: HandbrakePresetType | undefined) => void
			) => {
				const isDefaultPreset = presetCategory.match(/^Default:\s/);
				const jobData = isDefaultPreset
					? GetDefaultPresetByName(presetCategory.replace(/Default:\s/, ''), presetID)
					: GetPresetByName(presetCategory, presetID);
				callback(jobData);
			}
		);

		socket.on('transcode-stopped', async (job_id: number, callback: () => void) => {
			if (!(await getOwnedJobStatus(job_id, 'transcode-stopped'))) {
				callback();
				return;
			}
			ClearCompletedWorkerOutputTransfer(job_id);

			logger.info(
				`[socket] Worker '${workerID}' with ID '${socket.id}' has stopped transcoding.`
			);

			// await StopJob(job_id);
			await DatabaseUpdateJobOrderIndex(job_id, 0);
			await DatabaseUpdateJobStatus(job_id, {
				worker_id: null,
				transcode_stage: TranscodeStage.Stopped,
				transcode_percentage: 0,
				transcode_eta: 0,
				transcode_fps_current: 0,
				transcode_fps_average: 0,
				time_started: 0,
				time_finished: 0,
			});
			await UpdateQueue();
			if ((await GetBusyWorkers()).length == 0) {
				await SetQueueStatus(QueueStatus.Idle);
				logger.info("[queue] There are no active workers, setting queue to 'Idle'.");
			}

			callback();
		});

		socket.on('transcode-update', async (job_id: number, status: UpdateJobStatusType) => {
			if (!(await getOwnedJobStatus(job_id, 'transcode-update'))) return;

			const { worker_id: _workerID, ...safeStatus } = status;
			if (
				safeStatus.transcode_stage != undefined &&
				workerTerminalStages.includes(safeStatus.transcode_stage)
			) {
				delete safeStatus.transcode_stage;
			}
			await DatabaseUpdateJobStatus(job_id, safeStatus);
			await UpdateQueue();
		});

		socket.on('transcode-error', async (job_id: number) => {
			if (!(await getOwnedJobStatus(job_id, 'transcode-error'))) return;
			ClearCompletedWorkerOutputTransfer(job_id);

			logger.error(
				`[socket] An error has occurred with job '${job_id}'. The job will be stopped and it's state set to 'Error'.`
			);

			await StopJob(job_id, true);
		});

		socket.on('transcode-finished', async (job_id: number, status: UpdateJobStatusType) => {
			if (!(await getOwnedJobStatus(job_id, 'transcode-finished'))) return;

			if (!(await HasCompletedWorkerOutputTransfer(workerID, job_id))) {
				logger.error(
					`[socket] [error] Worker '${workerID}' reported job '${job_id}' finished before the output upload was verified.`
				);
				await StopJob(job_id, true);
				return;
			}

			const { worker_id: _workerID, ...safeStatus } = status;
			await DatabaseUpdateJobStatus(job_id, { ...safeStatus, worker_id: workerID });
			await DatabaseUpdateJobOrderIndex(job_id, 0);
			ClearCompletedWorkerOutputTransfer(job_id);
			await UpdateQueue();
			await WorkerForAvailableJobs(workerID);
		});

		socket.on('send-log', async (logName: string, logContents: string) => {
			logger.info(
				`[socket] Worker '${workerID}' has sent the log '${logName}' to be saved to '${logPath}'.`
			);
			await WriteWorkerLogToFile(workerID, logName, logContents);
		});
	});
}
