import {
	CreateFileLogger,
	formatJSON,
	type CustomTransportType,
} from '@handbrake-web/shared/logger';
import type { UpdateJobStatusType } from '@handbrake-web/shared/types/database';
import {
	type HandbrakeOutputType,
	type Muxing,
	type Scanning,
	type WorkDone,
	type Working,
} from '@handbrake-web/shared/types/handbrake';
import { type HandbrakePresetType } from '@handbrake-web/shared/types/preset';
import { TranscodeStage } from '@handbrake-web/shared/types/transcode';
import type {
	WorkerJobData,
	WorkerTransferLease,
	WorkerTransferPurpose,
} from '@handbrake-web/shared/types/worker-transfer';
import { spawn, type ChildProcessWithoutNullStreams as ChildProcess } from 'child_process';
import { createReadStream, createWriteStream } from 'fs';
import { mkdtemp, rm, stat, writeFile } from 'fs/promises';
import logger, { SendLogToServer } from 'logging';
import { availableParallelism } from 'os';
import path from 'path';
import { env } from 'process';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { Socket } from 'socket.io-client';
import { serverBaseAddress } from '../worker-startup';
import { getDataPath } from './data';

export type StartTranscodeResult = {
	ok: boolean;
	jobID?: number;
	currentJobID?: number | null;
	error?: string;
};

let handbrake: ChildProcess | null = null;
let startingJobID: number | null = null;
let stoppingJobID: number | null = null;
let currentRunPromise: Promise<void> | null = null;
let activeTransferAbortController: AbortController | null = null;

export const isTranscoding = () =>
	handbrake != null || startingJobID != null || currentJobID != null;
export const isStartingTranscode = () => startingJobID != null;

let currentJob: WorkerJobData | null = null;
export let currentJobID: number | null = null;
let currentWorkspaceDir: string | undefined;
let currentLocalOutputPath: string | undefined;
let presetPath: string | undefined;
const cancelledJobIDs = new Set<number>();

type ProgressPhase = 'scanning' | 'processing' | 'muxing';

const displayedProgressScale = 10_000;
const processCloseTimeoutMs = 15000;
const transferProgressUpdateIntervalMs = 500;
const getX265ThreadPoolOptions = () => [`pools=${availableParallelism()}`, 'wpp'];

const createProgressNormalizer = () => {
	const lastProgressByPhase: Partial<Record<ProgressPhase, number>> = {};

	return (phase: ProgressPhase, progress: number) => {
		if (!Number.isFinite(progress)) {
			return undefined;
		}

		const clampedProgress = Math.min(Math.max(progress, 0), 1);
		const displayedProgress = Math.round(clampedProgress * displayedProgressScale);
		const previousProgress = lastProgressByPhase[phase];

		if (previousProgress !== undefined && displayedProgress <= previousProgress) {
			return undefined;
		}

		lastProgressByPhase[phase] = displayedProgress;
		return displayedProgress / displayedProgressScale;
	};
};

const getEncoderOptionName = (option: string) =>
	option.trim().split('=')[0]!.trim().replace(/^no-/, '');

const applyX265ThreadPoolDefaults = (preset: HandbrakePresetType) => ({
	...preset,
	PresetList: preset.PresetList.map((presetItem) => {
		if (!presetItem.VideoEncoder.startsWith('x265')) return presetItem;

		const encoderOptions = (presetItem.VideoOptionExtra ?? '')
			.split(':')
			.map((option) => option.trim())
			.filter((option) => option.length > 0);
		const encoderOptionNames = encoderOptions.map(getEncoderOptionName);
		const optionsToAppend = getX265ThreadPoolOptions().filter((option) => {
			const optionName = getEncoderOptionName(option);

			if (optionName == 'pools') {
				return !encoderOptionNames.some((name) => name == 'pools' || name == 'numa-pools');
			}

			return !encoderOptionNames.includes(optionName);
		});

		if (optionsToAppend.length == 0) return presetItem;

		return {
			...presetItem,
			VideoOptionExtra: [...encoderOptions, ...optionsToAppend].join(':'),
		};
	}),
});

const writePresetToFile = async (
	preset: HandbrakePresetType,
	jobID: number,
	workspaceDir: string
) => {
	try {
		const presetString = JSON.stringify(applyX265ThreadPoolDefaults(preset));
		presetPath = path.join(workspaceDir, 'preset.json');

		await writeFile(presetPath, presetString, { flag: 'wx' });
		logger.info(`[worker] Successfully wrote preset for job '${jobID}' to file.`);
	} catch (err) {
		logger.error(`[worker] [error] Could not write preset to file at ${presetPath}.`);
		throw err;
	}
};

