import type {
	WorkerAuthTokenActionResultType,
	WorkerAuthTokenRecordType,
	WorkerAuthTokenSecretResultType,
} from '@handbrake-web/shared/types/auth';
import type { WorkerCapabilities } from '@handbrake-web/shared/types/worker';
import ClipboardIcon from '@icons/clipboard.svg?react';
import CloseIcon from '@icons/x-lg.svg?react';
import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import ButtonInput from '~components/base/inputs/button';
import Overlay from '~components/root/overlay';
import Section from '~components/root/section';
import type { WorkerInfo, WorkerInfoMap } from '../..';
import styles from './styles.module.scss';

type TokenSecret = {
	workerID: string;
	token: string;
};

type Props = {
	socket: Socket;
	workerInfo: WorkerInfoMap;
	workerTokens: WorkerAuthTokenRecordType[];
};

type WorkerRowProps = {
	acceptsJobs: boolean;
	info?: WorkerInfo;
	isPending: boolean;
	lastUsedAt: number | null;
	onRevoke: (workerID: string) => void;
	onRotate: (workerID: string) => void;
	onSetEnabled: (workerID: string, acceptsJobs: boolean) => void;
	workerID: string;
};

const capabilityLabels: Record<keyof WorkerCapabilities, string> = {
	cpu: 'CPU',
	qsv: 'Intel QSV',
	nvenc: 'NVIDIA NVENC',
	vcn: 'AMD VCN',
};

const formatTimestamp = (timestamp: number | null) => {
	if (!timestamp) return 'Never';
	return new Date(timestamp).toLocaleString(undefined, {
		dateStyle: 'short',
		timeStyle: 'short',
	});
};

const getFileName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;

const copyTextFallback = (text: string) => {
	const textarea = document.createElement('textarea');
	textarea.value = text;
	textarea.setAttribute('readonly', '');
	textarea.style.position = 'fixed';
	textarea.style.left = '-9999px';
	textarea.style.top = '0';

	document.body.appendChild(textarea);
	textarea.focus();
	textarea.select();

	try {
		return document.execCommand('copy');
	} finally {
		document.body.removeChild(textarea);
	}
};

const copyText = async (text: string) => {
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			return copyTextFallback(text);
		}
	}

	return copyTextFallback(text);
};

const WorkerRow = memo(function WorkerRow({
	acceptsJobs,
	info,
	isPending,
	lastUsedAt,
	onRevoke,
	onRotate,
	onSetEnabled,
	workerID,
}: WorkerRowProps) {
	const [detailsOpen, setDetailsOpen] = useState(false);
	const detailsID = useId();
	const isOnline = info != null;
	const cpuPercent = info?.resourceUsage?.host_cpu_percent;
	const progress = info?.job?.progress;
	const properties = info?.properties;
	const supportedEncoders = properties
		? (Object.entries(properties.capabilities) as [keyof WorkerCapabilities, boolean][])
				.filter(([, supported]) => supported)
				.map(([capability]) => capabilityLabels[capability])
				.join(' · ') || 'None'
		: isOnline
			? 'Loading'
			: '—';
	const cpuLabel = !isOnline
		? '—'
		: !info.resourceUsage
			? 'Collecting'
			: cpuPercent == null
				? 'Unavailable'
				: `${cpuPercent.toFixed(1)}%`;

	return (
		<tbody>
			<tr className={styles['worker-row']}>
				<td className={styles['worker-name']}>{workerID}</td>
				<td className={styles['connection']} data-online={isOnline}>
					{isOnline ? 'Online' : 'Offline'}
				</td>
				<td
					className={styles['activity']}
					data-working={isOnline ? info.status == 'Working' : undefined}
				>
					{isOnline ? info.status : '—'}
				</td>
				<td className={styles['metric-cell']}>
					<div className={cpuPercent == null ? styles['unavailable'] : styles['metric-value']}>
						{cpuLabel}
					</div>
					{cpuPercent != null && (
						<div className={styles['meter']} aria-hidden='true'>
							<div className={styles['meter-fill']} style={{ width: `${cpuPercent}%` }} />
						</div>
					)}
				</td>
				<td
					className={info?.job ? styles['job-cell'] : styles['unavailable']}
					title={info?.job?.inputPath}
				>
					{info?.job ? getFileName(info.job.inputPath) : isOnline ? 'No active job' : '—'}
				</td>
				<td className={styles['metric-cell']}>
					{progress != null ? (
						<>
							<div className={styles['metric-value']}>{progress.toFixed(1)}%</div>
							<div className={styles['meter']} aria-hidden='true'>
								<div className={styles['meter-fill']} style={{ width: `${progress}%` }} />
							</div>
						</>
					) : (
						<span className={styles['unavailable']}>—</span>
					)}
				</td>
				<td>
					<button
						aria-busy={isPending}
						aria-checked={acceptsJobs}
						aria-label={`Worker ${workerID}`}
						className={styles['enabled-switch']}
						data-enabled={acceptsJobs}
						disabled={isPending}
						onClick={() => onSetEnabled(workerID, !acceptsJobs)}
						role='switch'
						type='button'
					>
						<span className={styles['switch-track']} aria-hidden='true'>
							<span className={styles['switch-indicator']} />
						</span>
						<span className={styles['switch-label']}>
							{acceptsJobs ? 'Enabled' : 'Disabled'}
						</span>
					</button>
				</td>
				<td>
					<div className={styles['token-actions']}>
						<ButtonInput
							aria-busy={isPending}
							className={`${styles['table-action']} ${styles['rotate-action']}`}
							label='Rotate Token'
							color='blue'
							disabled={isPending}
							onClick={() => onRotate(workerID)}
						/>
						<ButtonInput
							aria-busy={isPending}
							className={styles['table-action']}
							label='Revoke'
							color='red'
							disabled={isPending}
							onClick={() => onRevoke(workerID)}
						/>
					</div>
				</td>
				<td>
					<button
						aria-controls={detailsID}
						aria-expanded={detailsOpen}
						className={styles['details-button']}
						onClick={() => setDetailsOpen((open) => !open)}
						type='button'
					>
						<span aria-hidden='true'>{detailsOpen ? '−' : '+'}</span> Details
					</button>
				</td>
			</tr>
			<tr className={styles['details-row']} id={detailsID} hidden={!detailsOpen}>
				<td colSpan={9}>
					<div className={styles['details-grid']}>
						<div className={styles['detail']}>
							<h3>Last Seen</h3>
							<div>{isOnline ? 'Online now' : formatTimestamp(lastUsedAt)}</div>
						</div>
						<div className={styles['detail']}>
							<h3>Application Version</h3>
							<div>{properties?.version.application || (isOnline ? 'Loading' : '—')}</div>
						</div>
						<div className={styles['detail']}>
							<h3>HandBrake Version</h3>
							<div>{properties?.version.handbrake || (isOnline ? 'Loading' : '—')}</div>
						</div>
						<div className={styles['detail']}>
							<h3>Supported Encoders</h3>
							<div>{supportedEncoders}</div>
						</div>
					</div>
				</td>
			</tr>
		</tbody>
	);
});

