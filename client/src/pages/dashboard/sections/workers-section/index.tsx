import { QueueType } from '@handbrake-web/shared/types/queue';
import { WorkerIDType } from '@handbrake-web/shared/types/socket';
import { WorkerPropertiesMap } from '@handbrake-web/shared/types/worker';
import Section from '~components/root/section';
import DashboardTable from '~pages/dashboard/components/dashboard-table';
import styles from './styles.module.scss';

interface Properties {
	queue: QueueType;
	workers: WorkerIDType[];
	properties: WorkerPropertiesMap;
}

export default function WorkersSection({ queue, workers, properties }: Properties) {
	return (
		<Section className={styles['workers']} heading='Workers' link='/workers'>
			<DashboardTable>
				<thead>
					<tr>
						<th>Worker ID</th>
						<th>Application Version</th>
						<th>HandBrake Version</th>
						<th>Capabilities</th>
						<th>Status</th>
					</tr>
				</thead>
				<tbody>
					{workers.map((worker) => {
						const status = queue.find((job) => job.worker_id == worker.workerID)
							? 'Working'
							: 'Idle';
						const workerProperties = properties[worker.workerID];

						return (
							<tr key={`worker-${worker.workerID}`}>
								<td>{worker.workerID}</td>
								<td align='center'>
									{workerProperties?.version.application || 'Loading'}
								</td>
								<td align='center'>
									{workerProperties?.version.handbrake || 'Loading'}
								</td>
								<td align='center'>
									{workerProperties
										? Object.entries(workerProperties.capabilities)
												.filter(([_, available]) => available)
												.map(([capability]) => (
													<span
														className={styles['capability']}
														key={`${worker.workerID}-${capability}`}
													>
														{capability.toUpperCase()}
													</span>
												))
										: 'Loading'}
								</td>
								<td
									className={`${
										status == 'Working' ? 'color-blue' : 'color-yellow'
									}`}
									align='center'
									data-working={status == 'Working'}
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