const logAndSendJobLog = (jobLogger: ReturnType<typeof CreateFileLogger>, socket: Socket) => {
	const transport = (jobLogger.transports as CustomTransportType[]).find(
		(transport) => transport._dest != undefined
	);
	if (transport && transport.dirname && transport.filename) {
		const logPath = path.join(transport.dirname, transport.filename);
		SendLogToServer(logPath, socket);
	}

	jobLogger.destroy();
};

const cleanupTranscodeFiles = async (workspaceDir = currentWorkspaceDir) => {
	if (!workspaceDir) return;

	try {
		await rm(workspaceDir, { recursive: true, force: true });
		logger.info(`[transcode] Cleaned up workspace '${path.basename(workspaceDir)}'.`);
	} catch (err) {
		logger.warn(`[transcode] [warn] Could not remove workspace '${workspaceDir}'.`);
		logger.warn(err);
	}
};

const clearCurrentJobState = () => {
	currentJob = null;
	currentJobID = null;
	currentWorkspaceDir = undefined;
	currentLocalOutputPath = undefined;
	presetPath = undefined;
	startingJobID = null;
	stoppingJobID = null;
	activeTransferAbortController = null;
};

const waitForProcessClose = async (child: ChildProcess) => {
	if (child.exitCode != null || child.signalCode != null) return;

	await new Promise<void>((resolve) => {
		const timeout = setTimeout(() => {
			if (child.exitCode == null && child.signalCode == null) {
				logger.warn('[transcode] [warn] HandBrake did not exit after SIGTERM; sending SIGKILL.');
				child.kill('SIGKILL');
			}
			resolve();
		}, processCloseTimeoutMs);

		child.once('close', () => {
			clearTimeout(timeout);
			resolve();
		});
	});
};

const getLocalJobPaths = (job: WorkerJobData, workspaceDir: string) => ({
	inputPath: path.join(workspaceDir, `input${path.extname(job.input_name) || '.media'}`),
	outputPath: path.join(workspaceDir, `output${path.extname(job.output_name) || '.mkv'}`),
});

const getTransferURL = (lease: WorkerTransferLease) =>
	new URL(lease.path, serverBaseAddress).toString();

const requestTransferLease = async (
	socket: Socket,
	jobID: number,
	purpose: WorkerTransferPurpose
) => {
	const lease = (await socket
		.timeout(15000)
		.emitWithAck('get-transfer-lease', jobID, purpose)) as WorkerTransferLease | undefined;

	if (!lease || lease.purpose != purpose) {
		throw new Error(`Could not get '${purpose}' transfer lease for job '${jobID}'.`);
	}

	return lease;
};

const getChunkByteLength = (chunk: unknown, encoding: BufferEncoding) => {
	if (typeof chunk == 'string') return Buffer.byteLength(chunk, encoding);
	if (chunk instanceof Uint8Array) return chunk.byteLength;

	return 0;
};

const normalizeContentLength = (value: number | string | null | undefined) => {
	const contentLength =
		typeof value == 'number'
			? value
			: typeof value == 'string'
			? Number.parseInt(value, 10)
			: undefined;

	if (contentLength == undefined || !Number.isSafeInteger(contentLength) || contentLength < 0) {
		return undefined;
	}

	return contentLength;
};

const emitTransferProgress = (socket: Socket, jobID: number, progress: number) => {
	const clampedProgress = Math.min(Math.max(progress, 0), 1);
	const displayedProgress =
		Math.round(clampedProgress * displayedProgressScale) / displayedProgressScale;

	socket.emit('transcode-update', jobID, {
		transcode_stage: TranscodeStage.Transferring,
		transcode_percentage: displayedProgress,
		transcode_eta: 0,
		transcode_fps_current: 0,
	} satisfies UpdateJobStatusType);
};

const createTransferProgressTransform = (
	socket: Socket,
	jobID: number,
	totalBytes: number | undefined
) => {
	let transferredBytes = 0;
	let lastUpdateAt = 0;
	let lastDisplayedProgress = -1;

	const emitProgress = (force = false) => {
		const progress = totalBytes && totalBytes > 0 ? transferredBytes / totalBytes : 0;
		const displayedProgress = Math.round(
			Math.min(Math.max(progress, 0), 1) * displayedProgressScale
		);
		const now = Date.now();

		if (
			!force &&
			(displayedProgress <= lastDisplayedProgress ||
				now - lastUpdateAt < transferProgressUpdateIntervalMs)
		) {
			return;
		}

		lastUpdateAt = now;
		lastDisplayedProgress = displayedProgress;
		emitTransferProgress(socket, jobID, displayedProgress / displayedProgressScale);
	};

	emitProgress(true);

	return new Transform({
		transform(chunk, encoding: BufferEncoding, callback) {
			transferredBytes += getChunkByteLength(chunk, encoding);
			emitProgress();
			callback(null, chunk);
		},
		flush(callback) {
			if (totalBytes == undefined || totalBytes <= 0) {
				emitTransferProgress(socket, jobID, 1);
			} else {
				transferredBytes = totalBytes;
				emitProgress(true);
			}
			callback();
		},
	});
};

