import type { WorkerAuthTokenRecordType } from '@handbrake-web/shared/types/auth';
import { QueueType } from '@handbrake-web/shared/types/queue';
import { WorkerIDType } from '@handbrake-web/shared/types/socket';
import { IsActiveTranscodeStage } from '@handbrake-web/shared/types/transcode';
import { WorkerPropertiesMap } from '@handbrake-web/shared/types/worker';
import Section from '~components/root/section';
import DashboardTable from '~pages/dashboard/components/dashboard-table';
import styles from './styles.module.scss';

interface Properties {
	queue: QueueType;
	workers: WorkerIDType[];
	properties: WorkerPropertiesMap;
	workerTokens: WorkerAuthTokenRecordType[];
}

export default function WorkersSection({ queue, workers, properties, workerTokens }: Properties) {
	const onlineWorkerIDs = new Set(workers.map((worker) => worker.workerID));
	const workerIDs = [
		...new Set([...workerTokens.map((token) => token.worker_id), ...onlineWorkerIDs]),
	].sort((a, b) => a.localeCompare(b));

	return (
		<Section className={styles['workers']} heading='Workers' link='/workers'>
			<DashboardTable>
				<thead>
					<tr>
						<th>Worker ID</th>
						<th>Application Version</th>
						<th>HandBrake Version</th>
						<th>Capabilities</th>
						<th>Connection</th>
						<th>Activity</th>
					</tr>
				</thead>
				<tbody>
					{workerIDs.map((workerID) => {
						const isOnline = onlineWorkerIDs.has(workerID);
						const isWorking =
							isOnline &&
							queue.some(
								(job) =>
									job.worker_id == workerID &&
									IsActiveTranscodeStage(job.transcode_stage)
							);
						const status = !isOnline ? 'N/A' : isWorking ? 'Working' : 'Idle';
						const workerProperties = properties[workerID];
						const propertiesFallback = isOnline ? 'Loading' : 'N/A';

						return (
							<tr key={`worker-${workerID}`}>
								<td>{workerID}</td>
								<td align='center'>
									{workerProperties?.version.application || propertiesFallback}
								</td>
								<td align='center'>
									{workerProperties?.version.handbrake || propertiesFallback}
								</td>
								<td align='center'>
									{workerProperties
										? Object.entries(workerProperties.capabilities)
												.filter(([_, available]) => available)
												.map(([capability]) => (
														<span
															className={styles['capability']}
															key={`${workerID}-${capability}`}
														>
															{capability.toUpperCase()}
														</span>
												))
										: propertiesFallback}
								</td>
								<td align='center'>
									<span className={styles['status']} data-online={isOnline}>
										{isOnline ? 'Online' : 'Offline'}
									</span>
								</td>
								<td
									align='center'
									data-working={
										status == 'N/A' ? undefined : status == 'Working'
									}
								>
									{status}
								</td>
							</tr>
						);
					})}
				</tbody>
			</DashboardTable>
		</Section>
	);
}
