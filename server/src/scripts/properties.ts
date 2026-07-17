import type {
	WorkerProperties,
	WorkerResourceUsage,
} from '@handbrake-web/shared/types/worker';
import { EmitToAllClients } from './connections';

const workerProperties: Record<string, WorkerProperties> = {};
const workerResourceUsage: Record<string, WorkerResourceUsage> = {};

export function GetWorkerProperties() {
	return workerProperties;
}

export function AddWorkerProperties(workerID: string, properties: WorkerProperties) {
	workerProperties[workerID] = properties;
	UpdateWorkerProperties();
}

export function RemoveWorkerProperties(workerID: string) {
	delete workerProperties[workerID];
	UpdateWorkerProperties();
}

export function UpdateWorkerProperties() {
	EmitToAllClients('properties-update', workerProperties);
}

export function GetWorkerResourceUsage() {
	return workerResourceUsage;
}

const isNullableFiniteNumber = (value: unknown) =>
	value === null || (typeof value == 'number' && Number.isFinite(value));

const isNullableNonNegativeSafeInteger = (value: unknown) =>
	value === null || (typeof value == 'number' && Number.isSafeInteger(value) && value >= 0);

export function NormalizeWorkerResourceUsage(value: unknown): WorkerResourceUsage | undefined {
	if (value == null || typeof value != 'object') return undefined;

	const usage = value as Partial<WorkerResourceUsage>;
	if (
		!isNullableFiniteNumber(usage.host_cpu_percent) ||
		!isNullableNonNegativeSafeInteger(usage.host_memory_available_bytes) ||
		!isNullableNonNegativeSafeInteger(usage.host_memory_total_bytes) ||
		(typeof usage.host_cpu_percent == 'number' &&
			(usage.host_cpu_percent < 0 || usage.host_cpu_percent > 100)) ||
		(usage.host_memory_available_bytes == null) !=
			(usage.host_memory_total_bytes == null) ||
		(typeof usage.host_memory_total_bytes == 'number' &&
			usage.host_memory_total_bytes <= 0) ||
		(typeof usage.host_memory_available_bytes == 'number' &&
			typeof usage.host_memory_total_bytes == 'number' &&
			usage.host_memory_available_bytes > usage.host_memory_total_bytes)
	) {
		return undefined;
	}

	return {
		host_cpu_percent: usage.host_cpu_percent ?? null,
		host_memory_available_bytes: usage.host_memory_available_bytes ?? null,
		host_memory_total_bytes: usage.host_memory_total_bytes ?? null,
		sampled_at: Date.now(),
	};
}

export function SetWorkerResourceUsage(workerID: string, usage: WorkerResourceUsage) {
	workerResourceUsage[workerID] = usage;
	EmitToAllClients('worker-resource-usage-update', workerResourceUsage);
}

export function RemoveWorkerResourceUsage(workerID: string) {
	delete workerResourceUsage[workerID];
	EmitToAllClients('worker-resource-usage-update', workerResourceUsage);
}
