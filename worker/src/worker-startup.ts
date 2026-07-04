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
import { isIP } from 'node:net';
import { GetWorkerProperties } from 'scripts/properties';
import { io } from 'socket.io-client';
import ServerSocket from 'socket/server-socket';
import { RegisterExitListeners } from './worker-shutdown';

export let serverAddress = '';
export let serverBaseAddress = '';

const isPrivateIPv4 = (hostname: string) => {
	const parts = hostname.split('.').map((part) => Number.parseInt(part, 10));
	if (parts.length != 4 || parts.some((part) => !Number.isInteger(part))) return false;

	const first = parts[0]!;
	const second = parts[1]!;
	return (
		first == 10 ||
		first == 127 ||
		(first == 172 && second >= 16 && second <= 31) ||
		(first == 192 && second == 168) ||
		(first == 169 && second == 254)
	);
};

const isLocalOrPrivateHost = (hostname: string) => {
	const normalizedHost = hostname.toLowerCase();
	const ipVersion = isIP(normalizedHost);

	if (normalizedHost == 'localhost' || normalizedHost == 'host.docker.internal') return true;
	if (!normalizedHost.includes('.') && ipVersion == 0) return true;
	if (normalizedHost.endsWith('.local')) return true;
	if (ipVersion == 4) return isPrivateIPv4(normalizedHost);
	if (ipVersion == 6) {
		return (
			normalizedHost == '::1' ||
			normalizedHost.startsWith('fc') ||
			normalizedHost.startsWith('fd') ||
			normalizedHost.startsWith('fe80')
		);
	}

	return false;
};

export const GetServerBaseAddress = (serverURL: string, serverPort: string) => {
	const hasPrefix = /^https?:\/\//i.test(serverURL);
	const url = new URL(`${hasPrefix ? serverURL : 'http://' + serverURL}:${serverPort}`);

	if (url.protocol == 'http:' && !isLocalOrPrivateHost(url.hostname)) {
		throw new Error(
			`Remote worker connections to '${url.hostname}' must use HTTPS. Set SERVER_URL with an https:// prefix for public hosts.`
		);
	}

	return url.toString().replace(/\/$/, '');
};

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
	const serverPort = process.env.SERVER_PORT;

	const canConnect = serverURL != undefined && serverPort != undefined;
	if (canConnect) {
		serverBaseAddress = GetServerBaseAddress(serverURL, serverPort);
		serverAddress = `${serverBaseAddress}/worker`;
	}

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
