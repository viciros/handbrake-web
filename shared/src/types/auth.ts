export type ClientAuthStatusType = {
	username: string;
	must_change_credentials: boolean;
};

export type UpdateClientCredentialsType = {
	current_password: string;
	username: string;
	new_password: string;
};

export type UpdateClientCredentialsResultType = {
	ok: boolean;
	message?: string;
	status?: ClientAuthStatusType;
	requires_reauth?: boolean;
};
