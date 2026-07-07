import type {
	AddWorkerAuthTokenType,
	UpdateWorkerAuthTokenType,
	WorkerAuthTokenType,
} from '@handbrake-web/shared/types/database';
import logger from 'logging';
import { database } from './database';

const normalizeWorkerAuthToken = (token: WorkerAuthTokenType): WorkerAuthTokenType => ({
	...token,
	is_enabled: token.is_enabled == undefined ? true : Boolean(token.is_enabled),
	last_used_at: token.last_used_at ?? null,
});

export async function DatabaseGetWorkerAuthTokens() {
	try {
		const tokens = await database
			.selectFrom('worker_auth_tokens')
			.selectAll()
			.orderBy('worker_id', 'asc')
			.execute();

		return tokens.map(normalizeWorkerAuthToken);
	} catch (err) {
		logger.error('[server] [database] [error] Could not get worker auth tokens.');
		throw err;
	}
}

export async function DatabaseGetWorkerAuthToken(workerID: string) {
	try {
		const token = await database
			.selectFrom('worker_auth_tokens')
			.selectAll()
			.where('worker_id', '=', workerID)
			.executeTakeFirst();

		return token ? normalizeWorkerAuthToken(token) : undefined;
	} catch (err) {
		logger.error(
			`[server] [database] [error] Could not get worker auth token for '${workerID}'.`
		);
		throw err;
	}
}

export async function DatabaseInsertWorkerAuthToken(token: AddWorkerAuthTokenType) {
	try {
		await database.insertInto('worker_auth_tokens').values(token).execute();

		return DatabaseGetWorkerAuthToken(token.worker_id);
	} catch (err) {
		logger.error(
			`[server] [database] [error] Could not insert worker auth token for '${token.worker_id}'.`
		);
		throw err;
	}
}

export async function DatabaseUpdateWorkerAuthToken(
	workerID: string,
	token: Omit<UpdateWorkerAuthTokenType, 'worker_id'>
) {
	try {
		await database
			.updateTable('worker_auth_tokens')
			.set(token)
			.where('worker_id', '=', workerID)
			.execute();

		return DatabaseGetWorkerAuthToken(workerID);
	} catch (err) {
		logger.error(
			`[server] [database] [error] Could not update worker auth token for '${workerID}'.`
		);
		throw err;
	}
}

export async function DatabaseDeleteWorkerAuthToken(workerID: string) {
	try {
		const result = await database
			.deleteFrom('worker_auth_tokens')
			.where('worker_id', '=', workerID)
			.executeTakeFirst();

		return Number(result.numDeletedRows) > 0;
	} catch (err) {
		logger.error(
			`[server] [database] [error] Could not delete worker auth token for '${workerID}'.`
		);
		throw err;
	}
}
