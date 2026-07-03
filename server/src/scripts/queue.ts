import { QueueStartupBehavior } from '@handbrake-web/shared/types/config';
import type { AddJobType, DetailedJobType } from '@handbrake-web/shared/types/database';
import type { HandbrakePresetDataType } from '@handbrake-web/shared/types/preset';
import { QueueStatus } from '@handbrake-web/shared/types/queue';
import { TranscodeStage } from '@handbrake-web/shared/types/transcode';
import type { WorkerCapabilities } from '@handbrake-web/shared/types/worker';
import logger, { RemoveJobLogByID } from 'logging';
import { Socket as Worker } from 'socket.io';
import { GetConfig } from './config/config';
import {
	EmitToAllClients,
	EmitToWorkerWithID,
	GetWorkerID,
	GetWorkerWithID,
	GetWorkers,
} from './connections';
import {
	DatabaseGetDetailedJobByID,
	DatabaseGetDetailedJobs,
	DatabaseGetSimpleJobByID,
	DatabaseClaimWaitingJob,
	DatabaseInsertJob,
	DatabaseInsertJobOrderByID,
	DatabaseReleaseClaimedJob,
	DatabaseRemoveJobByID,
	DatabaseUpdateJobOrderIndex,
	DatabaseUpdateJobStatus,
} from './database/database-queue';
import { DatabaseSelectStatusByID, DatabaseUpdateStatus } from './database/database-status';
import { GetDefaultPresetByName, GetPresetByName } from './presets';
import { GetWorkerProperties } from './properties';
import { AssertPathInMediaRoots } from './path-safety';

type StartTranscodeAck =
	| number
	| {
			ok: boolean;
			jobID?: number;
			currentJobID?: number | null;
			error?: string;
	  };

const getJobRequiredCapability: (
	encoder: HandbrakePresetDataType['VideoEncoder']
) => keyof WorkerCapabilities = (encoder) => {
	if (encoder.match(/qsv/)) {
		return 'qsv';
	} else if (encoder.match(/nvenc/)) {
		return 'nvenc';
	} else {
		return 'cpu';
	}
};

// Init --------------------------------------------------------------------------------------------
export async function InitializeQueue() {
	// Queue Status
	switch (GetConfig().application['queue-startup-behavior']) {
		case QueueStartupBehavior.Active:
			logger.info(`[server] [queue] Initializating the queue state to 'Active'.`);
			await SetQueueStatus(QueueStatus.Idle);
			break;
		case QueueStartupBehavior.Stopped:
			logger.info(`[server] [queue] Initializating the queue state to 'Stopped'.`);
			await SetQueueStatus(QueueStatus.Stopped);
			break;
		case QueueStartupBehavior.Previous:
		default:
			const status = await GetQueueStatus();
			if (status != null || status != undefined) {
				logger.info(
					`[server] [queue] Existing queue status '${QueueStatus[status]}' retreived from the database.`
				);
				EmitToAllClients('queue-status-update', status);
			} else {
				await SetQueueStatus(QueueStatus.Stopped);
				logger.error(
					`[server] [queue] The queue status does not exist in the database, initializing to the state 'stopped'.`
				);
			}
			break;
	}

	// Queue Data
	const queue = await DatabaseGetDetailedJobs();
	for (const job of queue) {
		if (
			job.worker_id != null ||
			job.transcode_stage == TranscodeStage.Scanning ||
			job.transcode_stage == TranscodeStage.Transcoding
		) {
			await DatabaseUpdateJobStatus(job.job_id, { transcode_stage: TranscodeStage.Unknown });

			logger.info(
				`[server] [queue] Job '${job.job_id}' was loaded from the database in an unfinished state. The job's state will be updated to 'Unknown'.`
			);
		}
	}
	EmitToAllClients('queue-update', queue);
}

export async function GetBusyWorkers() {
	const busyWorkers = [...new Set((await GetQueue()).map((job) => job.worker_id))].filter(
		(value) => value != null
	);

	return busyWorkers;
}

export async function GetAvailableWorkers() {
	const busyWorkers = await GetBusyWorkers();

	const availableWorkers = GetWorkers().filter((worker) => {
		const workerID = GetWorkerID(worker);

		return !busyWorkers.includes(workerID);
	});
	return availableWorkers;
}

export function GetEligibleWorkers(
	availableWorkers: Worker[],
	requiredCapability: keyof WorkerCapabilities
) {
	const eligibleWorkers = availableWorkers.filter((worker) => {
		const workerID = GetWorkerID(worker);
		const workerCapabilities = GetWorkerProperties()[workerID]?.capabilities;
		return workerCapabilities ? workerCapabilities[requiredCapability] : false;
	});

	return eligibleWorkers;
}

