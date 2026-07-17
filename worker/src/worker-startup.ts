import 'dotenv/config';
import logger from 'logging';
import { isIP } from 'node:net';
import { GetWorkerProperties } from 'scripts/properties';
import { io } from 'socket.io-client';
import ServerSocket from 'socket/server-socket';
import { ConnectionRetryController } from './connection-retry';
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

export const GetServerBaseAddress = (serverURL: string) => {
	if (!/^https?:\/\//i.test(serverURL)) {
		throw new Error("SERVER_URL must include an 'http://' or 'https://' prefix.");
	}

	const url = new URL(serverURL);
	const isPublicHost = !isLocalOrPrivateHost(url.hostname);

	if (url.protocol == 'http:' && isPublicHost) {
		throw new Error(
			`Remote worker connections to '${url.hostname}' must use HTTPS. Set SERVER_URL with an https:// prefix for public hosts.`
		);
	}
	if (url.protocol == 'https:' && isPublicHost && url.port == '80') {
		throw new Error(
			`Remote worker connections to '${url.hostname}' must not use port 80 with HTTPS.`
		);
	}

	return url.toString().replace(/\/$/, '');
};

const WaitForConfigurationRestart = (message: string) => {
	logger.error(
		`${message} The worker will remain online but cannot connect; update the environment and restart the container.`
	);
	setInterval(() => {
		logger.warn(`[socket] [warn] Worker is still waiting for corrected connection configuration.`);
	}, 5 * 60 * 1000);
};

export default async function WorkerStartup() {
	// Setup -------------------------------------------------------------------------------------------

	// Validate required connection configuration ----------------------------------
	const workerID = process.env.WORKER_ID;
	const workerToken = process.env.WORKER_TOKEN;
	const serverURL = process.env.SERVER_URL;
	const missingConfiguration = [
		!workerID ? 'WORKER_ID' : undefined,
		!workerToken ? 'WORKER_TOKEN' : undefined,
		!serverURL ? 'SERVER_URL' : undefined,
	].filter((value): value is string => value != undefined);
	if (missingConfiguration.length > 0) {
		WaitForConfigurationRestart(
			`Missing required worker configuration: ${missingConfiguration.join(', ')}.`
		);
		return;
	}

	// Init worker properties
	await GetWorkerProperties();

	// Setup the server ------------------------------------------------------------
	try {
		serverBaseAddress = GetServerBaseAddress(serverURL!);
	} catch (err) {
		WaitForConfigurationRestart(
			`Invalid SERVER_URL configuration: ${err instanceof Error ? err.message : String(err)}.`
		);
		return;
	}
	serverAddress = `${serverBaseAddress}/worker`;

	const server = io(serverAddress, {
		autoConnect: false,
		reconnection: false,
		auth: { token: workerToken },
		query: { workerID: workerID },
	});

	// Event listeners ---------------------------------------------------------------------------------
	const retryController = new ConnectionRetryController(() => server.connect(), logger);
	ServerSocket(server, retryController);
	RegisterExitListeners(server, retryController);

	// Worker Start ------------------------------------------------------------------------------------
	retryController.start();
	logger.info('The worker process has started.');
}