export default function WorkersSection({ socket, workerInfo, workerTokens }: Props) {
	const [workerID, setWorkerID] = useState('');
	const [message, setMessage] = useState('');
	const [isSaving, setIsSaving] = useState(false);
	const [secret, setSecret] = useState<TokenSecret>();
	const [copyMessage, setCopyMessage] = useState('');
	const [pendingWorkerIDs, setPendingWorkerIDs] = useState<ReadonlySet<string>>(
		() => new Set()
	);
	const pendingWorkerIDsRef = useRef(new Set<string>());
	const trimmedWorkerID = workerID.trim();
	const beginWorkerAction = useCallback((actionWorkerID: string) => {
		if (pendingWorkerIDsRef.current.has(actionWorkerID)) return false;

		pendingWorkerIDsRef.current.add(actionWorkerID);
		setPendingWorkerIDs(new Set(pendingWorkerIDsRef.current));
		return true;
	}, []);
	const finishWorkerAction = useCallback((actionWorkerID: string) => {
		pendingWorkerIDsRef.current.delete(actionWorkerID);
		setPendingWorkerIDs(new Set(pendingWorkerIDsRef.current));
	}, []);

	useEffect(() => {
		const clearPendingWorkers = () => {
			if (pendingWorkerIDsRef.current.size == 0) return;

			pendingWorkerIDsRef.current.clear();
			setPendingWorkerIDs(new Set());
		};

		socket.on('disconnect', clearPendingWorkers);
		return () => {
			socket.off('disconnect', clearPendingWorkers);
		};
	}, [socket]);

	const handleSecretResult = useCallback(
		(fallbackWorkerID: string, result: WorkerAuthTokenSecretResultType) => {
			setIsSaving(false);
			setMessage(result.message || (result.ok ? 'Worker token updated.' : 'Update failed.'));

			if (result.ok && result.token) {
				setSecret({
					workerID: result.record?.worker_id || fallbackWorkerID,
					token: result.token,
				});
				setCopyMessage('');
				setWorkerID('');
			}
		},
		[]
	);

	const createToken = () => {
		if (!trimmedWorkerID || isSaving) return;

		setIsSaving(true);
		setMessage('');
		socket.emit(
			'create-worker-auth-token',
			trimmedWorkerID,
			(result: WorkerAuthTokenSecretResultType) => {
				handleSecretResult(trimmedWorkerID, result);
			}
		);
	};

	const rotateToken = useCallback(
		(workerID: string) => {
			if (pendingWorkerIDsRef.current.has(workerID)) return;
			if (
				!window.confirm(
					`Rotate the token for '${workerID}'? Any active job will be stopped, then the worker will be disconnected.`
				)
			) {
				return;
			}
			if (!beginWorkerAction(workerID)) return;

			setMessage('');
			socket.emit(
				'rotate-worker-auth-token',
				workerID,
				(result: WorkerAuthTokenSecretResultType) => {
					finishWorkerAction(workerID);
					handleSecretResult(workerID, result);
				}
			);
		},
		[beginWorkerAction, finishWorkerAction, handleSecretResult, socket]
	);

	const revokeToken = useCallback(
		(workerID: string) => {
			if (pendingWorkerIDsRef.current.has(workerID)) return;
			if (
				!window.confirm(
					`Revoke the token for '${workerID}'? Any active job will be stopped, then the worker will be disconnected.`
				)
			) {
				return;
			}
			if (!beginWorkerAction(workerID)) return;

			setMessage('');
			socket.emit(
				'revoke-worker-auth-token',
				workerID,
				(result: WorkerAuthTokenActionResultType) => {
					finishWorkerAction(workerID);
					setMessage(
						result.message || (result.ok ? 'Worker token revoked.' : 'Update failed.')
					);
				}
			);
		},
		[beginWorkerAction, finishWorkerAction, socket]
	);

	const setWorkerEnabled = useCallback(
		(workerID: string, acceptsJobs: boolean) => {
			if (!beginWorkerAction(workerID)) return;
			setMessage('');
			socket.emit(
				'set-worker-enabled',
				workerID,
				acceptsJobs,
				(result: WorkerAuthTokenActionResultType) => {
					finishWorkerAction(workerID);
					setMessage(
						result.message ||
							(result.ok
								? `Worker ${acceptsJobs ? 'enabled' : 'disabled'}.`
								: 'Update failed.')
					);
				}
			);
		},
		[beginWorkerAction, finishWorkerAction, socket]
	);

	const copySecret = () => {
		if (!secret) return;

		copyText(secret.token)
			.then((copied) => {
				setCopyMessage(copied ? 'Copied.' : 'Copy failed.');
			})
			.catch(() => {
				setCopyMessage('Copy failed.');
			});
	};

	return (
		<>
			<Section className={styles['create-token-section']}>
				<div className={styles['create-token-form']}>
					<label className={styles['create-heading']} htmlFor='worker-token-id'>
						Create Worker Token
					</label>
					<input
						className={styles['worker-id-input']}
						id='worker-token-id'
						placeholder='Worker ID'
						value={workerID}
						onChange={(event) => setWorkerID(event.target.value)}
						onKeyDown={(event) => {
							if (event.key == 'Enter') createToken();
						}}
					/>
					<ButtonInput
						className={styles['create-button']}
						label={isSaving ? 'Creating' : 'Create Token'}
						color='blue'
						disabled={!trimmedWorkerID || isSaving}
						onClick={createToken}
					/>
					<p className={styles['create-help']}>
						The <code>WORKER_ID</code> environment variable must match the chosen Worked ID.
					</p>
				</div>
				<div className={styles['message']} role='status' aria-live='polite'>
					{message || '\u00a0'}
				</div>
			</Section>

			<Section className={styles['workers-section']} heading='Registered Workers'>
				<div className={styles['table-frame']}>
					<table className={styles['worker-table']}>
						<thead>
							<tr>
								<th scope='col'>Worker</th>
								<th scope='col'>Connection</th>
								<th scope='col'>Activity</th>
								<th scope='col'>Host CPU</th>
								<th scope='col'>Current Job</th>
								<th scope='col'>Progress</th>
								<th scope='col'>Worker State</th>
								<th scope='col'>Token Actions</th>
								<th scope='col'>Details</th>
							</tr>
						</thead>
						{workerTokens.length == 0 ? (
							<tbody>
								<tr>
									<td className={styles['empty']} colSpan={9}>
										No worker tokens have been created.
									</td>
								</tr>
							</tbody>
						) : (
							workerTokens.map((record) => (
								<WorkerRow
									acceptsJobs={record.accepts_jobs}
									info={workerInfo[record.worker_id]}
									isPending={pendingWorkerIDs.has(record.worker_id)}
									key={record.worker_id}
									lastUsedAt={record.last_used_at}
									onRevoke={revokeToken}
									onRotate={rotateToken}
									onSetEnabled={setWorkerEnabled}
									workerID={record.worker_id}
								/>
							))
						)}
					</table>
				</div>
			</Section>

			{secret && (
				<Overlay className={styles['token-overlay']}>
					<div className={styles['token-window']}>
						<h2>Worker Token</h2>
						<div className={styles['secret-worker']}>{secret.workerID}</div>
						<code className={styles['secret-token']}>{secret.token}</code>
						<div className={styles['overlay-message']}>
							This token is shown once. Save it as the worker's WORKER_TOKEN environment
							variable.
						</div>
						{copyMessage && <div className={styles['message']}>{copyMessage}</div>}
						<div className={styles['overlay-actions']}>
							<ButtonInput
								label='Copy'
								Icon={ClipboardIcon}
								color='blue'
								onClick={copySecret}
							/>
							<ButtonInput
								label='Close'
								Icon={CloseIcon}
								color='green'
								onClick={() => setSecret(undefined)}
							/>
						</div>
					</div>
				</Overlay>
			)}
		</>
	);
}