const downloadInput = async (
	socket: Socket,
	jobID: number,
	destinationPath: string,
	jobLogger: ReturnType<typeof CreateFileLogger>
) => {
	const lease = await requestTransferLease(socket, jobID, 'input');
	activeTransferAbortController = new AbortController();

	try {
		jobLogger.info(`[transcode] Downloading input for job '${jobID}'.`);
		const response = await fetch(getTransferURL(lease), {
			headers: {
				Authorization: `Bearer ${lease.token}`,
			},
			signal: activeTransferAbortController.signal,
		});

		if (!response.ok) {
			throw new Error(`Input download failed with status ${response.status}.`);
		}
		if (!response.body) {
			throw new Error('Input download response did not contain a body.');
		}

		const totalBytes = normalizeContentLength(
			lease.contentLength ?? response.headers.get('content-length')
		);

		await pipeline(
			Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
			createTransferProgressTransform(socket, jobID, totalBytes),
			createWriteStream(destinationPath, { flags: 'wx' })
		);
		jobLogger.info(`[transcode] Finished downloading input for job '${jobID}'.`);
	} finally {
		activeTransferAbortController = null;
	}
};

const uploadOutput = async (
	socket: Socket,
	jobID: number,
	sourcePath: string,
	jobLogger: ReturnType<typeof CreateFileLogger>
) => {
	const lease = await requestTransferLease(socket, jobID, 'output');
	const outputStats = await stat(sourcePath);
	activeTransferAbortController = new AbortController();

	try {
		jobLogger.info(`[transcode] Uploading output for job '${jobID}'.`);
		const response = await fetch(getTransferURL(lease), {
			method: 'PUT',
			headers: {
				Authorization: `Bearer ${lease.token}`,
				'Content-Length': outputStats.size.toString(),
			},
			body: createReadStream(sourcePath).pipe(
				createTransferProgressTransform(socket, jobID, outputStats.size)
			) as unknown as RequestInit['body'],
			duplex: 'half',
			signal: activeTransferAbortController.signal,
		} as RequestInit & { duplex: 'half' });

		if (!response.ok) {
			throw new Error(`Output upload failed with status ${response.status}.`);
		}

		jobLogger.info(`[transcode] Finished uploading output for job '${jobID}'.`);
	} finally {
		activeTransferAbortController = null;
	}
};

