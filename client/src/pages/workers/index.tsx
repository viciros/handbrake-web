import { IsActiveTranscodeStage } from '@handbrake-web/shared/types/transcode';
import { WorkerProperties } from '@handbrake-web/shared/types/worker';
import { useContext } from 'react';
import Page from '~components/root/page';
import { PrimaryContext } from '~layouts/primary/context';
import StatusSection from './sections/status-section';
import SummarySection from './sections/summary-section';
import TokenSection from './sections/token-section';
import styles from './styles.module.scss';

export type WorkerInfo = {
	properties?: WorkerProperties;
	status: string;
	job: string;
	progress: string;
};

export type WorkerInfoMap = Record<string, WorkerInfo>;

export default function WorkersPage() {
	const { connections, queue, properties, socket, workerTokens } = useContext(PrimaryContext)!;
	const workerTokensByID = new Map(workerTokens.map((token) => [token.worker_id, token]));

	const workerInfo: WorkerInfoMap = Object.fromEntries(
		connections.workers.map((worker) => {
			const job = queue.find(
				(job) =>
					job.worker_id == worker.workerID && IsActiveTranscodeStage(job.transcode_stage)
			);
			const acceptsJobs = workerTokensByID.get(worker.workerID)?.accepts_jobs !== false;
			return [
				worker.workerID,
				{
					properties: properties[worker.workerID],
					status: job ? 'Working' : acceptsJobs ? 'Idle' : 'Disabled',
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
				socket={socket}
				workerTokens={workerTokens}
			/>
			<StatusSection workerInfo={workerInfo} />
		</Page>
	);
}
