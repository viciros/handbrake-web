import {
	CreateFileLogger,
	formatJSON,
	type CustomTransportType,
} from '@handbrake-web/shared/logger';
import type { JobType, UpdateJobStatusType } from '@handbrake-web/shared/types/database';
import {
	type HandbrakeOutputType,
	type Muxing,
	type Scanning,
	type WorkDone,
	type Working,
} from '@handbrake-web/shared/types/handbrake';
import { type HandbrakePresetType } from '@handbrake-web/shared/types/preset';
import { TranscodeStage } from '@handbrake-web/shared/types/transcode';
import { spawn, type ChildProcessWithoutNullStreams as ChildProcess } from 'child_process';
import { access, mkdtemp, realpath, rename, rm, writeFile } from 'fs/promises';
import logger, { SendLogToServer } from 'logging';
import { availableParallelism, tmpdir } from 'os';
import path from 'path';
import { env } from 'process';
import { Socket } from 'socket.io-client';
import { getDataPath, getVideoPath } from './data';

export type StartTranscodeResult = {
	ok: boolean;
	jobID?: number;
	currentJobID?: number | null;
	error?: string;
};

let handbrake: ChildProcess | null = null;
let startingJobID: number | null = null;
let stoppingJobID: number | null = null;

export const isTranscoding = () => handbrake != null || startingJobID != null;
export const isStartingTranscode = () => startingJobID != null;

let currentJob: JobType | null = null;
export let currentJobID: number | null = null;
let presetPath: string | undefined;
let presetDir: string | undefined;

type ProgressPhase = 'scanning' | 'processing' | 'muxing';

const displayedProgressScale = 10_000;
const processCloseTimeoutMs = 15000;
const getX265ThreadPoolOptions = () => [`pools=${availableParallelism()}`, 'wpp'];

const isSubPath = (parent: string, child: string) => {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	return relative == '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
};

const ensureInputPathIsAllowed = async (inputPath: string) => {
	const videoRoot = await realpath(getVideoPath());
	const realInputPath = await realpath(path.resolve(inputPath));

	if (!isSubPath(videoRoot, realInputPath)) {
		throw new Error(`Input path '${inputPath}' is outside VIDEO_PATH '${getVideoPath()}'.`);
	}

	await access(realInputPath);
	return realInputPath;
};

const ensureOutputPathIsAllowed = async (outputPath: string) => {
	const videoRoot = await realpath(getVideoPath());
	const resolvedOutputPath = path.resolve(outputPath);
	const realOutputParent = await realpath(path.dirname(resolvedOutputPath));

	if (!isSubPath(videoRoot, realOutputParent)) {
		throw new Error(`Output path '${outputPath}' is outside VIDEO_PATH '${getVideoPath()}'.`);
	}

	return resolvedOutputPath;
};

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

const writePresetToFile = async (preset: HandbrakePresetType, jobID: number) => {
	try {
		const presetString = JSON.stringify(applyX265ThreadPoolDefaults(preset));
		presetDir = await mkdtemp(path.join(tmpdir(), `handbrake-web-${jobID}-`));
		presetPath = path.join(presetDir, 'preset.json');

		await writeFile(presetPath, presetString, { flag: 'wx' });
		logger.info(`[worker] Sucessfully wrote preset for job '${jobID}' to file.`);
	} catch (err) {
		logger.error(`[worker] [error] Could not write preset to file at ${presetPath}.`);
		throw err;
	}
};