export async function GetAvailableJobs() {
	const queue = await DatabaseGetDetailedJobs();
	const availableJobs = queue
		.filter((job) => job.transcode_stage == TranscodeStage.Waiting)
		.sort((jobA, jobB) => jobA.order_index - jobB.order_index);
	return availableJobs;
}

export function GetEligibleJobs(
	availableJobs: DetailedJobType[],
	workerCapabilities: WorkerCapabilities
) {
	const eligibleJobs = availableJobs.filter((job) => {
		const jobPreset = job.preset_category.match(/Default:\s/)
			? GetDefaultPresetByName(job.preset_category.replace(/Default:\s/, ''), job.preset_id)
			: GetPresetByName(job.preset_category, job.preset_id);

		if (!jobPreset?.PresetList?.[0]?.VideoEncoder) return false;

		const requiredCapability = getJobRequiredCapability(jobPreset.PresetList[0].VideoEncoder);

		return workerCapabilities[requiredCapability];
	});

	return eligibleJobs;
}

export async function JobForAvailableWorkers(jobID: number) {
	if ((await GetQueueStatus()) != QueueStatus.Stopped) {
		logger.info(
			`[server] [queue] Job with ID '${jobID}' is available, checking for available workers...`
		);
		const jobInfo = await DatabaseGetSimpleJobByID(jobID);
		const jobPreset = jobInfo.preset_category.match(/Default:\s/)
			? GetDefaultPresetByName(
					jobInfo.preset_category.replace(/Default:\s/, ''),
					jobInfo.preset_id
			  )
			: GetPresetByName(jobInfo.preset_category, jobInfo.preset_id);
		const requiredCapability = getJobRequiredCapability(jobPreset.PresetList[0].VideoEncoder);
		const availableWorkers = await GetAvailableWorkers();
		const eligibleWorkers = GetEligibleWorkers(availableWorkers, requiredCapability);

		if (eligibleWorkers.length > 0) {
			const selectedWorker = eligibleWorkers[0];
			const job = await DatabaseGetDetailedJobByID(jobID);
			const didStart = await StartJob(job, selectedWorker);
			if ((await GetQueueStatus()) != QueueStatus.Active) {
				await SetQueueStatus(didStart ? QueueStatus.Active : QueueStatus.Idle);
			}
			logger.info(
				`[server] [queue] Found worker with ID '${GetWorkerID(
					selectedWorker
				)}' for job with ID '${jobID}'.`
			);
		} else if (availableWorkers.length > 0 && eligibleWorkers.length == 0) {
			logger.info(
				`[queue] There are available workers, but none with the capability '${requiredCapability}' for job with id '${jobID}'.`
			);
		} else {
			logger.info(
				`[server] [queue] There are no workers available for job with ID '${jobID}'.`
			);
		}
	}
}

export async function WorkerForAvailableJobs(workerID: string) {
	if ((await GetQueueStatus()) != QueueStatus.Stopped) {
		logger.info(
			`[server] [queue] Worker with ID '${workerID}' is available, checking for available jobs...`
		);

		const workerCapabilities = GetWorkerProperties()[workerID].capabilities;

		const availableJobs = await GetAvailableJobs();
		const eligibleJobs = GetEligibleJobs(availableJobs, workerCapabilities);

		if (eligibleJobs.length > 0) {
			const worker = GetWorkerWithID(workerID);
			const selectedJob = eligibleJobs[0];
			if (selectedJob && worker) {
				const didStart = await StartJob(selectedJob, worker);
				if ((await GetQueueStatus()) != QueueStatus.Active) {
					await SetQueueStatus(didStart ? QueueStatus.Active : QueueStatus.Idle);
				}
				logger.info(
					`[server] [queue] Found job with ID '${selectedJob.job_id}' for worker with ID '${workerID}'.`
				);
			}
		} else if (availableJobs.length > 0 && eligibleJobs.length == 0) {
			logger.info(
				`[queue] There are available jobs, but none that require the capabilities of worker with ID '${workerID}'.`
			);
			// Set queue to idle if there are no other busy workers
			if ((await GetBusyWorkers()).length == 0) {
				await SetQueueStatus(QueueStatus.Idle);
				logger.info("[queue] There are no active workers, setting queue to 'Idle'.");
			}
		} else {
			logger.info(
				`[server] [queue] There are no jobs available for worker with ID '${workerID}'.`
			);
			// Set queue to idle if there are no other busy workers
			if ((await GetBusyWorkers()).length == 0) {
				await SetQueueStatus(QueueStatus.Idle);
				logger.info("[queue] There are no active workers, setting queue to 'Idle'.");
			}
		}
	}
}

