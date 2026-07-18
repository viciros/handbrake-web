import { statusSorting } from '@handbrake-web/shared/dict/queue.dict';
import type { QueueType } from '@handbrake-web/shared/types/queue';
import { IsActiveTranscodeStage, TranscodeStage } from '@handbrake-web/shared/types/transcode';
import CaretDownIcon from '@icons/caret-down-fill.svg?react';
import CaretUpIcon from '@icons/caret-up-fill.svg?react';
import { useState } from 'react';
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
	timeHeading: string;
	formatTime: (job: QueueType[number]) => string;
	showOrder: boolean;
	showProgress: boolean;
}

const secondsToTime = (seconds: number) => {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const newSeconds = Math.floor((seconds % 3600) % 60);
	return [hours, minutes, newSeconds]
		.map((value) => value.toString().padStart(2, '0'))
		.join(':');
};

const formatTimeRemaining = (job: QueueType[number]) =>
	IsActiveTranscodeStage(job.transcode_stage)
		? job.transcode_eta
			? secondsToTime(job.transcode_eta)
			: 'N/A'
		: 'N/A';

const formatCompletedAt = (job: QueueType[number]) =>
	job.time_finished
		? new Date(job.time_finished).toLocaleString(undefined, {
				dateStyle: 'short',
				timeStyle: 'short',
			})
		: 'N/A';

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

function QueueTable({ jobs, timeHeading, formatTime, showOrder, showProgress }: QueueTableProperties) {
	return (
		<DashboardTable>
			<thead>
				<tr>
					{showOrder && <th>#</th>}
					<th>File</th>
					<th>Worker</th>
					<th>Status</th>
					<th>{timeHeading}</th>
					{showProgress && <th>Progress</th>}
				</tr>
			</thead>
			<tbody>
				{jobs.map((job) => {
					const percentage = job.transcode_percentage
						? job.transcode_percentage * 100
						: 0;

					return (
						<tr key={`queue-job-${job.job_id}`}>
							{showOrder && (
								<td className={styles['order']} align='center'>
									{job.order_index}
								</td>
							)}
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
							<td align='center'>{formatTime(job)}</td>
							{showProgress && (
								<td className={styles['progress']}>
									<ProgressBar
										className={styles['percentage']}
										percentage={percentage}
									/>
								</td>
							)}
						</tr>
					);
				})}
			</tbody>
		</DashboardTable>
	);
}

export default function QueueSection({ queue }: Properties) {
	const [isFinishedCollapsed, setIsFinishedCollapsed] = useState(true);
	const queuedJobs = sortQueueJobs(
		queue.filter((job) => job.transcode_stage != TranscodeStage.Finished)
	);
	const finishedJobs = sortFinishedJobs(
		queue.filter((job) => job.transcode_stage == TranscodeStage.Finished)
	);

	return (
		<>
			<Section className={styles['queue']} heading='Queue' link='/queue'>
				<QueueTable
					jobs={queuedJobs}
					timeHeading='Time Remaining'
					formatTime={formatTimeRemaining}
					showOrder={true}
					showProgress={true}
				/>
			</Section>
			<Section className={styles['queue']}>
				<button
					className={styles['collapsible-heading']}
					type='button'
					aria-expanded={!isFinishedCollapsed}
					onClick={() => setIsFinishedCollapsed((isCollapsed) => !isCollapsed)}
				>
					<span>
						Finished Transcodes ({finishedJobs.length})
					</span>
					{isFinishedCollapsed ? <CaretDownIcon /> : <CaretUpIcon />}
				</button>
				{!isFinishedCollapsed && (
					<QueueTable
						jobs={finishedJobs}
						timeHeading='Completed At'
						formatTime={formatCompletedAt}
						showOrder={false}
						showProgress={false}
					/>
				)}
			</Section>
		</>
	);
}
