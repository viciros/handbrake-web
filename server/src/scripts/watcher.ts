import { PresetFormatDict } from '@handbrake-web/shared/dict/presets.dict';
import type {
	AddJobType,
	AddWatcherRuleType,
	AddWatcherType,
	DetailedJobType,
	DetailedWatcherRuleType,
	DetailedWatcherType,
	UpdateWatcherRuleType,
	UpdateWatcherType,
} from '@handbrake-web/shared/types/database';
import { QueueStatus } from '@handbrake-web/shared/types/queue';
import { TranscodeStage } from '@handbrake-web/shared/types/transcode';
import {
	WatcherRuleBaseMethods,
	WatcherRuleComparisonLookup,
	WatcherRuleComparisonMethods,
	WatcherRuleFileInfoMethods,
	WatcherRuleMaskMethods,
	WatcherRuleMediaInfoMethods,
	WatcherRuleNumberComparisonMethods,
	WatcherRuleStringComparisonMethods,
} from '@handbrake-web/shared/types/watcher';
import chokidar, { type FSWatcher } from 'chokidar';
import fs from 'fs/promises';
import logger from 'logging';
import mime from 'mime';
import path from 'path';
import { EmitToAllClients } from './connections';
import {
	DatabaseGetDetailedWatcherByID,
	DatabaseGetDetailedWatchers,
	DatabaseGetWatcherIDFromRule,
	DatabaseGetWatcherRuleByID,
	DatabaseInsertWatcher,
	DatabaseInsertWatcherRule,
	DatabaseUpdateWatcher,
	RemoveWatcherFromDatabase,
	RemoveWatcherRuleFromDatabase,
	UpdateWatcherRuleInDatabase,
} from './database/database-watcher';
import { CheckFilenameCollision } from './files';
import { ConvertBitsToKilobits, ConvertBytesToMegabytes, GetMediaInfo } from './media';
import { GetDefaultPresetByName, GetPresetByName } from './presets';
import {
	AddJob,
	GetQueue,
	GetQueueStatus,
	RemoveJob,
	ResetJob,
	StartQueue,
	StopJob,
} from './queue';
import {
	AssertExistingDirectoryInMediaRoots,
	AssertExistingPathInMediaRoots,
} from './path-safety';

type WatcherRuntime = {
	watcher: FSWatcher;
	abortController: AbortController;
	pendingFiles: Map<string, Promise<void>>;
};

type WaitForFileReadyOptions = {
	stabilityMs?: number;
	pollIntervalMs?: number;
	signal?: AbortSignal;
};

const watchers: { [index: number]: WatcherRuntime } = [];
const maxWatcherRegexLength = 256;
const defaultWatcherStabilitySeconds = 30;
const watcherPollIntervalMs = 1000;
const regexLiteralRegex =
	/^\/((?![*+?])(?:[^\r\n\[/\\]|\\.|\[(?:[^\r\n\]\\]|\\.)*\])+)\/((?:g(?:im?|mi?)?|i(?:gm?|mg?)?|m(?:gi?|ig?)?)?)$/;
const nestedQuantifierRegex =
	/\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,?\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,?\d*\})/;
const repeatedAlternationRegex =
	/\((?:[^()\\]|\\.)+\|(?:[^()\\]|\\.)+\)(?:[+*]|\{\d+,?\d*\})/;
const backReferenceRegex = /\\[1-9]/;

export function GetWatcherStabilityMs(value = process.env.HANDBRAKE_WATCHER_STABILITY_SECONDS) {
	if (value == undefined || value.trim() == '') return defaultWatcherStabilitySeconds * 1000;

	const seconds = Number(value);
	if (!Number.isFinite(seconds) || seconds <= 0) {
		logger.warn(
			`[watcher] [warn] Invalid HANDBRAKE_WATCHER_STABILITY_SECONDS value '${value}'; using ${defaultWatcherStabilitySeconds} seconds.`
		);
		return defaultWatcherStabilitySeconds * 1000;
	}

	return seconds * 1000;
}

