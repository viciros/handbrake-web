export type ClientAuthStatusType = {
	username: string;
	must_change_credentials: boolean;
};

export type UpdateClientCredentialsType = {
	current_password?: string;
	username: string;
	new_password: string;
};

export type UpdateClientCredentialsResultType = {
	ok: boolean;
	message?: string;
	status?: ClientAuthStatusType;
	requires_reauth?: boolean;
};

export type WorkerAuthTokenRecordType = {
	worker_id: string;
	accepts_jobs: boolean;
	created_at: number;
	updated_at: number;
	last_used_at: number | null;
};

export type WorkerAuthTokenSecretResultType = {
	ok: boolean;
	message?: string;
	record?: WorkerAuthTokenRecordType;
	token?: string;
};

export type WorkerAuthTokenActionResultType = {
	ok: boolean;
	message?: string;
};