// Status ------------------------------------------------------------------------------------------
export async function GetQueueStatus() {
	const status = await DatabaseSelectStatusByID('queue');
	return status;
}

export async function SetQueueStatus(newState: QueueStatus) {
	await DatabaseUpdateStatus('queue', newState);
	EmitToAllClients('queue-status-update', newState);
}

export async function StartQueue(clientID?: string) {
	const status = await GetQueueStatus();
	if (status == QueueStatus.Stopped) {
		try {
			const availableWorkers = await GetAvailableWorkers();
			const availableJobs = await GetAvailableJobs();

			for (const worker of availableWorkers) {
				const workerID = GetWorkerID(worker);
				const workerCapabilities = GetWorkerProperties()[workerID].capabilities;
				const eligibleJobs = GetEligibleJobs(availableJobs, workerCapabilities);

				logger.info(
					`[queue] There are ${availableJobs.length} available jobs and ${eligibleJobs.length} eligible for '${workerID}'.`
				);

				if (eligibleJobs.length > 0) {
					const selectedJob = eligibleJobs[0];
					logger.info(
						`[queue] Assigning worker with ID '${workerID}' to job with id '${selectedJob.job_id}'.`
					);
					const didStart = await StartJob(selectedJob, worker);

					// Remove job from available jobs for the next iteration
					if (didStart) {
						availableJobs.splice(availableJobs.indexOf(selectedJob), 1);

						await SetQueueStatus(QueueStatus.Active);
					}
				} else if (availableJobs.length > 0 && eligibleJobs.length == 0) {
					logger.info(
						`[queue] There are available jobs, but none that require the capabilities of worker with ID '${workerID}'.`
					);
					if ((await GetBusyWorkers()).length == 0) {
						await SetQueueStatus(QueueStatus.Idle);
						logger.info(
							"[queue] There are no active workers, setting queue to 'Idle'."
						);
					}
				} else {
					logger.info(
						`[server] [queue] There are no jobs available for worker with ID '${workerID}'.`
					);
					// Set queue to idle if there are no other busy workers
					if ((await GetBusyWorkers()).length == 0) {
						await SetQueueStatus(QueueStatus.Idle);
						logger.info(
							"[queue] There are no active workers, setting queue to 'Idle'."
						);
					}
				}
			}
		} catch (err) {
			logger.error(err);
		}
	}
}

export async function StopQueue(clientID?: string) {
	if ((await GetQueueStatus()) != QueueStatus.Stopped) {
		const newStatus = QueueStatus.Stopped;
		await SetQueueStatus(newStatus);

		const stoppedBy = clientID ? `client '${clientID}'` : 'the server.';

		logger.info(`[server] The queue has been stopped by ${stoppedBy}.`);
	}
}

// Queue -------------------------------------------------------------------------------------------
export async function GetQueue() {
	const queue: DetailedJobType[] = await DatabaseGetDetailedJobs();
	return queue;
}

export async function UpdateQueue() {
	const updatedQueue = await DatabaseGetDetailedJobs();
	if (updatedQueue) {
		EmitToAllClients('queue-update', updatedQueue);
	}
}

// Job Actions -------------------------------------------------------------------------------------
export async function AddJob(data: AddJobType) {
	AssertPathInMediaRoots(data.input_path, 'job input');
	AssertPathInMediaRoots(data.output_path, 'job output');

	const job = await DatabaseInsertJob(data);
	if (job) {
		await UpdateQueue();
		await JobForAvailableWorkers(job);
	}
}

export async function StartJob(job: DetailedJobType, worker: Worker) {
	const workerID = GetWorkerID(worker);

	const didClaim = await DatabaseClaimWaitingJob(job.job_id, workerID);
	if (!didClaim) {
		logger.warn(
			`[queue] [warn] Job '${job.job_id}' was already claimed before worker '${workerID}' could start it.`
		);
		return false;
	}

	try {
		const ack: StartTranscodeAck = await worker
			.timeout(15000)
			.emitWithAck('start-transcode', job.job_id);
		const didStart =
			typeof ack == 'number' ? ack == job.job_id : ack.ok && ack.jobID == job.job_id;

		if (!didStart) {
			throw new Error(
				typeof ack == 'number'
					? `Worker reported current job '${ack}'.`
					: ack.error || `Worker reported current job '${ack.currentJobID}'.`
			);
		}

		logger.info(`[queue] Worker '${workerID}' has started work on job '${job.job_id}'.`);
		await DatabaseUpdateJobStatus(job.job_id, {
			worker_id: workerID,
			time_started: new Date().getTime(),
		});
		return true;
	} catch (err) {
		logger.warn(
			`[queue] [warn] Worker '${workerID}' could not start job '${job.job_id}'. Releasing the claim.`
		);
		logger.warn(err);
		await DatabaseReleaseClaimedJob(job.job_id, workerID);
		return false;
	}
}