const waitForPoll = (delayMs: number, signal?: AbortSignal) =>
	new Promise<boolean>((resolve) => {
		if (signal?.aborted) {
			resolve(false);
			return;
		}

		const onAbort = () => {
			clearTimeout(timeout);
			resolve(false);
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve(true);
		}, delayMs);
		signal?.addEventListener('abort', onAbort, { once: true });
	});

export async function WaitForFileReady(
	filePath: string,
	options: WaitForFileReadyOptions = {}
): Promise<boolean> {
	const stabilityMs = options.stabilityMs ?? GetWatcherStabilityMs();
	const pollIntervalMs = options.pollIntervalMs ?? Math.min(watcherPollIntervalMs, stabilityMs);
	let previousStats: { size: number; mtimeMs: number } | undefined;
	let stableSince = Date.now();

	while (!options.signal?.aborted) {
		let fileStats;
		try {
			fileStats = await fs.stat(filePath);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code == 'ENOENT') return false;
			throw err;
		}

		if (!fileStats.isFile()) return false;
		const currentStats = { size: fileStats.size, mtimeMs: fileStats.mtimeMs };

		if (
			previousStats &&
			previousStats.size == currentStats.size &&
			previousStats.mtimeMs == currentStats.mtimeMs
		) {
			if (Date.now() - stableSince >= stabilityMs) return true;
		} else {
			previousStats = currentStats;
			stableSince = Date.now();
		}

		if (!(await waitForPoll(pollIntervalMs, options.signal))) return false;
	}

	return false;
}

const parseWatcherRegex = (value: string) => {
	const splitRegex = value.match(regexLiteralRegex);
	if (!splitRegex) return undefined;

	return {
		pattern: splitRegex[1]!,
		flags: splitRegex[2]!,
	};
};

export function AssertSafeWatcherRegex(value: string) {
	if (value.length > maxWatcherRegexLength) {
		throw new Error(`Watcher regex is longer than ${maxWatcherRegexLength} characters.`);
	}

	const parsedRegex = parseWatcherRegex(value);
	if (!parsedRegex) {
		throw new Error(`Could not detect a valid regex in the string '${value}'.`);
	}

	if (
		nestedQuantifierRegex.test(parsedRegex.pattern) ||
		repeatedAlternationRegex.test(parsedRegex.pattern) ||
		backReferenceRegex.test(parsedRegex.pattern)
	) {
		throw new Error(`Watcher regex '${value}' is not safe.`);
	}

	new RegExp(parsedRegex.pattern, parsedRegex.flags);
	return parsedRegex;
}

function ValidateWatcherRule(rule: AddWatcherRuleType | UpdateWatcherRuleType) {
	if (
		rule.comparison_method == WatcherRuleStringComparisonMethods.RegularExpression &&
		typeof rule.comparison == 'string'
	) {
		AssertSafeWatcherRegex(rule.comparison);
	}
}

function ValidateWatcherRules(rules: DetailedWatcherRuleType[]) {
	for (const rule of rules) {
		ValidateWatcherRule(rule);
	}
}

async function StartQueueIfStopped(watcher: DetailedWatcherType) {
	const isQueueStopped = (await GetQueueStatus()) == QueueStatus.Stopped;
	if (watcher.start_queue && isQueueStopped) {
		logger.info(
			`[watcher] Watcher for '${watcher.watch_path}' is requesting to start the queue, since it is stopped.`
		);
		await StartQueue();
	}
}

function FindMatchingWatcherJob(
	queue: DetailedJobType[],
	watcher: DetailedWatcherType,
	filePath: string
) {
	return queue.find(
		(job) =>
			job.input_path == filePath &&
			job.preset_category == watcher.preset_category &&
			job.preset_id == watcher.preset_id
	);
}

