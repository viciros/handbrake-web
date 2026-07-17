import { FormatLogError } from '@handbrake-web/shared/logger';

type RetryLogger = {
	info(message: string): unknown;
	warn(message: string): unknown;
};

type RetryTimer = ReturnType<typeof setTimeout>;

type ConnectionRetryOptions = {
	baseDelayMs?: number;
	maxDelayMs?: number;
	random?: () => number;
	setTimeoutFn?: (callback: () => void, delayMs: number) => RetryTimer;
	clearTimeoutFn?: (timer: RetryTimer) => void;
};

export const GetConnectionRetryDelayMs = (
	attempt: number,
	randomValue = Math.random(),
	baseDelayMs = 1000,
	maxDelayMs = 60_000
) => {
	const exponentialDelay = Math.min(baseDelayMs * 2 ** Math.min(attempt, 16), maxDelayMs);
	const jitterFactor = 0.8 + Math.min(Math.max(randomValue, 0), 1) * 0.4;
	return Math.max(1, Math.min(maxDelayMs, Math.round(exponentialDelay * jitterFactor)));
};

export class ConnectionRetryController {
	private retryAttempt = 0;
	private failureCount = 0;
	private repeatedFailureCount = 0;
	private lastFailureKey = '';
	private retryTimer: RetryTimer | undefined;
	private stopped = false;

	private readonly baseDelayMs: number;
	private readonly maxDelayMs: number;
	private readonly random: () => number;
	private readonly setTimeoutFn: (callback: () => void, delayMs: number) => RetryTimer;
	private readonly clearTimeoutFn: (timer: RetryTimer) => void;

	constructor(
		private readonly connect: () => void,
		private readonly logger: RetryLogger,
		options: ConnectionRetryOptions = {}
	) {
		this.baseDelayMs = options.baseDelayMs ?? 1000;
		this.maxDelayMs = options.maxDelayMs ?? 60_000;
		this.random = options.random ?? Math.random;
		this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
		this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
	}

	start() {
		this.stopped = false;
		this.attemptConnection();
	}

	connected() {
		if (this.retryTimer) {
			this.clearTimeoutFn(this.retryTimer);
			this.retryTimer = undefined;
		}
		if (this.failureCount > 0) {
			this.logger.info(`[socket] Connection restored after ${this.failureCount} failed attempt(s).`);
		}
		this.retryAttempt = 0;
		this.failureCount = 0;
		this.repeatedFailureCount = 0;
		this.lastFailureKey = '';
	}

	failed(reason: string, error?: unknown) {
		if (this.stopped || this.retryTimer) return;

		const failure = error == undefined ? reason : `${reason}: ${FormatLogError(error)}`;
		const failureKey =
			error instanceof Error
				? `${reason}:${error.name}:${error.message}`
				: error == undefined
				? reason
				: `${reason}:${String(error)}`;
		this.failureCount += 1;
		this.repeatedFailureCount =
			failureKey == this.lastFailureKey ? this.repeatedFailureCount + 1 : 1;
		const delayMs = GetConnectionRetryDelayMs(
			this.retryAttempt,
			this.random(),
			this.baseDelayMs,
			this.maxDelayMs
		);
		const shouldLog =
			failureKey != this.lastFailureKey ||
			this.repeatedFailureCount == 1 ||
			this.repeatedFailureCount % 10 == 0;
		if (shouldLog) {
			const repeated =
				this.repeatedFailureCount > 1
					? ` (${this.repeatedFailureCount} consecutive identical failures)`
					: '';
			this.logger.warn(
				`[socket] [warn] ${failure}${repeated}. Retrying in ${(delayMs / 1000).toFixed(1)} seconds.`
			);
		}
		this.lastFailureKey = failureKey;
		this.retryAttempt += 1;
		this.retryTimer = this.setTimeoutFn(() => {
			this.retryTimer = undefined;
			this.attemptConnection();
		}, delayMs);
	}

	stop() {
		this.stopped = true;
		if (this.retryTimer) {
			this.clearTimeoutFn(this.retryTimer);
			this.retryTimer = undefined;
		}
	}

	hasPendingRetry() {
		return this.retryTimer != undefined;
	}

	private attemptConnection() {
		if (this.stopped) return;
		try {
			this.connect();
		} catch (err) {
			this.failed('Connection attempt failed', err);
		}
	}
}