const getTempOutputName = (output: string) => {
	const outputParsed = path.parse(output);
	return path.join(outputParsed.dir, outputParsed.name + '.transcoding' + outputParsed.ext);
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

const cleanupTranscodeFiles = async (job: JobType | null, removeTempOutput = true) => {
	if (job && removeTempOutput) {
		const tempOutputName = getTempOutputName(job.output_path);
		try {
			await access(tempOutputName);
			await rm(tempOutputName);
			logger.info(`[transcode] Cleaned up temp file '${path.basename(tempOutputName)}'.`);
		} catch {
			// No temp file is fine here; HandBrake may not have created it yet.
		}
	}

	if (presetPath) {
		try {
			await access(presetPath);
			await rm(presetPath);
			logger.info(`[transcode] Removed the preset file '${path.basename(presetPath)}'.`);
		} catch {
			// Missing preset is also fine during error cleanup.
		}
	}

	if (presetDir) {
		try {
			await rm(presetDir, { recursive: true, force: true });
		} catch (err) {
			logger.warn(`[transcode] [warn] Could not remove preset temp directory '${presetDir}'.`);
			logger.warn(err);
		}
	}
};

const clearCurrentJobState = () => {
	currentJob = null;
	currentJobID = null;
	presetPath = undefined;
	presetDir = undefined;
	startingJobID = null;
	stoppingJobID = null;
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

					if (workDone.Error == 0 && currentJob) {
						const doneStatus: UpdateJobStatusType = {
							worker_id: null,
							transcode_stage: TranscodeStage.Finished,
							transcode_percentage: 1,
							transcode_eta: 0,
							transcode_fps_current: 0,
							time_finished: Date.now(),
						};
						const tempOutputName = getTempOutputName(currentJob.output_path);

						await rename(tempOutputName, currentJob.output_path);
						jobLogger.info(
							`[transcode] Renamed '${path.basename(tempOutputName)}' to '${path.basename(
								currentJob.output_path
							)}'.`
						);

						await cleanupTranscodeFiles(currentJob, false);
						clearCurrentJobState();
						socket.emit('transcode-finished', jobID, doneStatus);
						jobLogger.info(`[transcode] [finished] 100.00%`);
					} else {
						jobLogger.error(`[transcode] [error] Finished with error ${workDone.Error}`);
						await cleanupTranscodeFiles(currentJob);
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

export async function StartTranscode(jobID: number, socket: Socket): Promise<StartTranscodeResult> {
	if (isTranscoding()) {
		return {
			ok: false,
			currentJobID: currentJobID ?? startingJobID,
			error: 'Worker is already busy.',
		};
	}

	startingJobID = jobID;
	let jobLogger: ReturnType<typeof CreateFileLogger> | undefined;
	let terminalEventSent = false;
	let stdoutBuffer = '';

	try {
		const jobData: JobType = await socket.timeout(5000).emitWithAck('get-job-data', jobID);
		jobData.input_path = await ensureInputPathIsAllowed(jobData.input_path);
		jobData.output_path = await ensureOutputPathIsAllowed(jobData.output_path);
		currentJob = jobData;
		currentJobID = jobID;

		const presetData: HandbrakePresetType = await socket
			.timeout(5000)
			.emitWithAck('get-preset-data', jobData.preset_category, jobData.preset_id);
		await writePresetToFile(presetData, jobID);

		const tempOutputName = getTempOutputName(jobData.output_path);
		jobLogger = CreateFileLogger(
			env.WORKER_ID!,
			`${env.WORKER_ID!}-job-${jobID}`,
			path.join(getDataPath(), 'log')
		);
		const normalizeProgress = createProgressNormalizer();

		handbrake = spawn('HandBrakeCLI', [
			'--preset-import-file',
			presetPath!,
			'--preset',
			jobData.preset_id,
			'-i',
			jobData.input_path,
			'-o',
			tempOutputName,
			'--json',
		]);
		startingJobID = null;

		const newStatus: UpdateJobStatusType = {
			transcode_stage: TranscodeStage.Scanning,
			time_started: Date.now(),
		};
		socket.emit('transcode-update', jobID, newStatus);

		handbrake.stdout.on('data', async (data) => {
			stdoutBuffer += data.toString();
			const jsonRegex = /(^[A-Z][a-z]+):\s({(?:[\n\s+].+\n)+^})/gm;
			let match: RegExpExecArray | null;
			let lastIndex = 0;

			while ((match = jsonRegex.exec(stdoutBuffer)) != null) {
				lastIndex = jsonRegex.lastIndex;

				try {
					await handleProgressOutput(
						jobID,
						match[1],
						JSON.parse(match[2]!) as HandbrakeOutputType,
						socket,
						jobLogger!,
						normalizeProgress,
						() => {
							terminalEventSent = true;
						}
					);
				} catch (err) {
					jobLogger!.error('[transcode] [error] Could not parse/process HandBrake JSON.');
					jobLogger!.error(err);
					terminalEventSent = true;
					await cleanupTranscodeFiles(currentJob);
					clearCurrentJobState();
					socket.emit('transcode-error', jobID);
				}
			}

			if (lastIndex > 0) {
				stdoutBuffer = stdoutBuffer.slice(lastIndex);
			} else if (stdoutBuffer.length > 100000) {
				stdoutBuffer = stdoutBuffer.slice(-10000);
			}
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
				if (!terminalEventSent && stoppingJobID == null) {
					jobLogger!.error(
						`[transcode] [error] HandBrake closed before WORKDONE with code '${code}' and signal '${signal}'.`
					);
					await cleanupTranscodeFiles(currentJob);
					const failedJobID = currentJobID;
					clearCurrentJobState();
					if (failedJobID) socket.emit('transcode-error', failedJobID);
				}
			} finally {
				handbrake = null;
				startingJobID = null;
				logAndSendJobLog(jobLogger!, socket);
			}
		});

		return { ok: true, jobID };
	} catch (err) {
		logger.error(`[transcode] [error] Could not start job '${jobID}'.`);
		logger.error(err);
		await cleanupTranscodeFiles(currentJob);
		clearCurrentJobState();
		handbrake = null;
		jobLogger?.destroy();
		socket.emit('transcode-error', jobID);
		return { ok: false, currentJobID: null, error: err instanceof Error ? err.message : String(err) };
	}
}

export async function StopTranscode(id: number, socket: Socket) {
	if (!handbrake || !currentJob || currentJobID != id) {
		logger.warn(
			`[transcode] [warn] Stop request for job '${id}' ignored; current job is '${currentJobID}'.`
		);
		return;
	}

	stoppingJobID = id;
	const stoppedJob = currentJob;

	handbrake.kill('SIGTERM');
	await waitForProcessClose(handbrake);

	if (socket.connected) {
		logger.info(`[transcode] Informing the server that job '${id}' has been stopped.`);
		await socket.timeout(15000).emitWithAck('transcode-stopped', id);
		logger.info(`[transcode] The server has acknowledged that job '${id}' has been stopped.`);
	} else {
		logger.error(
			"[transcode] Cannot send the event 'transcode-stopped' because the server socket is not connected."
		);
	}

	await cleanupTranscodeFiles(stoppedJob);
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
