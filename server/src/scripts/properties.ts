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

export function NormalizeWorkerResourceUsage(value: unknown): WorkerResourceUsage | undefined {
	if (value == null || typeof value != 'object') return undefined;

	const usage = value as Partial<WorkerResourceUsage>;
	if (
		!isNullableFiniteNumber(usage.cpu_percent) ||
		!isNullableFiniteNumber(usage.memory_used_bytes) ||
		!isNullableFiniteNumber(usage.memory_limit_bytes) ||
		(typeof usage.cpu_percent == 'number' &&
			(usage.cpu_percent < 0 || usage.cpu_percent > 100)) ||
		(typeof usage.memory_used_bytes == 'number' && usage.memory_used_bytes < 0) ||
		(typeof usage.memory_limit_bytes == 'number' && usage.memory_limit_bytes < 0)
	) {
		return undefined;
	}

	return {
		cpu_percent: usage.cpu_percent ?? null,
		memory_used_bytes: usage.memory_used_bytes ?? null,
		memory_limit_bytes: usage.memory_limit_bytes ?? null,
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
