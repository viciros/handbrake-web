import type {
	AddClientAuthType,
	ClientAuthType,
	UpdateClientAuthType,
} from '@handbrake-web/shared/types/database';
import logger from 'logging';
import { database } from './database';

const clientAuthID = 'client';

const normalizeClientAuth = (credentials: ClientAuthType): ClientAuthType => ({
	...credentials,
	must_change_credentials: Boolean(credentials.must_change_credentials),
});

export async function DatabaseGetClientAuth() {
	try {
		const credentials = await database
			.selectFrom('client_auth')
			.selectAll()
			.where('id', '=', clientAuthID)
			.executeTakeFirst();

		return credentials ? normalizeClientAuth(credentials) : undefined;
	} catch (err) {
		logger.error('[server] [database] [error] Could not get client auth credentials.');
		throw err;
	}
}

export async function DatabaseInsertClientAuth(credentials: Omit<AddClientAuthType, 'id'>) {
	try {
		await database
			.insertInto('client_auth')
			.values({ id: clientAuthID, ...credentials })
			.execute();

		return DatabaseGetClientAuth();
	} catch (err) {
		logger.error('[server] [database] [error] Could not insert client auth credentials.');
		throw err;
	}
}

export async function DatabaseUpdateClientAuth(credentials: UpdateClientAuthType) {
	try {
		await database
			.updateTable('client_auth')
			.set(credentials)
			.where('id', '=', clientAuthID)
			.execute();

		return DatabaseGetClientAuth();
	} catch (err) {
		logger.error('[server] [database] [error] Could not update client auth credentials.');
		throw err;
	}
}
