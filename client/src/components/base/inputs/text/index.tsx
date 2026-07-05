import { EndWithColon } from '@handbrake-web/shared/funcs/string.funcs';
import { InputHTMLAttributes } from 'react';
import styles from './styles.module.scss';

interface Properties extends InputHTMLAttributes<HTMLInputElement> {
	label?: string;
}

export default function TextInput({ label, className, id, ...properties }: Properties) {
	return (
		<div className={`text-input ${styles['text-input']} ${className || ''}`}>
			{label && (
				<label className={styles['label']} htmlFor='text-input'>
					{EndWithColon(label)}
				</label>
			)}
			<input
				className={styles['input']}
				id={`text-input ${id || ''}`}
				size={1}
				type='text'
				{...properties}
			/>
		</div>
	);
}
