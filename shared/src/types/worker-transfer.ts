export type WorkerTransferPurpose = 'input' | 'output';

export type WorkerJobData = {
	job_id: number;
	preset_category: string;
	preset_id: string;
	input_name: string;
	output_name: string;
};

export type WorkerTransferLease = {
	path: string;
	token: string;
	purpose: WorkerTransferPurpose;
	expiresAt: number;
	contentLength?: number;
};
