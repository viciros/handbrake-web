import { statusSorting } from '@handbrake-web/shared/dict/queue.dict';
import type { QueueType } from '@handbrake-web/shared/types/queue';
import { IsActiveTranscodeStage, TranscodeStage } from '@handbrake-web/shared/types/transcode';
import BadgeInfo from '~components/base/info/badge-info';
import ProgressBar from '~components/base/progress';
import Section from '~components/root/section';
import DashboardTable from '~pages/dashboard/components/dashboard-table';
import styles from './styles.module.scss';

interface Properties {
	queue: QueueType;
}

interface QueueTableProperties {
	jobs: QueueType;
}

const secondsToTime = (seconds: number) => {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const newSeconds = Math.floor((seconds % 3600) % 60);
	return [hours, minutes, newSeconds]
		.map((value) => value.toString().padStart(2, '0'))
		.join(':');
};

const formatFinishedTime = (timeFinished: number) =>
	timeFinished ? new Date(timeFinished).toLocaleString() : 'N/A';

const formatJobTime = (job: QueueType[number]) =>
	IsActiveTranscodeStage(job.transcode_stage)
		? job.transcode_eta
			? secondsToTime(job.transcode_eta)
			: 'N/A'
		: formatFinishedTime(job.time_finished);

const sortQueueJobs = (queue: QueueType) =>
	[...queue].sort((a, b) => {
		const stageA = a.transcode_stage;
		const stageB = b.transcode_stage;
		if (stageA == undefined || stageB == undefined) return 0;
		if (stageA != stageB) return statusSorting[stageA] - statusSorting[stageB];

		const orderA = a.order_index;
		const orderB = b.order_index;
		if (orderA != null && orderB != null) return orderA - orderB;

		const finishedA = a.time_finished || 0;
		const finishedB = b.time_finished || 0;
		if (finishedA) return finishedB ? finishedB - finishedA : 1;
		return finishedB ? -1 : 0;
	});

const sortFinishedJobs = (queue: QueueType) =>
	[...queue].sort((a, b) => (b.time_finished || 0) - (a.time_finished || 0));

function QueueTable({ jobs }: QueueTableProperties) {
	return (
		<DashboardTable>
			<thead>
				<tr>
					<th>#</th>
					<th>File</th>
					<th>Worker</th>
					<th>Status</th>
					<th>Time</th>
					<th>Progress</th>
				</tr>
			</thead>
			<tbody>
				{jobs.map((job) => {
					const percentage = job.transcode_percentage
						? job.transcode_percentage * 100
						: 0;

					return (
						<tr key={`queue-job-${job.job_id}`}>
							<td className={styles['order']} align='center'>
								{job.order_index}
							</td>
							<td className={styles['input']} title={job.input_path}>
								{job.input_path.match(/[^/]+$/)}
								<BadgeInfo info={job.input_path} />
							</td>
							<td align='center'>{job.worker_id || 'N/A'}</td>
							<td
								align='center'
								data-status={TranscodeStage[
									job.transcode_stage || 0
								].toLocaleLowerCase()}
							>
								{TranscodeStage[job.transcode_stage || 0]}
							</td>
							<td align='center'>{formatJobTime(job)}</td>
							<td className={styles['progress']}>
								<ProgressBar
									className={styles['percentage']}
									percentage={percentage}
								/>
							</td>
						</tr>
					);
				})}
			</tbody>
		</DashboardTable>
	);
}

export default function QueueSection({ queue }: Properties) {
	const queuedJobs = sortQueueJobs(
		queue.filter((job) => job.transcode_stage != TranscodeStage.Finished)
	);
	const finishedJobs = sortFinishedJobs(
		queue.filter((job) => job.transcode_stage == TranscodeStage.Finished)
	);

	return (
		<>
			<Section className={styles['queue']} heading='Queue' link='/queue'>
				<QueueTable jobs={queuedJobs} />
			</Section>
			<Section className={styles['queue']} heading='Finished Transcodes' link='/queue'>
				<QueueTable jobs={finishedJobs} />
			</Section>
		</>
	);
}
