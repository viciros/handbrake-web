import { DetailedJobType } from '@handbrake-web/shared/types/database';
import { statusSorting } from '@handbrake-web/shared/dict/queue.dict';
import { QueueType } from '@handbrake-web/shared/types/queue';
import CaretDownIcon from '@icons/caret-down-fill.svg?react';
import CaretUpIcon from '@icons/caret-up-fill.svg?react';
import GripIcon from '@icons/grip-vertical.svg?react';
import { useContext, useState } from 'react';
import { PrimaryContext } from '~layouts/primary/context';
import QueueJobPreview from '../queue-job-preview';
import QueueJobRow, { QueueTableVariant } from '../queue-job-row';
import styles from './styles.module.scss';

type Params = {
	queue: QueueType;
	id: string;
	label: string;
	variant: QueueTableVariant;
	showHandles?: boolean;
	collapsable?: boolean;
	startCollapsed?: boolean;
	handleStopJob: (id: number) => void;
	handleResetJob: (id: number) => void;
	handleRemoveJob: (id: number) => void;
};

const queueDragDataType = 'application/x-handbrake-web-job';

export default function QueueJobsCategory({
	queue,
	id,
	label,
	variant,
	showHandles = false,
	collapsable = false,
	startCollapsed = false,
	handleStopJob,
	handleResetJob,
	handleRemoveJob,
}: Params) {
	const { socket } = useContext(PrimaryContext)!;
	const [isCollapsed, setIsCollapsed] = useState(startCollapsed);
	const [draggedID, setDraggedID] = useState<number>();
	const [draggedArrayIndex, setDraggedArrayIndex] = useState(-1);
	const [draggedInitialIndex, setDraggedInitialIndex] = useState(-1);
	const [draggedDesiredIndex, setDraggedDesiredIndex] = useState(-1);

	const orderedJobs = [...queue].sort((a, b) => {
		const stageA = a.transcode_stage;
		const stageB = b.transcode_stage;
		if (stageA != undefined && stageB != undefined) {
			const orderA = a.order_index;
			const orderB = b.order_index;
			const finishedA = a.time_finished || 0;
			const finishedB = b.time_finished || 0;

			return stageA == stageB
				? orderA != null && orderB != null
					? orderA - orderB
					: finishedA
						? finishedB
							? finishedB - finishedA
							: 1
						: finishedB
							? -1
							: 0
				: statusSorting[stageA] - statusSorting[stageB];
		}

		return 0;
	});

	const handleDragStart = (
		event: React.DragEvent<HTMLButtonElement>,
		job: DetailedJobType,
		index: number
	) => {
		setDraggedID(job.job_id);
		setDraggedArrayIndex(index);
		setDraggedInitialIndex(job.order_index);
		const serializedData = JSON.stringify({
			id: `job-id-${job.job_id}`,
			index,
			category: id,
		});
		event.dataTransfer.setData(queueDragDataType, serializedData);
		event.dataTransfer.setData('text/plain', serializedData);
	};

	const handleDragEnd = () => {
		setDraggedID(undefined);
		setDraggedArrayIndex(-1);
		setDraggedInitialIndex(-1);
		setDraggedDesiredIndex(-1);
	};

	const handleDragOver = (
		event: React.DragEvent<HTMLTableRowElement>,
		job: DetailedJobType,
		index: number
	) => {
		if (!showHandles || draggedArrayIndex < 0) return;

		event.preventDefault();
		const indexOffset = job.order_index - index;
		const rowBounds = event.currentTarget.getBoundingClientRect();
		const isAboveThis = event.clientY < rowBounds.y + rowBounds.height / 2;
		const moveDirection =
			draggedArrayIndex == index ? 0 : draggedArrayIndex > index ? 1 : -1;
		const desiredIndex =
			moveDirection == 0
				? draggedArrayIndex + indexOffset
				: moveDirection > 0
					? isAboveThis
						? job.order_index
						: job.order_index + moveDirection
					: isAboveThis
						? job.order_index + moveDirection
						: job.order_index;
		const dropIndex = desiredIndex != draggedArrayIndex + indexOffset ? desiredIndex : -1;
		setDraggedDesiredIndex(dropIndex);
	};

	const handleDrop = () => {
		if (draggedDesiredIndex > 0 && draggedID != undefined) {
			socket.emit('reorder-job', draggedID, draggedDesiredIndex);
		}
	};

	if (queue.length == 0) return null;

	const columnCount = variant == 'active' ? 10 : variant == 'finished' ? 8 : 6;
	const orderIndexOffset = orderedJobs[0].order_index - 1;
	const jobRows = orderedJobs.map((job, index) => (
		<QueueJobRow
			key={job.job_id}
			id={`job-id-${job.job_id}`}
			job={job}
			variant={variant}
			handleStopJob={() => handleStopJob(job.job_id)}
			handleResetJob={() => handleResetJob(job.job_id)}
			handleRemoveJob={() => handleRemoveJob(job.job_id)}
			onDragOver={(event) => handleDragOver(event, job, index)}
			onDrop={handleDrop}
		/>
	));

	if (draggedDesiredIndex > 0) {
		const previewIndex =
			draggedDesiredIndex > draggedInitialIndex
				? draggedDesiredIndex - orderIndexOffset
				: draggedDesiredIndex - orderIndexOffset - 1;
		jobRows.splice(
			Math.max(0, Math.min(jobRows.length, previewIndex)),
			0,
			<QueueJobPreview colSpan={columnCount} handleDrop={handleDrop} key='drag-preview' />
		);
	}

	const category = (
		<div className={styles['queue-jobs-category']}>
			{collapsable ? (
				<h4
					className={styles['heading']}
					onClick={() => setIsCollapsed(!isCollapsed)}
					data-interactive
				>
					<span>
						{label} ({queue.length})
					</span>
					{isCollapsed ? <CaretDownIcon /> : <CaretUpIcon />}
				</h4>
			) : (
				<h4 className={styles['heading']}>
					{label} ({queue.length})
				</h4>
			)}

			{((collapsable && !isCollapsed) || !collapsable) && (
				<div className={styles['table-scroll']}>
					<table className={styles['job-table']} data-variant={variant} aria-label={`${label} jobs`}>
						<colgroup>
							<col className={styles['file-column']} />
							<col className={styles['preset-column']} />
							<col className={styles['worker-column']} />
							{variant == 'active' && (
								<>
									<col className={styles['fps-column']} />
									<col className={styles['average-fps-column']} />
									<col className={styles['elapsed-column']} />
									<col className={styles['remaining-column']} />
									<col className={styles['progress-column']} />
								</>
							)}
							{(variant == 'pending' || variant == 'stopped') && (
								<col className={styles['layout-spacer-column']} />
							)}
							{variant == 'finished' && (
								<>
									<col className={styles['duration-column']} />
									<col className={styles['time-finished-column']} />
									<col className={styles['average-fps-column']} />
								</>
							)}
							<col className={styles['status-column']} />
							<col className={styles['actions-column']} />
						</colgroup>
						<thead>
							<tr>
								<th scope='col'>File</th>
								<th scope='col'>Preset</th>
								<th scope='col'>Worker</th>
								{variant == 'active' && (
									<>
										<th scope='col'>FPS</th>
										<th scope='col'>Avg. FPS</th>
										<th scope='col'>Elapsed</th>
										<th scope='col'>Remaining</th>
										<th scope='col'>Progress</th>
									</>
								)}
								{(variant == 'pending' || variant == 'stopped') && (
									<th className={styles['layout-spacer-column']} aria-hidden='true' />
								)}
								{variant == 'finished' && (
									<>
										<th scope='col'>Duration</th>
										<th scope='col'>Time Finished</th>
										<th scope='col'>Avg. FPS</th>
									</>
								)}
								<th className={styles['status-heading']} scope='col'>
									Status
								</th>
								<th className={styles['actions-heading']} scope='col'>
									Actions
								</th>
							</tr>
						</thead>
						<tbody>{jobRows}</tbody>
					</table>
				</div>
			)}
		</div>
	);

	if (!showHandles) return category;

	return (
		<div className={styles['pending-category-layout']}>
			<div className={styles['reorder-rail']} aria-label='Pending queue order'>
				{orderedJobs.map((job, index) => (
					<button
						key={job.job_id}
						type='button'
						className={styles['reorder-control']}
						draggable
						title={`Drag pending job ${index + 1} to reorder`}
						aria-label={`Queue order ${index + 1}; drag to reorder`}
						onDragStart={(event) => handleDragStart(event, job, index)}
						onDragEnd={handleDragEnd}
					>
						<GripIcon />
						<span>{index + 1}</span>
					</button>
				))}
			</div>
			{category}
		</div>
	);
}