export async function StopJob(job_id: number, isError: boolean = false) {
	try {
		const job = await DatabaseGetDetailedJobByID(job_id);

		// Tell the worker to stop transcoding
		const worker = job.worker_id;
		if (worker) {
			const workerSocket = GetWorkerWithID(worker);
			if (workerSocket) {
				try {
					await workerSocket.timeout(15000).emitWithAck('stop-transcode', job_id);
				} catch (err) {
					logger.warn(
						`[queue] [warn] Worker '${worker}' did not acknowledge stop for job '${job_id}'.`
					);
					logger.warn(err);
				}
			}
		}

		const newStage = isError ? TranscodeStage.Error : TranscodeStage.Stopped;

		// Update Job in database
		await DatabaseUpdateJobOrderIndex(job_id, 0);
		await DatabaseUpdateJobStatus(job_id, {
			worker_id: null,
			transcode_stage: newStage,
			transcode_percentage: 0,
			transcode_eta: 0,
			transcode_fps_current: 0,
			transcode_fps_average: 0,
			time_started: 0,
			time_finished: Date.now(),
		});
		await UpdateQueue();
		if (worker) {
			await WorkerForAvailableJobs(worker);
		}
	} catch (err) {
		logger.error(`Could not stop the job with id '${job_id}'.`);
		throw err;
	}
}

export async function ResetJob(job_id: number) {
	const job = await DatabaseGetDetailedJobByID(job_id);

	if (
		job.transcode_stage == TranscodeStage.Stopped ||
		job.transcode_stage == TranscodeStage.Finished ||
		job.transcode_stage == TranscodeStage.Error
	) {
		// Update Job in database
		await DatabaseInsertJobOrderByID(job_id);
		await DatabaseUpdateJobStatus(job_id, {
			worker_id: null,
			transcode_stage: TranscodeStage.Waiting,
			transcode_percentage: 0,
			transcode_eta: 0,
			transcode_fps_current: 0,
			transcode_fps_average: 0,
			time_started: 0,
			time_finished: 0,
		});

		await UpdateQueue();
		await JobForAvailableWorkers(job_id);
	} else {
		logger.warn(
			`[server] [queue] Job with id '${job_id}' cannot be reset because it is not stopped, finished, or errored.`
		);
	}
}

export async function RemoveJob(job_id: number) {
	const job = await DatabaseGetDetailedJobByID(job_id);
	if (
		job.transcode_stage == TranscodeStage.Scanning ||
		job.transcode_stage == TranscodeStage.Transcoding ||
		job.transcode_stage == TranscodeStage.Unknown
	) {
		throw new Error(`Cannot remove active job '${job_id}'. Stop it first.`);
	}

	await DatabaseRemoveJobByID(job_id);
	await RemoveJobLogByID(job_id);
	await UpdateQueue();
}

export async function ClearQueue(clientID: string, finishedOnly: boolean = false) {
	logger.info(
		`[server] [queue] Client '${clientID}' has requested to clear ${
			finishedOnly ? 'finished' : 'all'
		} jobs from the queue.`
	);
	const queue = await DatabaseGetDetailedJobs();
	for await (const job of queue) {
		switch (job.transcode_stage) {
			case TranscodeStage.Waiting:
				if (!finishedOnly) {
					await DatabaseRemoveJobByID(job.job_id);
					logger.info(
						`[server] Removing job '${job.job_id}' from the queue due to being 'Waiting'.`
					);
				}
				break;
			case TranscodeStage.Finished:
				await DatabaseRemoveJobByID(job.job_id);
				logger.info(
					`[server] Removing job '${job.job_id}' from the queue due to being 'Finished'.`
				);
				break;
			case TranscodeStage.Stopped:
				if (!finishedOnly) {
					await DatabaseRemoveJobByID(job.job_id);
					logger.info(
						`[server] Removing job '${job.job_id}' from the queue due to being 'Stopped'.`
					);
				}
		}
	}

	await UpdateQueue();
}
