import { PresetFormatDict } from '@handbrake-web/shared/dict/presets.dict';
import type {
	AddJobType,
	AddWatcherRuleType,
	AddWatcherType,
	DetailedJobType,
	DetailedWatcherRuleType,
	DetailedWatcherType,
	UpdateWatcherRuleType,
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
	DatabaseInsertWatcher,
	DatabaseInsertWatcherRule,
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
import { AssertPathInMediaRoots } from './path-safety';

const watchers: { [index: number]: FSWatcher } = [];

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

export function RegisterWatcher(watcher: DetailedWatcherType) {
	AssertPathInMediaRoots(watcher.watch_path, 'watch path');
	if (watcher.output_path) {
		AssertPathInMediaRoots(watcher.output_path, 'watcher output path');
	}

	const newWatcher = chokidar.watch(watcher.watch_path, {
		awaitWriteFinish: true,
		ignoreInitial: true,
		ignorePermissionErrors: true,
	});

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
		handleWatcherEvent('add', filePath, onWatcherDetectFileAdd);
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

	watchers[watcher.watcher_id] = newWatcher;

	logger.info(`[server] [watcher] Registered watcher for '${watcher.watch_path}'.`);
}

export async function DeregisterWatcher(id: number) {
	try {
		// logger.info(watchers);
		if (!watchers[id]) {
			logger.info(`[server] [watcher] Watcher '${id}' is not registered.`);
			return;
		}
		const directory = Object.entries(watchers[id].getWatched())[0].join('/');
		await watchers[id].close();
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
			RegisterWatcher(watcher);
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
			const splitRegex = value.match(
				/\/((?![*+?])(?:[^\r\n\[/\\]|\\.|\[(?:[^\r\n\]\\]|\\.)*\])+)\/((?:g(?:im?|mi?)?|i(?:gm?|mg?)?|m(?:gi?|ig?)?)?)/
			);
			if (splitRegex) {
				return input.match(new RegExp(splitRegex[1], splitRegex[2])) ? true : false;
			} else {
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
	logger.info(
		`[server] [watcher] Watcher for '${
			watcher.watch_path
		}' has detected the creation of the file '${path.basename(filePath)}'.`
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
									input = path.parse(filePath).name;
									break;
								case WatcherRuleFileInfoMethods.FileExtension:
									input = path.parse(filePath).ext;
									break;
								case WatcherRuleFileInfoMethods.FileSize:
									input = ConvertBytesToMegabytes(
										(await fs.stat(filePath)).size
									).toFixed(1);
									break;
							}
							break;
						case WatcherRuleBaseMethods.MediaInfo:
							const mediaInfo = await GetMediaInfo(filePath);
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
			} rule conditions have not been met for file '${path.basename(filePath)}'`
		);
		return;
	}

	const isVideo = mime.getType(filePath);
	if (isVideo && isVideo.includes('video')) {
		const existingJob = FindMatchingWatcherJob(await GetQueue(), watcher, filePath);
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

		const parsedPath = path.parse(filePath);
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
			input_path: filePath,
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
	AssertPathInMediaRoots(watcher.watch_path, 'watch path');
	if (watcher.output_path) {
		AssertPathInMediaRoots(watcher.output_path, 'watcher output path');
	}

	const result = await DatabaseInsertWatcher(watcher);
	RegisterWatcher({ ...result, rules: [] });
	await UpdateWatchers();
}

export async function RemoveWatcher(watcherID: number) {
	await RemoveWatcherFromDatabase(watcherID);
	await DeregisterWatcher(watcherID);
	await UpdateWatchers();
}

export async function AddWatcherRule(watcherID: number, rule: AddWatcherRuleType) {
	await DeregisterWatcher(watcherID);
	await DatabaseInsertWatcherRule(watcherID, rule);
	const updatedWatcher = await DatabaseGetDetailedWatcherByID(watcherID);
	RegisterWatcher(updatedWatcher);
	await UpdateWatchers();
}

export async function UpdateWatcherRule(ruleID: number, rule: UpdateWatcherRuleType) {
	const watcherID = await DatabaseGetWatcherIDFromRule(ruleID);
	await DeregisterWatcher(watcherID);
	await UpdateWatcherRuleInDatabase(ruleID, rule);
	const updatedWatcher = await DatabaseGetDetailedWatcherByID(watcherID);
	RegisterWatcher(updatedWatcher);
	await UpdateWatchers();
}

export async function RemoveWatcherRule(ruleID: number) {
	const watcherID = await DatabaseGetWatcherIDFromRule(ruleID);
	await DeregisterWatcher(watcherID);
	await RemoveWatcherRuleFromDatabase(ruleID);
	const updatedWatcher = await DatabaseGetDetailedWatcherByID(watcherID);
	RegisterWatcher(updatedWatcher);
	await UpdateWatchers();
}
