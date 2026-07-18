import styles from './styles.module.scss';

type Params = {
	colSpan: number;
	handleDrop: () => void;
};

export default function QueueJobPreview({ colSpan, handleDrop }: Params) {
	const handleDragOver = (event: React.DragEvent<HTMLTableRowElement>) => {
		event.preventDefault();
	};

	return (
		<tr className={styles['drop-preview']} onDragOver={handleDragOver} onDrop={handleDrop}>
			<td colSpan={colSpan}>
				<hr />
			</td>
		</tr>
	);
}
