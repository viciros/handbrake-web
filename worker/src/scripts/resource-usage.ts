import type { WorkerResourceUsage } from '@handbrake-web/shared/types/worker';
import { readFile } from 'node:fs/promises';
import type { Socket } from 'socket.io-client';
import logger from './logging';

export const WorkerResourceUsageIntervalMs = 10_000;

type ReadTextFile = (path: string) => Promise<string>;

export type HostCpuSample = {
	totalTicks: number;
	idleTicks: number;
};

export type HostMemorySample = {
	availableBytes: number;
	totalBytes: number;
};

const defaultReadTextFile: ReadTextFile = (path) => readFile(path, 'utf8');

const readOptional = async (readTextFile: ReadTextFile, path: string) => {
	try {
		return await readTextFile(path);
	} catch {
		return undefined;
	}
};

export const ParseHostCpuSample = (procStat: string | undefined): HostCpuSample | null => {
	const aggregateCpuLine = procStat
		?.split(/\r?\n/)
		.find((line) => /^cpu\s/.test(line));
	if (!aggregateCpuLine) return null;

	const counters = aggregateCpuLine
		.trim()
		.split(/\s+/)
		.slice(1, 9)
		.map(Number);
	if (
		counters.length < 4 ||
		counters.some((counter) => !Number.isFinite(counter) || counter < 0)
	) {
		return null;
	}

	const totalTicks = counters.reduce((total, counter) => total + counter, 0);
	const idleTicks = counters[3]! + (counters[4] ?? 0);
	return { totalTicks, idleTicks };
};

export const CalculateHostCpuPercent = (
	previous: HostCpuSample,
	current: HostCpuSample
) => {
	const totalDelta = current.totalTicks - previous.totalTicks;
	const idleDelta = current.idleTicks - previous.idleTicks;
	if (totalDelta <= 0 || idleDelta < 0 || idleDelta > totalDelta) return null;

	return Math.min(100, Math.max(0, ((totalDelta - idleDelta) / totalDelta) * 100));
};

const parseMemoryKilobytes = (procMemInfo: string, name: string) => {
	const match = procMemInfo.match(new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, 'm'));
	if (!match) return null;

	const kilobytes = Number(match[1]);
	const bytes = kilobytes * 1024;
	return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
};

export const ParseHostMemorySample = (
	procMemInfo: string | undefined
): HostMemorySample | null => {
	if (!procMemInfo) return null;

	const availableBytes = parseMemoryKilobytes(procMemInfo, 'MemAvailable');
	const totalBytes = parseMemoryKilobytes(procMemInfo, 'MemTotal');
	if (
		availableBytes == null ||
		totalBytes == null ||
		totalBytes <= 0 ||
		availableBytes > totalBytes
	) {
		return null;
	}

	return { availableBytes, totalBytes };
};

export class WorkerResourceSampler {
	private previousCpuSample: HostCpuSample | undefined;

	constructor(
		private readonly readTextFile: ReadTextFile = defaultReadTextFile,
		private readonly getTimestamp = () => Date.now()
	) {}

	async sample(): Promise<WorkerResourceUsage> {
		const [procStat, procMemInfo] = await Promise.all([
			readOptional(this.readTextFile, '/proc/stat'),
			readOptional(this.readTextFile, '/proc/meminfo'),
		]);

		const cpuSample = ParseHostCpuSample(procStat);
		let hostCpuPercent: number | null = null;
		if (cpuSample) {
			if (this.previousCpuSample) {
				hostCpuPercent = CalculateHostCpuPercent(this.previousCpuSample, cpuSample);
			}
			this.previousCpuSample = cpuSample;
		} else {
			this.previousCpuSample = undefined;
		}

		const memorySample = ParseHostMemorySample(procMemInfo);
		return {
			host_cpu_percent: hostCpuPercent,
			host_memory_available_bytes: memorySample?.availableBytes ?? null,
			host_memory_total_bytes: memorySample?.totalBytes ?? null,
			sampled_at: this.getTimestamp(),
		};
	}
}

export class WorkerResourceUsageReporter {
	private timer: ReturnType<typeof setInterval> | undefined;
	private sampleInProgress = false;

	constructor(
		private readonly socket: Socket,
		private readonly sampler = new WorkerResourceSampler()
	) {}

	start() {
		if (this.timer) return;
		void this.report();
		this.timer = setInterval(() => void this.report(), WorkerResourceUsageIntervalMs);
	}

	stop() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	private async report() {
		if (this.sampleInProgress) return;
		this.sampleInProgress = true;
		try {
			const usage = await this.sampler.sample();
			if (this.socket.connected) this.socket.emit('resource-usage', usage);
		} catch (err) {
			logger.warn(`[resources] [warn] Could not sample worker host resource usage.`);
			logger.warn(err);
		} finally {
			this.sampleInProgress = false;
		}
	}
}
