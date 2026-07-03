import { InputHTMLAttributes } from 'react';
import styles from './styles.module.scss';

interface Properties extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value'> {
	label?: string;
	value?: boolean;
}

export default function CheckboxInput({
	label,
	value,
	className,
	id = 'checkbox-input',
	...properties
}: Properties) {
	return (
		<div className={`checkbox-input ${styles['checkbox-input']} ${className || ''}`}>
			{label && <label htmlFor={id}>{label}</label>}
			<input
				type='checkbox'
				id={id}
				checked={value}
				{...properties}
			/>
		</div>
	);
}
