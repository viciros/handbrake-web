import {
	CreatePrivateKeyFromRawPrivateKey,
	CreatePublicKeyFromRawPublicKey,
	GetServerChallengePayload,
	GetWorkerChallengePayload,
	SignWorkerAuthPayload,
	VerifyWorkerAuthPayload,
	type WorkerAuthChallenge,
} from '@handbrake-web/shared/scripts/worker-auth';
import 'dotenv/config';
import logger from 'logging';
import { GetWorkerProperties } from 'scripts/properties';
import { io } from 'socket.io-client';
import ServerSocket from 'socket/server-socket';
import { RegisterExitListeners } from './worker-shutdown';

export let serverAddress = '';
export let serverBaseAddress = '';

const getWorkerSocketAuth = async (workerID: string) => {
	const localPrivateKey = process.env.local_private_key;
	const remotePublicKey = process.env.remote_public_key;
	if (!localPrivateKey || !remotePublicKey) {
		throw new Error("Missing 'local_private_key'/'remote_public_key' environment variables.");
	}

	const challengeURL = new URL('/worker/auth/challenge', serverBaseAddress);
	challengeURL.searchParams.set('workerID', workerID);

	const response = await fetch(challengeURL);
	if (!response.ok) {
		throw new Error(`Could not get worker auth challenge: ${response.statusText}`);
	}

	const challenge = (await response.json()) as WorkerAuthChallenge;
	if (
		!VerifyWorkerAuthPayload(
			GetServerChallengePayload(challenge),
			challenge.serverSignature,
			remotePublicKey
		)
	) {
		throw new Error('The server auth challenge signature is invalid.');
	}

	return {
		challengeID: challenge.challengeID,
		workerSignature: SignWorkerAuthPayload(
			GetWorkerChallengePayload(challenge),
			localPrivateKey
		),
	};
};

export default async function WorkerStartup() {
	// Setup -------------------------------------------------------------------------------------------

	// Get worker ID from env variable, exit process if it is not set --------------
	const workerID = process.env.WORKER_ID;
	const localPrivateKey = process.env.local_private_key;
	const remotePublicKey = process.env.remote_public_key;
	if (!workerID) {
		logger.error(
			"No 'WORKER_ID' envrionment variable is set - this worker will not be set up. Please set this via your docker-compose environment section."
		);
		process.exit(0);
	}
	if (!localPrivateKey || !remotePublicKey) {
		logger.error(
			"No 'local_private_key'/'remote_public_key' environment variables are set - this worker cannot authenticate to the server."
		);
		process.exit(0);
	}
	CreatePrivateKeyFromRawPrivateKey(localPrivateKey);
	CreatePublicKeyFromRawPublicKey(remotePublicKey);

	// Init worker properties
	await GetWorkerProperties();

	// Setup the server ------------------------------------------------------------
	const serverURL = process.env.SERVER_URL;
	const serverURLPrefix = serverURL?.match(/^https?:\/\//);
	const serverPort = process.env.SERVER_PORT;
	serverBaseAddress = `${serverURLPrefix ? serverURL : 'http://' + serverURL}:${serverPort}`;
	serverAddress = `${serverBaseAddress}/worker`;

	const canConnect = serverURL != undefined && serverPort != undefined;
	const server = io(serverAddress, {
		autoConnect: false,
		auth: (callback) => {
			void (async () => {
				try {
					callback(await getWorkerSocketAuth(workerID));
				} catch (err) {
					logger.error(`[auth] [error] Could not prepare worker socket auth.`);
					logger.error(err);
					callback({});
				}
			})();
		},
		query: { workerID: workerID },
	});

	// Event listeners ---------------------------------------------------------------------------------
	ServerSocket(server);
	RegisterExitListeners(server);

	// Worker Start ------------------------------------------------------------------------------------
	if (canConnect) {
		server.connect();
		logger.info('The worker process has started.');
	} else {
		logger.error(
			'The SERVER_URL or SERVER_PORT environment variables are not set, no valid server to connect to.'
		);
	}
}
