import type {
	WorkerAuthTokenActionResultType,
	WorkerAuthTokenRecordType,
	WorkerAuthTokenSecretResultType,
} from '@handbrake-web/shared/types/auth';
import RotateIcon from '@icons/arrow-clockwise.svg?react';
import ClipboardIcon from '@icons/clipboard.svg?react';
import PlayIcon from '@icons/play-fill.svg?react';
import PlusIcon from '@icons/plus-lg.svg?react';
import StopIcon from '@icons/stop-fill.svg?react';
import TrashIcon from '@icons/trash-fill.svg?react';
import CloseIcon from '@icons/x-lg.svg?react';
import { memo, useCallback, useMemo, useState } from 'react';
import type { Socket } from 'socket.io-client';
import ButtonInput from '~components/base/inputs/button';
import TextInput from '~components/base/inputs/text';
import Overlay from '~components/root/overlay';
import Section from '~components/root/section';
import styles from './styles.module.scss';

type TokenSecret = {
	workerID: string;
	token: string;
};

type Props = {
	connectedWorkerIDs: string[];
	socket: Socket;
	workerTokens: WorkerAuthTokenRecordType[];
};

type TokenRowProps = {
	acceptsJobs: boolean;
	isOnline: boolean;
	lastUsedAt: number | null;
	onRevoke: (workerID: string) => void;
	onRotate: (workerID: string) => void;
	onSetEnabled: (workerID: string, acceptsJobs: boolean) => void;
	workerID: string;
};

const formatTimestamp = (timestamp: number | null) => {
	if (!timestamp) return 'Never';
	return new Date(timestamp).toLocaleString(undefined, {
		dateStyle: 'short',
		timeStyle: 'short',
	});
};

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

const TokenRow = memo(function TokenRow({
	acceptsJobs,
	isOnline,
	lastUsedAt,
	onRevoke,
	onRotate,
	onSetEnabled,
	workerID,
}: TokenRowProps) {
	return (
		<div className={styles['token-row']}>
			<div className={styles['identity']}>
				<span className={styles['worker-id']}>{workerID}</span>
				<span className={styles['status']} data-online={isOnline}>
					{isOnline ? 'Online' : 'Offline'}
				</span>
				<span className={styles['status']} data-enabled={acceptsJobs}>
					{acceptsJobs ? 'Enabled' : 'Disabled'}
				</span>
			</div>
			<div className={styles['dates']}>
				<div>
					<span>Last Online</span>
					<strong>{formatTimestamp(lastUsedAt)}</strong>
				</div>
			</div>
			<div className={styles['actions']}>
				<ButtonInput
					label={acceptsJobs ? 'Disable' : 'Enable'}
					Icon={acceptsJobs ? StopIcon : PlayIcon}
					color={acceptsJobs ? 'orange' : 'green'}
					onClick={() => onSetEnabled(workerID, !acceptsJobs)}
				/>
				<ButtonInput
					label='Rotate Token'
					Icon={RotateIcon}
					color='blue'
					onClick={() => onRotate(workerID)}
				/>
				<ButtonInput
					label='Revoke'
					Icon={TrashIcon}
					color='red'
					onClick={() => onRevoke(workerID)}
				/>
			</div>
		</div>
	);
});

export default function TokenSection({ connectedWorkerIDs, socket, workerTokens }: Props) {
	const [workerID, setWorkerID] = useState('');
	const [message, setMessage] = useState('');
	const [isSaving, setIsSaving] = useState(false);
	const [secret, setSecret] = useState<TokenSecret>();
	const [copyMessage, setCopyMessage] = useState('');

	const connectedWorkers = useMemo(() => new Set(connectedWorkerIDs), [connectedWorkerIDs]);
	const trimmedWorkerID = workerID.trim();

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
			if (
				!window.confirm(
					`Rotate the token for '${workerID}'? This will disconnect the worker if it is online.`
				)
			) {
				return;
			}

			setMessage('');
			socket.emit(
				'rotate-worker-auth-token',
				workerID,
				(result: WorkerAuthTokenSecretResultType) => {
					handleSecretResult(workerID, result);
				}
			);
		},
		[handleSecretResult, socket]
	);

	const revokeToken = useCallback(
		(workerID: string) => {
			if (
				!window.confirm(
					`Revoke the token for '${workerID}'? This will disconnect the worker if it is online.`
				)
			) {
				return;
			}

			setMessage('');
			socket.emit(
				'revoke-worker-auth-token',
				workerID,
				(result: WorkerAuthTokenActionResultType) => {
					setMessage(
						result.message || (result.ok ? 'Worker token revoked.' : 'Update failed.')
					);
				}
			);
		},
		[socket]
	);

	const setWorkerEnabled = useCallback(
		(workerID: string, acceptsJobs: boolean) => {
			setMessage('');
			socket.emit(
				'set-worker-enabled',
				workerID,
				acceptsJobs,
				(result: WorkerAuthTokenActionResultType) => {
					setMessage(
						result.message ||
							(result.ok
								? `Worker ${acceptsJobs ? 'enabled' : 'disabled'}.`
								: 'Update failed.')
					);
				}
			);
		},
		[socket]
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
		<Section className={styles['token-section']} heading='Worker Tokens'>
			<div className={styles['description']}>
				The Worker ID must exactly match the worker's <code>WORKER_ID</code> environment
				variable. Disabling a worker prevents new jobs without disconnecting it. Active jobs
				finish before the worker becomes idle. Rotate or revoke a token to invalidate
				authentication.
			</div>
			<div className={styles['create-token']}>
				<TextInput
					className={styles['worker-id-input']}
					label='Worker ID'
					placeholder='worker-1'
					value={workerID}
					onChange={(event) => setWorkerID(event.target.value)}
					onKeyDown={(event) => {
						if (event.key == 'Enter') createToken();
					}}
				/>
				<ButtonInput
					label={isSaving ? 'Creating' : 'Create Token'}
					Icon={PlusIcon}
					color='green'
					disabled={!trimmedWorkerID || isSaving}
					onClick={createToken}
				/>
			</div>

			<div className={styles['message']} role='status' aria-live='polite'>
				{message || '\u00a0'}
			</div>

			<div className={styles['tokens']}>
				{workerTokens.length == 0 && (
					<div className={styles['empty']}>No worker tokens have been created.</div>
				)}

				{workerTokens.map((record) => (
					<TokenRow
						acceptsJobs={record.accepts_jobs}
						isOnline={connectedWorkers.has(record.worker_id)}
						key={record.worker_id}
						lastUsedAt={record.last_used_at}
						onRevoke={revokeToken}
						onRotate={rotateToken}
						onSetEnabled={setWorkerEnabled}
						workerID={record.worker_id}
					/>
				))}
			</div>

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
		</Section>
	);
}
