import { IsActiveTranscodeStage } from '@handbrake-web/shared/types/transcode';
import {
	WorkerProperties,
	WorkerResourceUsage,
} from '@handbrake-web/shared/types/worker';
import { useContext } from 'react';
import Page from '~components/root/page';
import { PrimaryContext } from '~layouts/primary/context';
import SummarySection from './sections/summary-section';
import WorkersSection from './sections/workers-section';
import styles from './styles.module.scss';

export type WorkerInfo = {
	properties?: WorkerProperties;
	resourceUsage?: WorkerResourceUsage;
	status: 'Disabled' | 'Idle' | 'Working';
	job?: {
		inputPath: string;
		progress: number;
	};
};

export type WorkerInfoMap = Record<string, WorkerInfo>;

export default function WorkersPage() {
	const { connections, queue, properties, socket, workerResourceUsage, workerTokens } =
		useContext(PrimaryContext)!;
	const acceptsJobsByWorkerID = new Map(
		workerTokens.map((token) => [token.worker_id, token.accepts_jobs])
	);

	const workerInfo: WorkerInfoMap = Object.fromEntries(
		connections.workers.map((worker) => {
			const job = queue.find(
				(job) =>
					job.worker_id == worker.workerID && IsActiveTranscodeStage(job.transcode_stage)
			);
			return [
				worker.workerID,
				{
					properties: properties[worker.workerID],
					resourceUsage: workerResourceUsage[worker.workerID],
					status: job
						? 'Working'
						: acceptsJobsByWorkerID.get(worker.workerID) === false
							? 'Disabled'
							: 'Idle',
					job: job
						? {
								inputPath: job.input_path,
								progress: job.transcode_percentage * 100,
							}
						: undefined,
				},
			];
		})
	);

	return (
		<Page className={styles['workers-page']} heading='Workers'>
			<SummarySection workerInfo={workerInfo} queue={queue} />
			<WorkersSection
				socket={socket}
				workerInfo={workerInfo}
				workerTokens={workerTokens}
			/>
		</Page>
	);
}
