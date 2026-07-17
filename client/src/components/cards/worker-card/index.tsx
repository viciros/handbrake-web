import { WorkerCapabilities } from '@handbrake-web/shared/types/worker';
import { HTMLAttributes } from 'react';
import TextInfo from '~components/base/info/text-info';
import ProgressBar from '~components/base/progress';
import { WorkerInfo } from '~pages/workers';
import styles from './styles.module.scss';

interface Properties extends HTMLAttributes<HTMLDivElement> {
	worker: string;
	info: WorkerInfo;
}

const capabilitiesLookup: Record<keyof WorkerCapabilities, string> = {
	cpu: 'CPU',
	qsv: 'Intel QSV',
	nvenc: 'NVIDIA NVENC',
	vcn: 'AMD VCN',
};
const getCapabilitiesLabel = (supported: boolean) => (supported ? 'Supported' : 'Unsupported');

const formatBytes = (bytes: number) => {
	const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
	let value = bytes;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	return `${value.toFixed(unitIndex == 0 ? 0 : 1)} ${units[unitIndex]}`;
};

const formatMemoryUsage = (used: number | null, limit: number | null) => {
	if (used == null) return 'Unavailable';
	return limit == null ? formatBytes(used) : `${formatBytes(used)} / ${formatBytes(limit)}`;
};

export default function WorkerCard({ worker, info, className, ...properties }: Properties) {
	const workerProperties = info.properties;
	const resourceUsage = info.resourceUsage;

	return (
		<div className={`worker-card ${styles['worker-card']} ${className || ''}`} {...properties}>
			<h3 className={styles['heading']}>{worker}</h3>
			<div className={styles['body']}>
				<div className={styles['subsection']}>
					<h5 className={styles['subheading']}>Resource Usage</h5>
					<div className={styles['content']}>
						<TextInfo className={styles['text-info']} label='CPU Usage'>
							{resourceUsage
								? resourceUsage.cpu_percent == null
									? 'Unavailable'
									: `${resourceUsage.cpu_percent.toFixed(1)}%`
								: 'Collecting'}
						</TextInfo>
						<TextInfo className={styles['text-info']} label='RAM Usage'>
							{resourceUsage
								? formatMemoryUsage(
										resourceUsage.memory_used_bytes,
										resourceUsage.memory_limit_bytes
								  )
								: 'Collecting'}
						</TextInfo>
					</div>
				</div>
				<div className={styles['subsection']}>
					<h5 className={styles['subheading']}>Version Information</h5>
					<div className={styles['content']}>
						<TextInfo className={styles['text-info']} label='Application Version'>
							{workerProperties?.version.application || 'Loading'}
						</TextInfo>
						<TextInfo className={styles['text-info']} label='HandBrake Version'>
							{workerProperties?.version.handbrake || 'Loading'}
						</TextInfo>
					</div>
				</div>
				<div className={styles['subsection']}>
					<h5 className={styles['subheading']}>Encoding Capabilities</h5>
					<div className={styles['content']}>
						{workerProperties ? (
							(
								Object.entries(workerProperties.capabilities) as [
									keyof WorkerCapabilities,
									boolean
								][]
							).map(([capability, supported]) => (
								<TextInfo
									className={styles['text-info']}
									label={capabilitiesLookup[capability]}
									data-supported={supported}
									key={`${worker}-${capability}`}
								>
									{getCapabilitiesLabel(supported)}
								</TextInfo>
							))
						) : (
							<TextInfo className={styles['text-info']} label='Capabilities'>
								Loading
							</TextInfo>
						)}
					</div>
				</div>
				<div className={styles['subsection']}>
					<h5 className={styles['subheading']}>Status Information</h5>
					<div className={styles['content']}>
						<TextInfo
							className={styles['text-info']}
							label='Activity Status'
							data-status={info.status.toLowerCase()}
						>
							{info.status}
						</TextInfo>
						<TextInfo className={styles['text-info']} label='Current Job'>
							{info.job}
						</TextInfo>
						<TextInfo className={styles['text-info']} label='Current Progress'>
							{info.job != 'N/A' ? (
								<ProgressBar
									className={styles['progress']}
									percentage={parseFloat(info.progress)}
								/>
							) : (
								info.progress
							)}
						</TextInfo>
					</div>
				</div>
			</div>
		</div>
	);
}
