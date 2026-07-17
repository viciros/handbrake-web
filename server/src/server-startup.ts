import cors from 'cors';
import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';

import logger from 'logging';
import ClientRoutes from 'routes/client';
import { corsOptions, InitializeClientAuth } from 'scripts/auth';
import { LoadConfig } from 'scripts/config/config';
import { DatabaseConnect } from 'scripts/database/database';
import { LoadDefaultPresets, LoadPresets } from 'scripts/presets';
import { InitializeQueue } from 'scripts/queue';
import { CheckForVersionUpdate } from 'scripts/version';
import { RegisterWorkerLogRoutes } from 'scripts/worker-logs';
import { RegisterWorkerTransferRoutes } from 'scripts/worker-transfers';
import { InitializeWatchers } from 'scripts/watcher';
import ClientSocket from 'socket/client-socket';
import WorkerSocket from 'socket/worker-socket';
import { RegisterExitListeners } from './server-shutdown';

const getServerListenConfig = () => {
	const serverURL = process.env.SERVER_URL || 'http://localhost:9999';
	if (!/^https?:\/\//i.test(serverURL)) {
		throw new Error("SERVER_URL must include an 'http://' or 'https://' prefix.");
	}

	const url = new URL(serverURL);
	const port = url.port
		? Number.parseInt(url.port, 10)
		: url.protocol == 'https:'
		? 443
		: 80;

	return {
		port,
		serverAddress: url.toString().replace(/\/$/, ''),
	};
};

export default async function ServerStartup() {
	// Config---------------------------------------------------------------------------------------
	await LoadConfig();

	// Presets -------------------------------------------------------------------------------------
	await LoadDefaultPresets();
	await LoadPresets();

	// Database ------------------------------------------------------------------------------------
	await DatabaseConnect();
	await InitializeClientAuth();
	await InitializeQueue();
	await InitializeWatchers();

	// Setup Server --------------------------------------------------------------------------------
	const app = express();
	const server = createServer(app);
	const socket = new SocketServer(server, {
		cors: corsOptions,
		pingTimeout: 20000,
	});

	app.use(cors(corsOptions));

	// Routes ------------------------------------------------------------------------------
	RegisterWorkerLogRoutes(app);
	RegisterWorkerTransferRoutes(app);
	ClientRoutes(app);

	// Socket Listeners --------------------------------------------------------------------
	ClientSocket(socket);
	WorkerSocket(socket);

	// Shutdown ------------------------------------------------------------------------------------
	RegisterExitListeners(socket);

	// Start Server --------------------------------------------------------------------------------
	const { port, serverAddress } = getServerListenConfig();

	await new Promise<void>((resolve) => {
		server.listen(port, () => {
			logger.info(`[server] Available at '${serverAddress}'.`);
			resolve();
		});
		socket.attach(server);
	});

	// Check Version -------------------------------------------------------------------------------
	await CheckForVersionUpdate();
}
