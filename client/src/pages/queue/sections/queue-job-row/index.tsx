import { DetailedJobType } from '@handbrake-web/shared/types/database';
import { IsActiveTranscodeStage, TranscodeStage } from '@handbrake-web/shared/types/transcode';
import LogIcon from '@icons/file-text-fill.svg?react';
import { HTMLAttributes, useContext } from 'react';
import { PrimaryContext } from '~layouts/primary/context';
import styles from './styles.module.scss';

export type QueueTableVariant = 'active' | 'pending' | 'stopped' | 'finished';

interface Properties extends HTMLAttributes<HTMLTableRowElement> {
	job: DetailedJobType;
	variant: QueueTableVariant;
	handleStopJob: () => void;
	handleResetJob: () => void;
	handleRemoveJob: () => void;
}

function secondsToTime(seconds: number) {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remainingSeconds = Math.floor(seconds % 60);

	return [hours, minutes, remainingSeconds]
		.map((value) => value.toString().padStart(2, '0'))
		.join(':');
}

function getFilename(path: string) {
	return path.split(/[\\/]/).pop() || path;
}

export default function QueueJobRow({
	job,
	variant,
	handleStopJob,
	handleResetJob,
	handleRemoveJob,
	className,
	...properties
}: Properties) {
	const { serverURL } = useContext(PrimaryContext)!;

	const stage = job.transcode_stage ?? TranscodeStage.Unknown;
	const stageLabel = TranscodeStage[stage];
	const canStop = IsActiveTranscodeStage(stage);
	const canReset =
		stage == TranscodeStage.Stopped ||
		stage == TranscodeStage.Finished ||
		stage == TranscodeStage.Error;
	const canRemove =
		stage == TranscodeStage.Waiting ||
		stage == TranscodeStage.Finished ||
		stage == TranscodeStage.Stopped ||
		job.worker_id == null;
	const hasJobLog =
		stage == TranscodeStage.Finished ||
		stage == TranscodeStage.Stopped ||
		stage == TranscodeStage.Error;

	const percentage = Math.min(Math.max((job.transcode_percentage || 0) * 100, 0), 100);
	const averageFps = job.transcode_fps_average
		? job.transcode_fps_average.toFixed(1)
		: '—';
	const transcodeDuration =
		job.time_started && job.time_finished && job.time_finished >= job.time_started
			? secondsToTime((job.time_finished - job.time_started) / 1000)
			: '—';
	const timeFinished = job.time_finished
		? new Date(job.time_finished).toLocaleString('en-US', {
				year: 'numeric',
				month: 'numeric',
				day: 'numeric',
				hour: 'numeric',
				minute: '2-digit',
			})
		: '—';

	return (
		<tr className={`${styles['job-row']} ${className || ''}`} {...properties}>
			<td className={styles['file']} title={job.output_path}>
				{getFilename(job.output_path || job.input_path)}
			</td>
			<td title={job.preset_id}>{job.preset_id}</td>
			<td>{job.worker_id || '—'}</td>

			{variant == 'active' && (
				<>
					<td>{job.transcode_fps_current ? job.transcode_fps_current.toFixed(1) : '—'}</td>
					<td>{averageFps}</td>
					<td>
						{job.time_started ? secondsToTime((Date.now() - job.time_started) / 1000) : '—'}
					</td>
					<td>{job.transcode_eta ? secondsToTime(job.transcode_eta) : '—'}</td>
					<td className={styles['progress-cell']}>
						<div
							className={styles['progress']}
							role='progressbar'
							aria-label={`Progress for ${getFilename(job.output_path || job.input_path)}`}
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={Number(percentage.toFixed(1))}
						>
							<span className={styles['progress-label']}>{percentage.toFixed(1)}%</span>
							<span className={styles['progress-track']}>
								<span className={styles['progress-value']} style={{ width: `${percentage}%` }} />
							</span>
						</div>
					</td>
				</>
			)}

			{(variant == 'pending' || variant == 'stopped') && (
				<td className={styles['layout-spacer']} aria-hidden='true' />
			)}

			{variant == 'finished' && (
				<>
					<td>{transcodeDuration}</td>
					<td>{timeFinished}</td>
					<td>{averageFps}</td>
				</>
			)}

			<td className={styles['status-column']}>
				<span className={styles['status']} data-stage={stageLabel.toLowerCase()}>
					{stageLabel}
				</span>
				{hasJobLog && (
					<a
						className={styles['job-log-link']}
						href={`${serverURL}logs/jobs?id=${job.job_id}`}
						target='_blank'
						rel='noreferrer'
						title='View Log'
						aria-label={`View log for ${getFilename(job.output_path || job.input_path)}`}
					>
						<LogIcon />
					</a>
				)}
			</td>
			<td className={styles['actions-column']}>
				<div
					className={styles['actions']}
					aria-label={`Actions for ${getFilename(job.output_path || job.input_path)}`}
				>
					<button
						type='button'
						className={`${styles['action']} ${styles['stop']}`}
						onClick={handleStopJob}
						disabled={!canStop}
					>
						Stop
					</button>
					<button
						type='button'
						className={styles['action']}
						onClick={handleResetJob}
						disabled={!canReset}
					>
						Restart
					</button>
					<button
						type='button'
						className={styles['action']}
						onClick={handleRemoveJob}
						disabled={!canRemove}
					>
						Clear
					</button>
				</div>
			</td>
		</tr>
	);
}
