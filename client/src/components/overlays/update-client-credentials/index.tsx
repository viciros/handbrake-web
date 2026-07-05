import type { UpdateClientCredentialsResultType } from '@handbrake-web/shared/types/auth';
import ClientCredentialsForm from '~components/modules/client-credentials-form';
import Overlay from '~components/root/overlay';
import { PrimaryContext } from '~layouts/primary/context';
import { useContext } from 'react';
import styles from './styles.module.scss';

export default function UpdateClientCredentials() {
	const { authStatus, socket } = useContext(PrimaryContext)!;

	return (
		<Overlay className={styles['update-client-credentials']}>
			<div className={styles['wrapper']}>
				<h1>Change Credentials</h1>
				<ClientCredentialsForm
					currentUsername={authStatus.username}
					submitLabel='Update Credentials'
					onSubmit={(data, callback) => {
						socket.emit(
							'update-client-credentials',
							data,
							(result: UpdateClientCredentialsResultType) => {
								callback(result);
							}
						);
					}}
				/>
			</div>
		</Overlay>
	);
}