const handleProgressOutput = async (
	jobID: number,
	outputKind: string | undefined,
	outputJSON: HandbrakeOutputType,
	socket: Socket,
	jobLogger: ReturnType<typeof CreateFileLogger>,
	normalizeProgress: ReturnType<typeof createProgressNormalizer>,
	markTerminalEventSent: () => void
) => {
	switch (outputKind) {
		case 'Version':
			jobLogger.info(
				`[transcode] [version] ${formatJSON(JSON.stringify(outputJSON, null, 2))}`
			);
			break;
		case 'Progress':
			switch (outputJSON['State']) {
				case 'SCANNING': {
					const scanning: Scanning = outputJSON.Scanning!;
					const scanningProgress = normalizeProgress('scanning', scanning.Progress);
					if (scanningProgress == undefined) break;

					const scanningStatus: UpdateJobStatusType = {
						transcode_stage: TranscodeStage.Scanning,
						transcode_percentage: scanningProgress,
					};
					socket.emit('transcode-update', jobID, scanningStatus);
					jobLogger.info(
						`[transcode] [scanning] ${(scanningProgress * 100).toFixed(2)} %`
					);
					break;
				}
				case 'WORKING': {
					const working: Working = outputJSON.Working!;
					const workingProgress = normalizeProgress('processing', working.Progress);
					if (workingProgress == undefined) break;

					const workingStatus: UpdateJobStatusType = {
						transcode_stage: TranscodeStage.Transcoding,
						transcode_percentage: workingProgress,
						transcode_eta: working.ETASeconds,
						transcode_fps_current: working.Rate,
						transcode_fps_average: working.RateAvg,
					};
					socket.emit('transcode-update', jobID, workingStatus);
					jobLogger.info(
						`[transcode] [processing] ${(workingProgress * 100).toFixed(2)} %`
					);
					break;
				}
				case 'MUXING': {
					const muxing: Muxing = outputJSON.Muxing!;
					const muxingProgress = normalizeProgress('muxing', muxing.Progress);
					if (muxingProgress == undefined) break;

					const muxingStatus: UpdateJobStatusType = {
						transcode_stage: TranscodeStage.Transcoding,
						transcode_percentage: muxingProgress,
					};
					socket.emit('transcode-update', jobID, muxingStatus);
					jobLogger.info(`[transcode] [muxing] ${(muxingProgress * 100).toFixed(2)} %`);
					break;
				}
				case 'WORKDONE': {
					const workDone: WorkDone = outputJSON.WorkDone!;
					markTerminalEventSent();

					if (workDone.Error == 0 && currentJob && currentLocalOutputPath) {
						socket.emit('transcode-update', jobID, {
							transcode_stage: TranscodeStage.Transferring,
							transcode_percentage: 0,
							transcode_eta: 0,
							transcode_fps_current: 0,
						} satisfies UpdateJobStatusType);
						await uploadOutput(socket, jobID, currentLocalOutputPath, jobLogger);

						const doneStatus: UpdateJobStatusType = {
							worker_id: null,
							transcode_stage: TranscodeStage.Finished,
							transcode_percentage: 1,
							transcode_eta: 0,
							transcode_fps_current: 0,
							time_finished: Date.now(),
						};

						await cleanupTranscodeFiles();
						clearCurrentJobState();
						socket.emit('transcode-finished', jobID, doneStatus);
						jobLogger.info(`[transcode] [finished] 100.00%`);
					} else {
						jobLogger.error(`[transcode] [error] Finished with error ${workDone.Error}`);
						await cleanupTranscodeFiles();
						clearCurrentJobState();
						socket.emit('transcode-error', jobID);
					}
					break;
				}
				default:
					jobLogger.error(
						`[transcode] [error] Unexpected json output:\n${JSON.stringify(outputJSON)}`
					);
					break;
			}
	}
};

