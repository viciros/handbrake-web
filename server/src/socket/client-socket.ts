import { type ConfigType } from '@handbrake-web/shared/types/config';
import type {
	AddJobType,
	AddWatcherRuleType,
	AddWatcherType,
	DetailedWatcherType,
	UpdateWatcherRuleType,
	UpdateWatcherType,
} from '@handbrake-web/shared/types/database';
import type {
	UpdateClientCredentialsResultType,
	UpdateClientCredentialsType,
	WorkerAuthTokenActionResultType,
	WorkerAuthTokenSecretResultType,
} from '@handbrake-web/shared/types/auth';
import {
	type CreateDirectoryRequestType,
	type DirectoryItemsType,
	type DirectoryRequestType,
	type DirectoryType,
} from '@handbrake-web/shared/types/directory';
import { type HandbrakePresetType } from '@handbrake-web/shared/types/preset';
import { type GithubReleaseResponseType } from '@handbrake-web/shared/types/version';
import logger from 'logging';
import {
	AuthenticateClientSocket,
	CreateWorkerAuthToken,
	GetClientAuthStatus,
	GetWorkerAuthTokenRecords,
	RevokeWorkerAuthToken,
	RotateWorkerAuthToken,
	UpdateClientAuthCredentials,
} from 'scripts/auth';
import { GetConfig, WriteConfig } from 'scripts/config/config';
import { AddClient, RemoveClient } from 'scripts/connections';
import {
	DatabaseGetJobOrderIndexByID,
	DatabaseUpdateJobOrderIndex,
} from 'scripts/database/database-queue';
import { DatabaseGetDetailedWatchers } from 'scripts/database/database-watcher';
import { CheckFilenameCollision, GetDirectoryItems, MakeDirectory } from 'scripts/files';
import {
	AddPreset,
	GetDefaultPresets,
	GetPresets,
	RemovePreset,
	RenamePreset,
} from 'scripts/presets';
import { GetWorkerProperties } from 'scripts/properties';
import {
	AddJob,
	ClearQueue,
	GetQueue,
	GetQueueStatus,
	RemoveJob,
	ResetJob,
	StartQueue,
	StopJob,
	StopQueue,
	UpdateQueue,
} from 'scripts/queue';
import { GetCurrentReleaseInfo, GetLatestReleaseInfo } from 'scripts/version';
import {
	AddWatcher,
	AddWatcherRule,
	RemoveWatcher,
	RemoveWatcherRule,
	UpdateWatcher,
	UpdateWatcherRule,
} from 'scripts/watcher';
import { Socket as Client, Server } from 'socket.io';

const initClient = async (socket: Client) => {
	socket.emit('auth-status-update', GetClientAuthStatus());
	socket.emit('config-update', GetConfig());
	socket.emit('queue-update', await GetQueue());
	socket.emit('presets-update', GetPresets());
	socket.emit('default-presets-update', GetDefaultPresets());
	socket.emit('queue-status-update', await GetQueueStatus());
	socket.emit('properties-update', GetWorkerProperties());
	socket.emit('worker-auth-tokens-update', await GetWorkerAuthTokenRecords());
	socket.emit('watchers-update', await DatabaseGetDetailedWatchers());
};

const logClientSocketError = (socketID: string, action: string, err: unknown) => {
	logger.error(`[socket] [error] Client '${socketID}' ${action}.`);
	logger.error(err);
};

