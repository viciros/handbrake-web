import {
	ClientAuthStatusType,
	WorkerAuthTokenRecordType,
} from '@handbrake-web/shared/types/auth';
import { ConfigType } from '@handbrake-web/shared/types/config';
import { DetailedWatcherType } from '@handbrake-web/shared/types/database';
import { HandbrakePresetCategoryType } from '@handbrake-web/shared/types/preset';
import { QueueStatus, QueueType } from '@handbrake-web/shared/types/queue';
import { ConnectionIDsType } from '@handbrake-web/shared/types/socket';
import { WorkerPropertiesMap } from '@handbrake-web/shared/types/worker';
import { Outlet } from '@tanstack/react-router';
import { Fragment, useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import UpdateClientCredentials from '~components/overlays/update-client-credentials';
import SideBar from '~components/root/side-bar';
import NoConnection from '~pages/_default/no-connection';
import { PrimaryContext } from './context';
// import styles from './styles.module.scss';

export default function PrimaryLayout() {
	const baseURLRegex = /(^https?:\/\/.+\/)(.+$)/;
	const serverURL = (
		import.meta.env.PROD ? window.location.href : 'http://localhost:9999/'
	).replace(baseURLRegex, '$1');

	const serverSocketPath = 'client';
	const server = `${serverURL}${serverSocketPath}`;

	const [socket] = useState(() => io(server, { autoConnect: false, withCredentials: true }));
	const [isConnected, setIsConnected] = useState(false);
	const [authStatus, setAuthStatus] = useState<ClientAuthStatusType>();
	const [config, setConfig] = useState<ConfigType>();
	const [queue, setQueue] = useState<QueueType>([]);
	const [queueStatus, setQueueStatus] = useState<QueueStatus>(QueueStatus.Idle);
	const [presets, setPresets] = useState<HandbrakePresetCategoryType>({});
	const [defaultPresets, setDefaultPresets] = useState<HandbrakePresetCategoryType>({});
	const [connections, setConnections] = useState<ConnectionIDsType>({
		clients: [],
		workers: [],
	});
	const [properties, setProperties] = useState<WorkerPropertiesMap>({});
	const [workerTokens, setWorkerTokens] = useState<WorkerAuthTokenRecordType[]>([]);
	const [watchers, setWatchers] = useState<DetailedWatcherType[]>([]);
	const [showSidebar, setShowSidebar] = useState(false);

	// Connect to server -------------------------------------------------------
	useEffect(() => {
		console.log(`[client] Connecting to '${server}...'`);
		socket.connect();

		return () => {
			socket.disconnect();
		};
	}, [server, socket]);

	// Error event listeners ---------------------------------------------------
	const onConnect = () => {
		console.log(`[client] Connection established to '${server}'`);
		setIsConnected(true);
	};

	const onConnectError = (error: Error) => {
		console.error(`[client] Error has occurred connecting to '${server}':`);
		console.error(error);
		setIsConnected(false);
	};

	const onDisconnect = (reason: string) => {
		console.log(`[client] Disconnected from '${server}' because ${reason}`);
		setIsConnected(false);
	};

	useEffect(() => {
		socket.on('connect', onConnect);
		socket.on('connect_error', onConnectError);
		socket.on('disconnect', onDisconnect);

		return () => {
			socket.off('connect', onConnect);
			socket.off('connect_error', onConnectError);
			socket.off('disconnect', onDisconnect);
		};
	}, [server, socket]);

	// Server event listeners --------------------------------------------------
	const onAuthStatusUpdate = (status: ClientAuthStatusType) => {
		console.log(`[client] Auth status has been updated.`);
		setAuthStatus(status);
	};

	const onConfigUpdate = (config: ConfigType) => {
		console.log(`[client] The config has been updated.`);
		setConfig(config);
	};

	const onQueueUpdate = (queue: QueueType) => {
		console.log(`[client] The queue has been updated.`);
		setQueue(queue);
	};

	const onQueueStatusUpdate = (newQueueStatus: QueueStatus) => {
		const prevStatus = queueStatus;
		console.log(
			`[client] The queue status has changed from '${QueueStatus[prevStatus]}' to '${QueueStatus[newQueueStatus]}'`
		);
		setQueueStatus(newQueueStatus);
	};

	const onPresetsUpdate = (presets: HandbrakePresetCategoryType) => {
		console.log('[client] Presets have been updated.');
		setPresets(presets);
	};

	const onDefaultPresetsUpdate = (defaultPresets: HandbrakePresetCategoryType) => {
		console.log('[client] Default presets have been updated.');
		setDefaultPresets(defaultPresets);
	};

	const onConnectionsUpdate = (data: ConnectionIDsType) => {
		console.log(`[client] Connections have been updated.`);
		setConnections(data);
	};

	const onPropertiesUpdate = (data: WorkerPropertiesMap) => {
		console.log(`[client] Worker properties have been updated.`);
		setProperties(data);
	};

	const onWorkerAuthTokensUpdate = (data: WorkerAuthTokenRecordType[]) => {
		console.log(`[client] Worker auth tokens have been updated.`);
		setWorkerTokens(data);
	};

	const onWatchersUpdate = (watchers: DetailedWatcherType[]) => {
		console.log('[client] Watchers have been updated.');
		// console.log(watchers);
		setWatchers(watchers);
	};

	useEffect(() => {
		socket.on('auth-status-update', onAuthStatusUpdate);
		socket.on('config-update', onConfigUpdate);
		socket.on('queue-update', onQueueUpdate);
		socket.on('queue-status-update', onQueueStatusUpdate);
		socket.on('presets-update', onPresetsUpdate);
		socket.on('default-presets-update', onDefaultPresetsUpdate);
		socket.on('connections-update', onConnectionsUpdate);
		socket.on('properties-update', onPropertiesUpdate);
		socket.on('worker-auth-tokens-update', onWorkerAuthTokensUpdate);
		socket.on('watchers-update', onWatchersUpdate);

		return () => {
			socket.off('auth-status-update', onAuthStatusUpdate);
			socket.off('config-update', onConfigUpdate);
			socket.off('queue-update', onQueueUpdate);
			socket.off('queue-status-update', onQueueStatusUpdate);
			socket.off('presets-update', onPresetsUpdate);
			socket.off('default-presets-update', onDefaultPresetsUpdate);
			socket.off('connections-update', onConnectionsUpdate);
			socket.off('properties-update', onPropertiesUpdate);
			socket.off('worker-auth-tokens-update', onWorkerAuthTokensUpdate);
			socket.off('watchers-update', onWatchersUpdate);
		};
	}, [queueStatus, socket]);

	return (
		<Fragment>
			<SideBar
				showSidebar={showSidebar}
				setShowSidebar={setShowSidebar}
				socket={socket}
				config={config}
			/>
			{isConnected && config != undefined && authStatus != undefined ? (
				<PrimaryContext
					value={{
						serverURL,
						socket,
						authStatus,
						queue,
						queueStatus,
						presets,
						defaultPresets,
						connections,
						properties,
						workerTokens,
						config,
						watchers,
					}}
				>
					<Outlet />
					{authStatus.must_change_credentials && <UpdateClientCredentials />}
				</PrimaryContext>
			) : (
				<NoConnection url={serverURL} />
			)}
		</Fragment>
	);
}
