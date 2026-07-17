import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
	CalculateCpuPercent,
	ParseCpuCapacity,
	ParseCpuUsageMicroseconds,
	ParseMemoryLimitBytes,
	WorkerResourceSampler,
	WorkerResourceUsageIntervalMs,
} from './resource-usage';

test('parses cgroup v2 CPU and memory limits', () => {
	assert.equal(WorkerResourceUsageIntervalMs, 10_000);
	assert.equal(ParseCpuUsageMicroseconds('usage_usec 12345\nuser_usec 10000\n'), 12345);
	assert.equal(ParseCpuCapacity('200000 100000', 8), 2);
	assert.equal(ParseCpuCapacity('max 100000', 8), 8);
	assert.equal(ParseMemoryLimitBytes('1073741824'), 1073741824);
	assert.equal(ParseMemoryLimitBytes('max'), null);
});

test('calculates CPU usage as a percentage of available capacity', () => {
	assert.equal(
		CalculateCpuPercent(
			{ usageMicroseconds: 1_000_000, timeMilliseconds: 1_000 },
			{ usageMicroseconds: 2_000_000, timeMilliseconds: 2_000 },
			2
		),
		50
	);
});

test('samples container RAM immediately and CPU after a second sample', async () => {
	const files: Record<string, string> = {
		'/sys/fs/cgroup/cpu.stat': 'usage_usec 1000000\n',
		'/sys/fs/cgroup/cpu.max': '100000 100000\n',
		'/sys/fs/cgroup/memory.current': '536870912\n',
		'/sys/fs/cgroup/memory.max': '1073741824\n',
	};
	let time = 1000;
	const sampler = new WorkerResourceSampler(
		async (path) => files[path]!,
		() => time,
		() => 123,
		4
	);

	assert.deepEqual(await sampler.sample(), {
		cpu_percent: null,
		memory_used_bytes: 536870912,
		memory_limit_bytes: 1073741824,
		sampled_at: 123,
	});

	files['/sys/fs/cgroup/cpu.stat'] = 'usage_usec 1500000\n';
	time = 2000;
	assert.deepEqual(await sampler.sample(), {
		cpu_percent: 50,
		memory_used_bytes: 536870912,
		memory_limit_bytes: 1073741824,
		sampled_at: 123,
	});
});
