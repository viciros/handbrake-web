import type { UpdateClientCredentialsResultType } from '@handbrake-web/shared/types/auth';
import ClientCredentialsForm from '~components/modules/client-credentials-form';
import Section from '~components/root/section';
import { PrimaryContext } from '~layouts/primary/context';
import { useContext } from 'react';

export default function SettingsCredentials() {
	const { authStatus, socket } = useContext(PrimaryContext)!;

	return (
		<Section heading='Credentials'>
			<ClientCredentialsForm
				currentUsername={authStatus.username}
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
		</Section>
	);
}
