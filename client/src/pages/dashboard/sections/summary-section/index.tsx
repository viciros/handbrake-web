import { QueueStatus } from '@handbrake-web/shared/types/queue';
import Section from '~components/root/section';
import styles from './styles.module.scss';

interface Properties {
	availableWorkerCount: number;
	queueStatus: QueueStatus;
}

export default function SummarySection({ availableWorkerCount, queueStatus }: Properties) {
	return (
		<Section className={styles['summary']} heading='Summary'>
			<div className={styles['info']}>
				<div className={`${styles['status']} ${styles['workers']}`}>
					<span>Available Workers: </span>
					<strong data-online={availableWorkerCount > 0}>{availableWorkerCount}</strong>
				</div>
				<div className={`${styles['status']} ${styles['queue']}`}>
					<span>Queue: </span>
					<strong data-status={QueueStatus[queueStatus].toLowerCase()}>
						{QueueStatus[queueStatus]}
					</strong>
				</div>
			</div>
		</Section>
	);
}
