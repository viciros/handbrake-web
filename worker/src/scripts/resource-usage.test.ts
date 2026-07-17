import { strict as assert } from 'node:assert';
import test from 'node:test';
import { CalculateMemoryAvailablePercent } from '@handbrake-web/shared/funcs/resource.funcs';
import {
	CalculateHostCpuPercent,
	ParseHostCpuSample,
	ParseHostMemorySample,
	WorkerResourceSampler,
	WorkerResourceUsageIntervalMs,
} from './resource-usage';

test('parses aggregate host CPU counters without double-counting guest time', () => {
	assert.equal(WorkerResourceUsageIntervalMs, 10_000);
	assert.deepEqual(
		ParseHostCpuSample(
			'cpu  100 10 50 800 20 5 5 10 999 999\ncpu0 50 5 25 400 10 2 3 5 0 0\n'
		),
		{ totalTicks: 1000, idleTicks: 820 }
	);
	assert.equal(ParseHostCpuSample('cpu0 1 2 3 4\n'), null);
	assert.equal(ParseHostCpuSample('cpu 1 2 invalid 4\n'), null);
	assert.equal(ParseHostCpuSample('cpu 1 2 -3 4\n'), null);
});

test('calculates host CPU utilization and rejects reset counters', () => {
	assert.equal(
		CalculateHostCpuPercent(
			{ totalTicks: 1000, idleTicks: 800 },
			{ totalTicks: 2000, idleTicks: 1200 }
		),
		60
	);
	assert.equal(
		CalculateHostCpuPercent(
			{ totalTicks: 2000, idleTicks: 1200 },
			{ totalTicks: 1000, idleTicks: 800 }
		),
		null
	);
});

test('parses host available and total memory and calculates the free percentage', () => {
	const memory = ParseHostMemorySample(
		'MemTotal:       1048576 kB\nMemFree:         131072 kB\nMemAvailable:    786432 kB\n'
	);
	assert.deepEqual(memory, {
		availableBytes: 805306368,
		totalBytes: 1073741824,
	});
	assert.equal(
		CalculateMemoryAvailablePercent(memory!.availableBytes, memory!.totalBytes),
		75
	);
	assert.equal(ParseHostMemorySample('MemTotal: 1024 kB\n'), null);
	assert.equal(
		ParseHostMemorySample('MemTotal: 1024 kB\nMemAvailable: 2048 kB\n'),
		null
	);
	assert.equal(CalculateMemoryAvailablePercent(2, 1), null);
});

test('samples host memory immediately and CPU after a second sample', async () => {
	const files: Record<string, string> = {
		'/proc/stat': 'cpu 100 0 100 800 0 0 0 0 0 0\n',
		'/proc/meminfo': 'MemTotal: 1048576 kB\nMemAvailable: 524288 kB\n',
	};
	const sampler = new WorkerResourceSampler(
		async (path) => files[path]!,
		() => 123
	);

	assert.deepEqual(await sampler.sample(), {
		host_cpu_percent: null,
		host_memory_available_bytes: 536870912,
		host_memory_total_bytes: 1073741824,
		sampled_at: 123,
	});

	files['/proc/stat'] = 'cpu 300 0 200 1500 0 0 0 0 0 0\n';
	assert.deepEqual(await sampler.sample(), {
		host_cpu_percent: 30,
		host_memory_available_bytes: 536870912,
		host_memory_total_bytes: 1073741824,
		sampled_at: 123,
	});
});

test('reports unavailable host metrics for missing or malformed proc data', async () => {
	const sampler = new WorkerResourceSampler(async () => {
		throw new Error('unavailable');
	});
	const usage = await sampler.sample();

	assert.equal(usage.host_cpu_percent, null);
	assert.equal(usage.host_memory_available_bytes, null);
	assert.equal(usage.host_memory_total_bytes, null);
	assert.equal(typeof usage.sampled_at, 'number');
});
