import type {
	WorkerAuthTokenActionResultType,
	WorkerAuthTokenRecordType,
	WorkerAuthTokenSecretResultType,
} from '@handbrake-web/shared/types/auth';
import RotateIcon from '@icons/arrow-clockwise.svg?react';
import ClipboardIcon from '@icons/clipboard.svg?react';
import PlusIcon from '@icons/plus-lg.svg?react';
import TrashIcon from '@icons/trash-fill.svg?react';
import CloseIcon from '@icons/x-lg.svg?react';
import { useMemo, useState } from 'react';
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

const formatTimestamp = (timestamp: number | null) =>
	timestamp ? new Date(timestamp).toLocaleString() : 'Never';

export default function TokenSection({ connectedWorkerIDs, socket, workerTokens }: Props) {
	const [workerID, setWorkerID] = useState('');
	const [message, setMessage] = useState('');
	const [isSaving, setIsSaving] = useState(false);
	const [secret, setSecret] = useState<TokenSecret>();
	const [copyMessage, setCopyMessage] = useState('');

	const connectedWorkers = useMemo(() => new Set(connectedWorkerIDs), [connectedWorkerIDs]);
	const trimmedWorkerID = workerID.trim();

	const handleSecretResult = (
		fallbackWorkerID: string,
		result: WorkerAuthTokenSecretResultType
	) => {
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
	};

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

	const rotateToken = (record: WorkerAuthTokenRecordType) => {
		if (
			!window.confirm(
				`Rotate the token for '${record.worker_id}'? This will disconnect the worker if it is online.`
			)
		) {
			return;
		}

		setMessage('');
		socket.emit(
			'rotate-worker-auth-token',
			record.worker_id,
			(result: WorkerAuthTokenSecretResultType) => {
				handleSecretResult(record.worker_id, result);
			}
		);
	};

	const revokeToken = (record: WorkerAuthTokenRecordType) => {
		if (
			!window.confirm(
				`Revoke the token for '${record.worker_id}'? This will disconnect the worker if it is online.`
			)
		) {
			return;
		}

		setMessage('');
		socket.emit(
			'revoke-worker-auth-token',
			record.worker_id,
			(result: WorkerAuthTokenActionResultType) => {
				setMessage(result.message || (result.ok ? 'Worker token revoked.' : 'Update failed.'));
			}
		);
	};

	const copySecret = () => {
		if (!secret) return;
		if (!navigator.clipboard) {
			setCopyMessage('Copy unavailable.');
			return;
		}

		navigator.clipboard
			.writeText(secret.token)
			.then(() => {
				setCopyMessage('Copied.');
			})
			.catch(() => {
				setCopyMessage('Copy failed.');
			});
	};

	return (
		<Section className={styles['token-section']} heading='Worker Tokens'>
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

			{message && <div className={styles['message']}>{message}</div>}

			<div className={styles['tokens']}>
				{workerTokens.length == 0 && (
					<div className={styles['empty']}>No worker tokens have been created.</div>
				)}

				{workerTokens.map((record) => {
					const isOnline = connectedWorkers.has(record.worker_id);

					return (
						<div className={styles['token-row']} key={record.worker_id}>
							<div className={styles['identity']}>
								<span className={styles['worker-id']}>{record.worker_id}</span>
								<span className={styles['status']} data-online={isOnline}>
									{isOnline ? 'Online' : 'Offline'}
								</span>
							</div>
							<div className={styles['dates']}>
								<div>
									<span>Created</span>
									<strong>{formatTimestamp(record.created_at)}</strong>
								</div>
								<div>
									<span>Rotated</span>
									<strong>{formatTimestamp(record.updated_at)}</strong>
								</div>
								<div>
									<span>Last Used</span>
									<strong>{formatTimestamp(record.last_used_at)}</strong>
								</div>
							</div>
							<div className={styles['actions']}>
								<ButtonInput
									label='Rotate'
									Icon={RotateIcon}
									color='blue'
									onClick={() => rotateToken(record)}
								/>
								<ButtonInput
									label='Revoke'
									Icon={TrashIcon}
									color='red'
									onClick={() => revokeToken(record)}
								/>
							</div>
						</div>
					);
				})}
			</div>

			{secret && (
				<Overlay className={styles['token-overlay']}>
					<div className={styles['token-window']}>
						<h2>Worker Token</h2>
						<div className={styles['secret-worker']}>{secret.workerID}</div>
						<code className={styles['secret-token']}>{secret.token}</code>
						<div className={styles['overlay-message']}>
							This token is shown once. Store it in the worker's WORKER_TOKEN value.
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
