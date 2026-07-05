import type { Generated, Insertable, Selectable, Updateable } from 'kysely';
import type { TranscodeStage } from './transcode';

export interface Database {
	migrations: MigrationsTable;
	migrations_lock: MigrationsLockTable;
	client_auth: ClientAuthTable;
	worker_auth_tokens: WorkerAuthTokensTable;
	status: StatusTable;
	jobs: JobsTable;
	jobs_status: JobsStatusTable;
	jobs_order: JobsOrderTable;
	watchers: WatchersTable;
	watcher_rules: WatcherRulesTable;
}

// Migration Tables --------------------------------------------------------------------------------
export interface MigrationsTable {
	name: string;
	timestamp: string;
}

export interface MigrationsLockTable {
	id: string;
	is_locked: number;
}

// Client Auth Table ------------------------------------------------------------------------------
export interface ClientAuthTable {
	id: string;
	username: string;
	password_hash: string;
	must_change_credentials: boolean;
	created_at: number;
	updated_at: number;
}

export type ClientAuthType = Selectable<ClientAuthTable>;
export type AddClientAuthType = Insertable<ClientAuthTable>;
export type UpdateClientAuthType = Updateable<ClientAuthTable>;

// Worker Auth Tokens Table -----------------------------------------------------------------------
export interface WorkerAuthTokensTable {
	worker_id: string;
	token_hash: string;
	created_at: number;
	updated_at: number;
	last_used_at: number | null;
}

export type WorkerAuthTokenType = Selectable<WorkerAuthTokensTable>;
export type AddWorkerAuthTokenType = Insertable<WorkerAuthTokensTable>;
export type UpdateWorkerAuthTokenType = Updateable<WorkerAuthTokensTable>;

// Status Table ------------------------------------------------------------------------------------
export interface StatusTable {
	id: string;
	state: number;
}

export type StatusType = Selectable<StatusTable>;
export type AddStatusType = Omit<Insertable<StatusTable>, 'id'>;
export type UpdateStatusType = Omit<Updateable<StatusTable>, 'id'>;

// Jobs Tables -------------------------------------------------------------------------------------

// Jobs --------------------------------------------------------------------------------
export interface JobsTable {
	job_id: Generated<number>;
	input_path: string;
	output_path: string;
	preset_category: string;
	preset_id: string;
}

// Jobs Status -------------------------------------------------------------------------
export interface JobsStatusTable {
	job_id: number;
	worker_id: string | null;
	transcode_stage: Generated<TranscodeStage>;
	transcode_percentage: Generated<number>;
	transcode_eta: Generated<number>;
	transcode_fps_current: Generated<number>;
	transcode_fps_average: Generated<number>;
	time_started: Generated<number>;
	time_finished: Generated<number>;
}

// Jobs Order --------------------------------------------------------------------------
export interface JobsOrderTable {
	job_id: number;
	order_index: number;
}

// Derived Job Types -------------------------------------------------------------------
export type JobType = Selectable<JobsTable>;
export type AddJobType = Omit<Insertable<JobsTable>, 'job_id'>;
export type UpdateJobType = Omit<Updateable<JobsTable>, 'job_id'>;

export type JobStatusType = Selectable<JobsStatusTable>;
export type AddJobStatusType = Omit<Insertable<JobsStatusTable>, 'job_id'>;
export type UpdateJobStatusType = Omit<Updateable<JobsStatusTable>, 'job_id'>;

export type JobOrderType = Selectable<JobsOrderTable>;
export type AddJobOrderType = Omit<Insertable<JobsOrderTable>, 'job_id'>;
export type UpdateJobOrderType = Omit<Updateable<JobsOrderTable>, 'job_id'>;

export type DetailedJobType = JobType & JobStatusType & JobOrderType;

// Watcher Tables ----------------------------------------------------------------------------------

// Watchers ----------------------------------------------------------------------------
export interface WatchersTable {
	output_path: string | null;
	preset_category: string;
	preset_id: string;
	watch_path: string;
	watcher_id: Generated<number>;
	start_queue: boolean;
}

// Watcher Rules -----------------------------------------------------------------------
export interface WatcherRulesTable {
	rule_id: Generated<number>;
	watcher_id: number;
	name: string;
	mask: number;
	base_rule_method: number;
	rule_method: number;
	comparison_method: number;
	comparison: string;
}

// Watcher Derived Types ---------------------------------------------------------------
export type WatchersType = Selectable<WatchersTable>;
export type AddWatcherType = Omit<Insertable<WatchersTable>, 'watcher_id'>;
export type UpdateWatcherType = Omit<Updateable<WatchersTable>, 'watcher_id'>;

export type WatcherRuleType = Selectable<WatcherRulesTable>;
export type AddWatcherRuleType = Omit<Insertable<WatcherRulesTable>, 'watcher_id' | 'rule_id'>;
export type UpdateWatcherRuleType = Omit<Updateable<WatcherRulesTable>, 'watcher_id' | 'rule_id'>;

export type DetailedWatcherRuleType = Omit<Selectable<WatcherRulesTable>, 'watcher_id'>;
export type DetailedWatcherType = WatchersType & {
	rules: DetailedWatcherRuleType[];
};
