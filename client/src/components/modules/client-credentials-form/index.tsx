import type {
	UpdateClientCredentialsResultType,
	UpdateClientCredentialsType,
} from '@handbrake-web/shared/types/auth';
import SaveIcon from '@icons/floppy2-fill.svg?react';
import { useState } from 'react';
import ButtonInput from '~components/base/inputs/button';
import TextInput from '~components/base/inputs/text';
import styles from './styles.module.scss';

type Properties = {
	currentUsername: string;
	currentPasswordRequired?: boolean;
	submitLabel?: string;
	onSubmit: (
		data: UpdateClientCredentialsType,
		callback: (result: UpdateClientCredentialsResultType) => void
	) => void;
};

export default function ClientCredentialsForm({
	currentUsername,
	currentPasswordRequired = true,
	submitLabel = 'Save Credentials',
	onSubmit,
}: Properties) {
	const [currentPassword, setCurrentPassword] = useState('');
	const [username, setUsername] = useState(currentUsername);
	const [newPassword, setNewPassword] = useState('');
	const [confirmPassword, setConfirmPassword] = useState('');
	const [message, setMessage] = useState('');
	const [isSaving, setIsSaving] = useState(false);

	const trimmedUsername = username.trim();
	const passwordsMatch = newPassword == confirmPassword;
	const canSubmit =
		(!currentPasswordRequired || currentPassword.length > 0) &&
		trimmedUsername.length > 0 &&
		newPassword.length >= 12 &&
		passwordsMatch &&
		!isSaving;

	const handleSubmit = () => {
		if (!canSubmit) return;

		const credentials: UpdateClientCredentialsType = {
			username: trimmedUsername,
			new_password: newPassword,
		};
		if (currentPasswordRequired) {
			credentials.current_password = currentPassword;
		}

		setMessage('');
		setIsSaving(true);
		onSubmit(
			credentials,
			(result) => {
				setIsSaving(false);
				setMessage(result.message || (result.ok ? 'Credentials updated.' : 'Update failed.'));

				if (result.ok && result.requires_reauth) {
					setTimeout(() => {
						window.location.reload();
					}, 750);
				}
			}
		);
	};

	return (
		<div className={styles['client-credentials-form']}>
			<div className={styles['fields']}>
				{currentPasswordRequired && (
					<TextInput
						className={styles['field']}
						id='current-password'
						label='Current Password'
						type='password'
						autoComplete='current-password'
						value={currentPassword}
						onChange={(event) => setCurrentPassword(event.target.value)}
					/>
				)}
				<TextInput
					className={styles['field']}
					id='new-username'
					label='Username'
					autoComplete='username'
					value={username}
					onChange={(event) => setUsername(event.target.value)}
				/>
				<TextInput
					className={styles['field']}
					id='new-password'
					label='New Password'
					type='password'
					autoComplete='new-password'
					value={newPassword}
					onChange={(event) => setNewPassword(event.target.value)}
				/>
				<TextInput
					className={styles['field']}
					id='confirm-password'
					label='Confirm Password'
					type='password'
					autoComplete='new-password'
					value={confirmPassword}
					onChange={(event) => setConfirmPassword(event.target.value)}
				/>
			</div>
			{message && <div className={styles['message']}>{message}</div>}
			<div className={styles['buttons']}>
				<ButtonInput
					className={styles['save-button']}
					label={isSaving ? 'Saving' : submitLabel}
					Icon={SaveIcon}
					color='green'
					disabled={!canSubmit}
					onClick={handleSubmit}
				/>
			</div>
		</div>
	);
}