export async function RegisterWatcher(watcher: DetailedWatcherType) {
	watcher.watch_path = await AssertExistingDirectoryInMediaRoots(watcher.watch_path, 'watch path');
	if (watcher.output_path) {
		watcher.output_path = await AssertExistingDirectoryInMediaRoots(
			watcher.output_path,
			'watcher output path'
		);
	}
	ValidateWatcherRules(watcher.rules);

	const newWatcher = chokidar.watch(watcher.watch_path, {
		ignoreInitial: true,
		ignorePermissionErrors: true,
	});
	const runtime: WatcherRuntime = {
		watcher: newWatcher,
		abortController: new AbortController(),
		pendingFiles: new Map(),
	};
	const stabilityMs = GetWatcherStabilityMs();

	const handleWatcherEvent = (
		eventName: string,
		filePath: string,
		handler: (watcher: DetailedWatcherType, filePath: string) => Promise<void>
	) => {
		handler(watcher, filePath).catch((err) => {
			logger.error(
				`[server] [watcher] [error] Watcher '${watcher.watcher_id}' failed while handling '${eventName}' for '${filePath}'.`
			);
			logger.error(err);
		});
	};

	newWatcher.on('add', (filePath) => {
		if (runtime.pendingFiles.has(filePath)) return;

		const pendingFile = WaitForFileReady(filePath, {
			stabilityMs,
			signal: runtime.abortController.signal,
		})
			.then(async (isReady) => {
				if (!isReady) return;
				logger.info(
					`[server] [watcher] File '${path.basename(filePath)}' is stable and ready for processing.`
				);
				await onWatcherDetectFileAdd(watcher, filePath);
			})
			.catch((err) => {
				logger.error(
					`[server] [watcher] [error] Watcher '${watcher.watcher_id}' failed while waiting for '${filePath}' to become ready.`
				);
				logger.error(err);
			})
			.finally(() => {
				runtime.pendingFiles.delete(filePath);
			});
		runtime.pendingFiles.set(filePath, pendingFile);
	});

	newWatcher.on('unlink', (filePath) => {
		handleWatcherEvent('unlink', filePath, onWatcherDetectFileDelete);
	});

	newWatcher.on('change', (filePath) => {
		onWatcherDetectFileChange(watcher, filePath);
	});

	newWatcher.on('error', (error) => {
		logger.error(error);
	});

	watchers[watcher.watcher_id] = runtime;

	logger.info(`[server] [watcher] Registered watcher for '${watcher.watch_path}'.`);
}

export async function DeregisterWatcher(id: number) {
	try {
		// logger.info(watchers);
		if (!watchers[id]) {
			logger.info(`[server] [watcher] Watcher '${id}' is not registered.`);
			return;
		}
		const runtime = watchers[id];
		const directory = Object.entries(runtime.watcher.getWatched())[0].join('/');
		runtime.abortController.abort();
		await runtime.watcher.close();
		logger.info(`[server] [watcher] Deregistered watcher for '${directory}'.`);

		delete watchers[id];
	} catch (error) {
		logger.error(`[server] [watcher] [error] Could not deregister watcher with id '${id}'.`);
		throw error;
	}
}

export async function InitializeWatchers() {
	const watchers = await DatabaseGetDetailedWatchers();

	for await (const watcher of watchers) {
		try {
			await RegisterWatcher(watcher);
		} catch (err) {
			logger.error(
				`[server] [watcher] [error] Watcher '${watcher.watcher_id}' could not be registered.`
			);
			logger.error(err);
		}
	}
}

function WatcherRuleStringComparison(
	input: string,
	method: WatcherRuleStringComparisonMethods,
	value: string
) {
	switch (method) {
		case WatcherRuleStringComparisonMethods.Contains:
			return input.includes(value);
		case WatcherRuleStringComparisonMethods.EqualTo:
			return input == value;
		case WatcherRuleStringComparisonMethods.RegularExpression:
			try {
				const parsedRegex = AssertSafeWatcherRegex(value);
				return input.match(new RegExp(parsedRegex.pattern, parsedRegex.flags))
					? true
					: false;
			} catch {
				logger.info(
					`[server] [watcher] [error] Could not detect a valid regex in the string '${value}'.`
				);
				return false;
			}
	}
}