const runTranscode = async (jobID: number, socket: Socket) => {
	let jobLogger: ReturnType<typeof CreateFileLogger> | undefined;
	let terminalEventSent = false;
	let stdoutBuffer = '';
	let terminalWorkPromise: Promise<void> | undefined;

	try {
		const jobData = (await socket
			.timeout(5000)
			.emitWithAck('get-job-data', jobID)) as WorkerJobData | undefined;
		if (!jobData) {
			throw new Error(`Server did not return job data for job '${jobID}'.`);
		}

		currentJob = jobData;
		currentJobID = jobID;
		currentWorkspaceDir = await mkdtemp(path.join(getDataPath(), `handbrake-web-${jobID}-`));
		const localPaths = getLocalJobPaths(jobData, currentWorkspaceDir);
		currentLocalOutputPath = localPaths.outputPath;

		jobLogger = CreateFileLogger(
			env.WORKER_ID!,
			`${env.WORKER_ID!}-job-${jobID}`,
			path.join(getDataPath(), 'log')
		);
		const normalizeProgress = createProgressNormalizer();

		socket.emit('transcode-update', jobID, {
			transcode_stage: TranscodeStage.Transferring,
			transcode_percentage: 0,
			transcode_eta: 0,
			transcode_fps_current: 0,
			time_started: Date.now(),
		} satisfies UpdateJobStatusType);

		await downloadInput(socket, jobID, localPaths.inputPath, jobLogger);

		const presetData: HandbrakePresetType = await socket
			.timeout(5000)
			.emitWithAck('get-preset-data', jobData.preset_category, jobData.preset_id);
		await writePresetToFile(presetData, jobID, currentWorkspaceDir);

		handbrake = spawn('HandBrakeCLI', [
			'--preset-import-file',
			presetPath!,
			'--preset',
			jobData.preset_id,
			'-i',
			localPaths.inputPath,
			'-o',
			localPaths.outputPath,
			'--json',
		]);
		startingJobID = null;

		const newStatus: UpdateJobStatusType = {
			transcode_stage: TranscodeStage.Scanning,
			time_started: Date.now(),
		};
		socket.emit('transcode-update', jobID, newStatus);

		handbrake.stdout.on('data', (data) => {
			void (async () => {
				stdoutBuffer += data.toString();
				const jsonRegex = /(^[A-Z][a-z]+):\s({(?:[\n\s+].+\n)+^})/gm;
				let match: RegExpExecArray | null;
				let lastIndex = 0;

				while ((match = jsonRegex.exec(stdoutBuffer)) != null) {
					lastIndex = jsonRegex.lastIndex;

					try {
						const outputJSON = JSON.parse(match[2]!) as HandbrakeOutputType;
						const workPromise = handleProgressOutput(
							jobID,
							match[1],
							outputJSON,
							socket,
							jobLogger!,
							normalizeProgress,
							() => {
								terminalEventSent = true;
							}
						);

						if (match[1] == 'Progress' && outputJSON.State == 'WORKDONE') {
							terminalWorkPromise = workPromise;
						}

						await workPromise;
					} catch (err) {
						jobLogger!.error('[transcode] [error] Could not parse/process HandBrake JSON.');
						jobLogger!.error(err);
						terminalEventSent = true;
						await cleanupTranscodeFiles();
						clearCurrentJobState();
						if (!cancelledJobIDs.has(jobID)) {
							socket.emit('transcode-error', jobID);
						}
					}
				}

				if (lastIndex > 0) {
					stdoutBuffer = stdoutBuffer.slice(lastIndex);
				} else if (stdoutBuffer.length > 100000) {
					stdoutBuffer = stdoutBuffer.slice(-10000);
				}
			})();
		});

		handbrake.stderr.on('data', (data) => {
			jobLogger!.info(`[transcode] \n${data.toString()}`);
		});

		handbrake.on('error', (err) => {
			jobLogger!.error(`[transcode] [error] The HandBrake child process failed.`);
			jobLogger!.error(err);
		});

		handbrake.on('close', async (code, signal) => {
			try {
				if (terminalWorkPromise) {
					await terminalWorkPromise.catch(() => undefined);
				}

				if (
					!terminalEventSent &&
					stoppingJobID == null &&
					!cancelledJobIDs.has(jobID)
				) {
					jobLogger!.error(
						`[transcode] [error] HandBrake closed before WORKDONE with code '${code}' and signal '${signal}'.`
					);
					await cleanupTranscodeFiles();
					clearCurrentJobState();
					socket.emit('transcode-error', jobID);
				}
			} finally {
				handbrake = null;
				startingJobID = null;
				logAndSendJobLog(jobLogger!, socket);
			}
		});
	} catch (err) {
		logger.error(`[transcode] [error] Could not run job '${jobID}'.`);
		logger.error(err);
		jobLogger?.error(`[transcode] [error] Could not run job '${jobID}'.`);
		jobLogger?.error(err);
		await cleanupTranscodeFiles();
		clearCurrentJobState();
		handbrake = null;

		if (!cancelledJobIDs.has(jobID)) {
			socket.emit('transcode-error', jobID);
		}

		jobLogger?.destroy();
	}
};

export async function StartTranscode(jobID: number, socket: Socket): Promise<StartTranscodeResult> {
	if (isTranscoding()) {
		return {
			ok: false,
			currentJobID: currentJobID ?? startingJobID,
			error: 'Worker is already busy.',
		};
	}

	startingJobID = jobID;
	currentJobID = jobID;
	currentRunPromise = runTranscode(jobID, socket).finally(() => {
		currentRunPromise = null;
		cancelledJobIDs.delete(jobID);
	});

	return { ok: true, jobID };
}

export async function StopTranscode(id: number, socket: Socket) {
	if (currentJobID != id && startingJobID != id) {
		logger.warn(
			`[transcode] [warn] Stop request for job '${id}' ignored; current job is '${currentJobID}'.`
		);
		return;
	}

	cancelledJobIDs.add(id);
	stoppingJobID = id;
	const stoppedWorkspaceDir = currentWorkspaceDir;

	activeTransferAbortController?.abort();

	if (handbrake) {
		handbrake.kill('SIGTERM');
		await waitForProcessClose(handbrake);
	}

	if (socket.connected) {
		logger.info(`[transcode] Informing the server that job '${id}' has been stopped.`);
		await socket.timeout(15000).emitWithAck('transcode-stopped', id);
		logger.info(`[transcode] The server has acknowledged that job '${id}' has been stopped.`);
	} else {
		logger.error(
			"[transcode] Cannot send the event 'transcode-stopped' because the server socket is not connected."
		);
	}

	await cleanupTranscodeFiles(stoppedWorkspaceDir);
	clearCurrentJobState();
	handbrake = null;
}

export async function SelfStopTranscode(socket: Socket) {
	if (currentJobID) {
		await StopTranscode(currentJobID, socket);
	} else {
		logger.info(
			`[transcode] The worker is not transcoding anything, there is no transcode to stop.`
		);
	}
}
