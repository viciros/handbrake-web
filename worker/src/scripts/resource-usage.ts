import type { WorkerResourceUsage } from '@handbrake-web/shared/types/worker';
import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { Socket } from 'socket.io-client';
import logger from './logging';

export const WorkerResourceUsageIntervalMs = 10_000;
const cgroupRoot = '/sys/fs/cgroup';

type ReadTextFile = (path: string) => Promise<string>;

type PreviousCpuSample = {
	usageMicroseconds: number;
	timeMilliseconds: number;
};

const defaultReadTextFile: ReadTextFile = (path) => readFile(path, 'utf8');

const readOptional = async (readTextFile: ReadTextFile, path: string) => {
	try {
		return await readTextFile(path);
	} catch {
		return undefined;
	}
};

const parseNonNegativeNumber = (value: string | undefined) => {
	if (value == undefined) return null;
	const parsed = Number(value.trim());
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

export const ParseCpuUsageMicroseconds = (cpuStat: string | undefined) => {
	const usageLine = cpuStat
		?.split(/\r?\n/)
		.find((line) => line.trim().startsWith('usage_usec '));
	return parseNonNegativeNumber(usageLine?.trim().split(/\s+/)[1]);
};

export const ParseCpuCapacity = (
	cpuMax: string | undefined,
	fallbackCapacity = availableParallelism()
) => {
	const [quotaValue, periodValue] = cpuMax?.trim().split(/\s+/) ?? [];
	if (quotaValue == undefined || quotaValue == 'max') return Math.max(1, fallbackCapacity);

	const quota = parseNonNegativeNumber(quotaValue);
	const period = parseNonNegativeNumber(periodValue);
	return quota != null && period != null && quota > 0 && period > 0
		? quota / period
		: Math.max(1, fallbackCapacity);
};

export const ParseMemoryLimitBytes = (memoryMax: string | undefined) => {
	if (memoryMax?.trim() == 'max') return null;
	const limit = parseNonNegativeNumber(memoryMax);
	// cgroup v1 commonly represents an unlimited value with a number near 2^63.
	return limit != null && limit < 2 ** 60 ? limit : null;
};

export const CalculateCpuPercent = (
	previous: PreviousCpuSample,
	current: PreviousCpuSample,
	capacity: number
) => {
	const usageDelta = current.usageMicroseconds - previous.usageMicroseconds;
	const elapsedMicroseconds = (current.timeMilliseconds - previous.timeMilliseconds) * 1000;
	if (usageDelta < 0 || elapsedMicroseconds <= 0 || capacity <= 0) return null;

	return Math.min(100, Math.max(0, (usageDelta / elapsedMicroseconds / capacity) * 100));
};

export class WorkerResourceSampler {
	private previousCpuSample: PreviousCpuSample | undefined;

	constructor(
		private readonly readTextFile: ReadTextFile = defaultReadTextFile,
		private readonly getTimeMilliseconds = () => performance.now(),
		private readonly getTimestamp = () => Date.now(),
		private readonly fallbackCpuCapacity = availableParallelism()
	) {}

	async sample(): Promise<WorkerResourceUsage> {
		const timeMilliseconds = this.getTimeMilliseconds();
		const [cpuStat, cpuMax, memoryCurrent, memoryMax] = await Promise.all([
			readOptional(this.readTextFile, `${cgroupRoot}/cpu.stat`),
			readOptional(this.readTextFile, `${cgroupRoot}/cpu.max`),
			readOptional(this.readTextFile, `${cgroupRoot}/memory.current`),
			readOptional(this.readTextFile, `${cgroupRoot}/memory.max`),
		]);

		const usageMicroseconds = ParseCpuUsageMicroseconds(cpuStat);
		let cpuPercent: number | null = null;
		if (usageMicroseconds != null) {
			const currentCpuSample = { usageMicroseconds, timeMilliseconds };
			if (this.previousCpuSample) {
				cpuPercent = CalculateCpuPercent(
					this.previousCpuSample,
					currentCpuSample,
					ParseCpuCapacity(cpuMax, this.fallbackCpuCapacity)
				);
			}
			this.previousCpuSample = currentCpuSample;
		} else {
			this.previousCpuSample = undefined;
		}

		return {
			cpu_percent: cpuPercent,
			memory_used_bytes: parseNonNegativeNumber(memoryCurrent),
			memory_limit_bytes: ParseMemoryLimitBytes(memoryMax),
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
			logger.warn(`[resources] [warn] Could not sample worker resource usage.`);
			logger.warn(err);
		} finally {
			this.sampleInProgress = false;
		}
	}
}