function WatcherRuleNumberComparison(
	input: string,
	method: WatcherRuleNumberComparisonMethods,
	value: string
): boolean {
	const inputNumber = parseFloat(input);
	const valueNumber = parseFloat(value);
	let result = false;

	switch (method) {
		case WatcherRuleNumberComparisonMethods.LessThan:
			result = inputNumber < valueNumber;
			break;
		case WatcherRuleNumberComparisonMethods.LessThanOrEqualTo:
			result = inputNumber <= valueNumber;
			break;
		case WatcherRuleNumberComparisonMethods.EqualTo:
			result = inputNumber == valueNumber;
			break;
		case WatcherRuleNumberComparisonMethods.GreaterThan:
			result = inputNumber > valueNumber;
			break;
		case WatcherRuleNumberComparisonMethods.GreaterThanOrEqualTo:
			result = inputNumber >= valueNumber;
			break;
		default:
			result = false;
			break;
	}

	return result;
}

async function onWatcherDetectFileAdd(watcher: DetailedWatcherType, filePath: string) {
	const safeFilePath = await AssertExistingPathInMediaRoots(filePath, 'watcher input');
	logger.info(
		`[server] [watcher] Watcher for '${
			watcher.watch_path
		}' has detected the creation of the file '${path.basename(safeFilePath)}'.`
	);

	const asyncEvery = async (
		values: DetailedWatcherRuleType[],
		predicate: (value: DetailedWatcherRuleType) => Promise<boolean>
	) => {
		for (let value of values) {
			const result = await predicate(value);
			if (!result) {
				return false;
			}
		}
		return true;
	};

	logger.info(
		`[watcher] Processing ${Object.keys(watcher.rules).length} rules for the watcher for '${
			watcher.watch_path
		}'.`
	);

	const isValid =
		watcher.rules.length == 0
			? true
			: await asyncEvery(watcher.rules, async (rule) => {
					let comparisonMethod =
						WatcherRuleComparisonLookup[
							rule.base_rule_method == WatcherRuleBaseMethods.FileInfo
								? WatcherRuleFileInfoMethods[rule.rule_method]
								: rule.base_rule_method == WatcherRuleBaseMethods.MediaInfo
								? WatcherRuleMediaInfoMethods[rule.rule_method]
								: 0
						];
					if (comparisonMethod == undefined) {
						logger.warn(
							`[server] [watcher] [warn] Watcher rule '${rule.rule_id}' has an unsupported comparison method.`
						);
						return false;
					}

					let input = '';

					switch (rule.base_rule_method) {
						case WatcherRuleBaseMethods.FileInfo:
							switch (rule.rule_method as WatcherRuleFileInfoMethods) {
								case WatcherRuleFileInfoMethods.FileName:
									input = path.parse(safeFilePath).name;
									break;
								case WatcherRuleFileInfoMethods.FileExtension:
									input = path.parse(safeFilePath).ext;
									break;
								case WatcherRuleFileInfoMethods.FileSize:
									input = ConvertBytesToMegabytes(
										(await fs.stat(safeFilePath)).size
									).toFixed(1);
									break;
							}
							break;
						case WatcherRuleBaseMethods.MediaInfo:
							const mediaInfo = await GetMediaInfo(safeFilePath);
							const videoStream = mediaInfo.streams.find(
								(stream) => stream.codec_type == 'video'
							);
							if (!videoStream) return false;

							switch (rule.rule_method) {
								case WatcherRuleMediaInfoMethods.MediaWidth:
									if (videoStream.width == undefined) return false;
									input = videoStream.width!.toString();
									break;
								case WatcherRuleMediaInfoMethods.MediaHeight:
									if (videoStream.height == undefined) return false;
									input = videoStream.height!.toString();
									break;
								case WatcherRuleMediaInfoMethods.MediaBitrate:
									if (videoStream.bit_rate == undefined) return false;
									input = ConvertBitsToKilobits(videoStream.bit_rate!).toFixed(0);
									break;
								case WatcherRuleMediaInfoMethods.MediaEncoder:
									if (videoStream.codec_long_name == undefined) return false;
									input = videoStream.codec_long_name!.toString();
									break;
							}
							break;
					}

					let result =
						comparisonMethod == WatcherRuleComparisonMethods.String
							? WatcherRuleStringComparison(
									input,
									rule.comparison_method as WatcherRuleStringComparisonMethods,
									rule.comparison
							  )
							: comparisonMethod == WatcherRuleComparisonMethods.Number
							? WatcherRuleNumberComparison(
									input,
									rule.comparison_method as WatcherRuleNumberComparisonMethods,
									rule.comparison
							  )
							: false;

					if (rule.mask == WatcherRuleMaskMethods.Exclude) {
						result = !result;
					}

					return result;
			  });

	if (!isValid) {
		logger.info(
			`[server] [watcher] Watcher for '${watcher.watch_path}'s ${
				Object.keys(watcher.rules).length
			} rule conditions have not been met for file '${path.basename(safeFilePath)}'`
		);
		return;
	}

	const isVideo = mime.getType(safeFilePath);
	if (isVideo && isVideo.includes('video')) {
		const existingJob = FindMatchingWatcherJob(await GetQueue(), watcher, safeFilePath);
		if (existingJob) {
			switch (existingJob.transcode_stage) {
				case TranscodeStage.Waiting:
					logger.info(
						`[server] [watcher] Job '${existingJob.job_id}' already exists for '${path.basename(
							filePath
						)}' and is waiting; no duplicate job will be created.`
					);
					await StartQueueIfStopped(watcher);
					return;
				case TranscodeStage.Scanning:
				case TranscodeStage.Transcoding:
				case TranscodeStage.Transferring:
				case TranscodeStage.Unknown:
					logger.info(
						`[server] [watcher] Job '${existingJob.job_id}' already exists for '${path.basename(
							filePath
						)}' and is active; no duplicate job will be created.`
					);
					return;
				case TranscodeStage.Stopped:
				case TranscodeStage.Error:
					logger.info(
						`[server] [watcher] Job '${existingJob.job_id}' already exists for '${path.basename(
							filePath
						)}' and will be reset instead of creating a duplicate.`
					);
					await ResetJob(existingJob.job_id);
					await StartQueueIfStopped(watcher);
					return;
				case TranscodeStage.Finished:
					logger.info(
						`[server] [watcher] Job '${existingJob.job_id}' already finished for '${path.basename(
							filePath
						)}'; no duplicate job will be created.`
					);
					return;
			}
		}

		const presetData = watcher.preset_category.match(/Default:/)
			? GetDefaultPresetByName(
					watcher.preset_category.replace(/Default:\s/, ''),
					watcher.preset_id
			  )
			: GetPresetByName(watcher.preset_category, watcher.preset_id);
		const presetFormat = presetData?.PresetList?.[0]?.FileFormat;
		const outputPathExtension = presetFormat ? PresetFormatDict[presetFormat] : undefined;

		if (!outputPathExtension) {
			logger.warn(
				`[server] [watcher] [warn] Watcher '${watcher.watcher_id}' could not find output format for preset '${watcher.preset_category}/${watcher.preset_id}'.`
			);
			return;
		}

		const parsedPath = path.parse(safeFilePath);
		const outputPathBase = watcher.output_path ? watcher.output_path : parsedPath.dir;
		const outputPathName = parsedPath.name;
		const outputPathFull = path.join(outputPathBase, outputPathName) + outputPathExtension;
		const checkedOutputItem = (
			await CheckFilenameCollision(outputPathBase, [
				{
					path: outputPathFull,
					name: outputPathName,
					extension: outputPathExtension,
					isDirectory: false,
				},
			])
		)[0];
		if (!checkedOutputItem) {
			logger.warn(
				`[server] [watcher] [warn] Watcher '${watcher.watcher_id}' could not resolve output path for '${filePath}'.`
			);
			return;
		}

		const newJobRequest: AddJobType = {
			input_path: safeFilePath,
			output_path: checkedOutputItem.path,
			preset_category: watcher.preset_category,
			preset_id: watcher.preset_id,
		};
		logger.info(
			`[server] [watcher] Watcher for '${watcher.watch_path}' is requesting a new job be made for the video file '${parsedPath.base}'.`
		);
		await AddJob(newJobRequest);
		await StartQueueIfStopped(watcher);
	}
}

