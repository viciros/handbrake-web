export interface WorkerProperties {
	version: WorkerVersion;
	capabilities: WorkerCapabilities;
}

export interface WorkerVersion {
	handbrake: string;
	application: string;
}

export interface WorkerCapabilities {
	cpu: boolean;
	qsv: boolean;
	nvenc: boolean;
	vcn: boolean;
}

export type WorkerPropertiesMap = Record<string, WorkerProperties>;

export interface WorkerResourceUsage {
	cpu_percent: number | null;
	memory_used_bytes: number | null;
	memory_limit_bytes: number | null;
	sampled_at: number;
}

export type WorkerResourceUsageMap = Record<string, WorkerResourceUsage>;
