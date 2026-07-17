import { IsActiveTranscodeStage } from '@handbrake-web/shared/types/transcode';
import {
	WorkerProperties,
	WorkerResourceUsage,
} from '@handbrake-web/shared/types/worker';
import { useContext } from 'react';
import Page from '~components/root/page';
import { PrimaryContext } from '~layouts/primary/context';
import StatusSection from './sections/status-section';
import SummarySection from './sections/summary-section';
import TokenSection from './sections/token-section';
import styles from './styles.module.scss';

export type WorkerInfo = {
	properties?: WorkerProperties;
	resourceUsage?: WorkerResourceUsage;
	status: string;
	job: string;
	progress: string;
};

export type WorkerInfoMap = Record<string, WorkerInfo>;

export default function WorkersPage() {
	const { connections, queue, properties, socket, workerResourceUsage, workerTokens } =
		useContext(PrimaryContext)!;

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
					status: job ? 'Working' : 'Idle',
					job: job ? job.input_path : 'N/A',
					progress:
						job && job.transcode_percentage
							? (job.transcode_percentage * 100).toFixed(2)
							: 'N/A',
				},
			];
		})
	);

	return (
		<Page className={styles['workers-page']} heading='Workers'>
			<SummarySection workerInfo={workerInfo} queue={queue} />
			<TokenSection
				connectedWorkerIDs={connections.workers.map((worker) => worker.workerID)}
				queue={queue}
				socket={socket}
				workerTokens={workerTokens}
			/>
			<StatusSection workerInfo={workerInfo} />
		</Page>
	);
}