async function onWatcherDetectFileDelete(watcher: DetailedWatcherType, filePath: string) {
	logger.info(
		`[server] [watcher] Watcher for '${
			watcher.watch_path
		}' has detected the removal of the file/directory '${path.basename(filePath)}'.`
	);

	const isVideo = mime.getType(filePath);
	if (isVideo && isVideo.includes('video')) {
		const queue = await GetQueue();
		const jobsForDeletedInput = queue.filter((job) => job.input_path == filePath);

		for (const job of jobsForDeletedInput) {
			switch (job.transcode_stage) {
				case TranscodeStage.Waiting:
					logger.info(
						`[server] [watcher] Watcher for '${watcher.watch_path}' is requesting removal of job '${job.job_id}' because the input file '${filePath}' has been deleted.`
					);
					await RemoveJob(job.job_id);
					break;
				case TranscodeStage.Scanning:
				case TranscodeStage.Transcoding:
				case TranscodeStage.Transferring:
				case TranscodeStage.Unknown:
					logger.info(
						`[server] [watcher] Watcher for '${watcher.watch_path}' is requesting stop of job '${job.job_id}' because the input file '${filePath}' has been deleted.`
					);
					await StopJob(job.job_id);
					break;
			}
		}
	}
}

function onWatcherDetectFileChange(watcher: DetailedWatcherType, filePath: string) {
	logger.info(
		`[server] [watcher] Watcher for '${
			watcher.watch_path
		}' has detected a change in the file '${path.basename(filePath)}'.`
	);
}