export default function ClientSocket(io: Server) {
	const namespace = io.of('/client');
	namespace.use(AuthenticateClientSocket);

	namespace.on('connection', (socket) => {
		logger.info(`[socket] Client '${socket.id}' has connected.`);
		AddClient(socket);
		initClient(socket).catch((err) => {
			logClientSocketError(socket.id, 'could not be initialized', err);
		});

		const emitWorkerAuthTokensUpdate = async () => {
			namespace.emit('worker-auth-tokens-update', await GetWorkerAuthTokenRecords());
		};

		socket.on('disconnect', () => {
			logger.info(`[socket] Client '${socket.id}' has disconnected.`);
			RemoveClient(socket);
		});

		// Config ----------------------------------------------------------------------------------
		socket.on('config-update', async (config: ConfigType) => {
			await WriteConfig(config);
		});

		// Auth ------------------------------------------------------------------------------------
		socket.on(
			'update-client-credentials',
			async (
				data: UpdateClientCredentialsType,
				callback?: (result: UpdateClientCredentialsResultType) => void
			) => {
				try {
					const result = await UpdateClientAuthCredentials(data);
					callback?.(result);
					if (result.ok && result.status) {
						socket.emit('auth-status-update', result.status);
					}
				} catch (err) {
					logClientSocketError(socket.id, 'could not update client credentials', err);
					callback?.({
						ok: false,
						message: 'Could not update credentials.',
					});
				}
			}
		);

		socket.on(
			'create-worker-auth-token',
			async (
				workerID: string,
				callback?: (result: WorkerAuthTokenSecretResultType) => void
			) => {
				try {
					const result = await CreateWorkerAuthToken(workerID);
					callback?.(result);
					if (result.ok) await emitWorkerAuthTokensUpdate();
				} catch (err) {
					logClientSocketError(socket.id, 'could not create worker auth token', err);
					callback?.({
						ok: false,
						message: 'Could not create worker token.',
					});
				}
			}
		);

		socket.on(
			'rotate-worker-auth-token',
			async (
				workerID: string,
				callback?: (result: WorkerAuthTokenSecretResultType) => void
			) => {
				try {
					const result = await RotateWorkerAuthToken(workerID);
					callback?.(result);
					if (result.ok) await emitWorkerAuthTokensUpdate();
				} catch (err) {
					logClientSocketError(socket.id, 'could not rotate worker auth token', err);
					callback?.({
						ok: false,
						message: 'Could not rotate worker token.',
					});
				}
			}
		);

		socket.on(
			'revoke-worker-auth-token',
			async (
				workerID: string,
				callback?: (result: WorkerAuthTokenActionResultType) => void
			) => {
				try {
					const result = await RevokeWorkerAuthToken(workerID);
					callback?.(result);
					if (result.ok) await emitWorkerAuthTokensUpdate();
				} catch (err) {
					logClientSocketError(socket.id, 'could not revoke worker auth token', err);
					callback?.({
						ok: false,
						message: 'Could not revoke worker token.',
					});
				}
			}
		);

		// Queue -----------------------------------------------------------------------------------
		socket.on('start-queue', async () => {
			await StartQueue(socket.id);
		});

		socket.on('stop-queue', async () => {
			await StopQueue(socket.id);
		});

		socket.on('clear-queue', async (finishedOnly: boolean) => {
			await ClearQueue(socket.id, finishedOnly);
		});

		// Jobs ------------------------------------------------------------------------------------
		socket.on('add-job', async (data: AddJobType, callback?: () => void) => {
			logger.info(
				`[socket] Client '${socket.id}' has requested to add a job for '${data.input_path}' to the queue.`
			);
			try {
				await AddJob(data);
			} catch (err) {
				logClientSocketError(socket.id, `could not add job for '${data.input_path}'`, err);
			} finally {
				callback?.();
			}
		});

		socket.on('stop-job', async (jobID: number) => {
			await StopJob(jobID);
		});

		socket.on('reset-job', async (jobID: number) => {
			try {
				await ResetJob(jobID);
			} catch (err) {
				logger.error(`[socket] [error] Could not reset job '${jobID}'.`);
				logger.error(err);
			}
		});

		socket.on('remove-job', async (jobID: number) => {
			await RemoveJob(jobID);
		});

		socket.on('reorder-job', async (jobID: number, newOrderIndex: number) => {
			logger.info(
				`[socket] Client is requesting job at order index ${await DatabaseGetJobOrderIndexByID(
					jobID
				)} be reordered to index ${newOrderIndex}.`
			);
			await DatabaseUpdateJobOrderIndex(jobID, newOrderIndex);
			await UpdateQueue();
		});

		// Directory -------------------------------------------------------------------------------
		socket.on(
			'get-directory',
			async (
				request: DirectoryRequestType,
				callback: (directory: DirectoryType | null) => void
			) => {
				try {
					const items = await GetDirectoryItems(
						request.path,
						request.isRecursive,
						request.rootPath
					);
					callback(items ?? null);
				} catch (err) {
					logClientSocketError(
						socket.id,
						`could not get directory '${request.path}'`,
						err
					);
					callback(null);
				}
			}
		);

		socket.on(
			'make-directory',
			async (item: CreateDirectoryRequestType, callback: (result: boolean) => void) => {
				try {
					const result = await MakeDirectory(item.path, item.name, item.rootPath);
					callback(result);
				} catch (err) {
					logClientSocketError(
						socket.id,
						`could not make directory '${item.name}' in '${item.path}'`,
						err
					);
					callback(false);
				}
			}
		);

		socket.on(
			'check-name-collision',
			async (
				path: string,
				newItems: DirectoryItemsType,
				callback: (items: DirectoryItemsType) => void
			) => {
				try {
					const checkItems = await CheckFilenameCollision(path, newItems);
					callback(checkItems);
				} catch (err) {
					logClientSocketError(
						socket.id,
						`could not check name collisions in '${path}'`,
						err
					);
					callback(newItems);
				}
			}
		);

		// Preset ----------------------------------------------------------------------------------
		socket.on('add-preset', async (preset: HandbrakePresetType, category: string) => {
			await AddPreset(preset, category);
		});

		socket.on('remove-preset', async (presetName: string, category: string) => {
			await RemovePreset(presetName, category);
		});

		socket.on('rename-preset', async (oldName: string, newName: string, category: string) => {
			await RenamePreset(oldName, newName, category);
		});

		// Version ---------------------------------------------------------------------------------
		socket.on(
			'get-current-version-info',
			async (callback: (info: GithubReleaseResponseType | null) => void) => {
				const info = await GetCurrentReleaseInfo();
				callback(info);
			}
		);

		socket.on(
			'get-latest-version-info',
			async (callback: (info: GithubReleaseResponseType | null) => void) => {
				const info = await GetLatestReleaseInfo();
				callback(info);
			}
		);

		// Watchers --------------------------------------------------------------------------------
		socket.on(
			'get-watchers',
			async (callback: (watchers: DetailedWatcherType[] | undefined) => void) => {
				const watchers = await DatabaseGetDetailedWatchers();
				callback(watchers);
			}
		);

		socket.on('add-watcher', async (watcher: AddWatcherType) => {
			await AddWatcher(watcher);
		});

		socket.on('remove-watcher', async (id: number) => {
			await RemoveWatcher(id);
		});

		socket.on('update-watcher', async (id: number, watcher: UpdateWatcherType) => {
			await UpdateWatcher(id, watcher);
		});

		socket.on('add-watcher-rule', async (watcherID: number, rule: AddWatcherRuleType) => {
			await AddWatcherRule(watcherID, rule);
		});

		socket.on('update-watcher-rule', async (ruleID: number, rule: UpdateWatcherRuleType) => {
			await UpdateWatcherRule(ruleID, rule);
		});

		socket.on('remove-watcher-rule', async (ruleID: number) => {
			await RemoveWatcherRule(ruleID);
		});
	});
}