export async function UpdateWatchers() {
	const updatedWatchers = await DatabaseGetDetailedWatchers();
	EmitToAllClients('watchers-update', updatedWatchers);
}

export async function AddWatcher(watcher: AddWatcherType) {
	watcher.watch_path = await AssertExistingDirectoryInMediaRoots(watcher.watch_path, 'watch path');
	if (watcher.output_path) {
		watcher.output_path = await AssertExistingDirectoryInMediaRoots(
			watcher.output_path,
			'watcher output path'
		);
	}

	const result = await DatabaseInsertWatcher(watcher);
	await RegisterWatcher({ ...result, rules: [] });
	await UpdateWatchers();
}

export async function RemoveWatcher(watcherID: number) {
	await RemoveWatcherFromDatabase(watcherID);
	await DeregisterWatcher(watcherID);
	await UpdateWatchers();
}

export async function UpdateWatcher(watcherID: number, watcher: UpdateWatcherType) {
	if (watcher.watch_path) {
		watcher.watch_path = await AssertExistingDirectoryInMediaRoots(
			watcher.watch_path,
			'watch path'
		);
	}
	if (watcher.output_path) {
		watcher.output_path = await AssertExistingDirectoryInMediaRoots(
			watcher.output_path,
			'watcher output path'
		);
	}

	await DeregisterWatcher(watcherID);
	const updatedWatcher = await DatabaseUpdateWatcher(watcherID, watcher);
	await RegisterWatcher(updatedWatcher);
	await UpdateWatchers();
}

export async function AddWatcherRule(watcherID: number, rule: AddWatcherRuleType) {
	ValidateWatcherRule(rule);
	await DeregisterWatcher(watcherID);
	await DatabaseInsertWatcherRule(watcherID, rule);
	const updatedWatcher = await DatabaseGetDetailedWatcherByID(watcherID);
	await RegisterWatcher(updatedWatcher);
	await UpdateWatchers();
}

export async function UpdateWatcherRule(ruleID: number, rule: UpdateWatcherRuleType) {
	const watcherID = await DatabaseGetWatcherIDFromRule(ruleID);
	const existingRule = await DatabaseGetWatcherRuleByID(ruleID);
	ValidateWatcherRule({ ...existingRule, ...rule });
	await DeregisterWatcher(watcherID);
	await UpdateWatcherRuleInDatabase(ruleID, rule);
	const updatedWatcher = await DatabaseGetDetailedWatcherByID(watcherID);
	await RegisterWatcher(updatedWatcher);
	await UpdateWatchers();
}

export async function RemoveWatcherRule(ruleID: number) {
	const watcherID = await DatabaseGetWatcherIDFromRule(ruleID);
	await DeregisterWatcher(watcherID);
	await RemoveWatcherRuleFromDatabase(ruleID);
	const updatedWatcher = await DatabaseGetDetailedWatcherByID(watcherID);
	await RegisterWatcher(updatedWatcher);
	await UpdateWatchers();
}
