import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test, { before } from 'node:test';
import { QueueStartupBehavior } from '@handbrake-web/shared/types/config';

let testRoot = '';
let videoPath = '';

before(async () => {
	testRoot = path.join(
		os.tmpdir(),
		`handbrake-web-server-security-${randomBytes(8).toString('hex')}`
	);
	const dataPath = path.join(testRoot, 'data');
	videoPath = path.join(testRoot, 'video');
	await mkdir(dataPath, { recursive: true });
	await mkdir(videoPath, { recursive: true });

	process.env.DATA_PATH = dataPath;

	const { DatabaseConnect } = await import('./database/database');
	await DatabaseConnect();
});

test('does not require worker auth env config', async () => {
	const auth = await import('./auth');

	assert.equal('ValidateAuthConfig' in auth, false);
});

test('formats unknown log errors without empty output', async () => {
	const { FormatLogError } = await import('@handbrake-web/shared/logger');
	const causedError = new Error('outer failure', { cause: new Error('inner failure') });

	assert.match(FormatLogError(causedError), /outer failure/);
	assert.match(FormatLogError(causedError), /inner failure/);
	assert.equal(FormatLogError(undefined), 'undefined');
	assert.match(FormatLogError({ value: undefined }), /"\[undefined\]"/);
});

test('hashes client auth passwords', async () => {
	const { HashClientPassword, VerifyClientPasswordHash } = await import('./auth');
	const password = 'correct horse battery staple';
	const hash = await HashClientPassword(password);

	assert.notEqual(hash, password);
	assert.equal(hash.includes(password), false);
	assert.equal(await VerifyClientPasswordHash(password, hash), true);
	assert.equal(await VerifyClientPasswordHash('wrong password', hash), false);
});

test('initializes generated client auth credentials', async () => {
	const { DatabaseGetClientAuth } = await import('./database/database-auth');
	const { InitializeClientAuth, UpdateClientAuthCredentials, VerifyClientPasswordHash } =
		await import('./auth');

	const result = await InitializeClientAuth();
	const storedCredentials = await DatabaseGetClientAuth();

	assert.equal(result.status.username, 'admin');
	assert.equal(result.status.must_change_credentials, true);
	assert.ok(result.generatedPassword);
	assert.ok(storedCredentials);
	assert.equal(storedCredentials.password_hash.includes(result.generatedPassword), false);
	assert.equal(
		await VerifyClientPasswordHash(result.generatedPassword, storedCredentials.password_hash),
		true
	);

	const rotatedResult = await InitializeClientAuth();
	const rotatedCredentials = await DatabaseGetClientAuth();

	assert.ok(rotatedResult.generatedPassword);
	assert.notEqual(rotatedResult.generatedPassword, result.generatedPassword);
	assert.ok(rotatedCredentials);
	assert.equal(rotatedCredentials.password_hash.includes(rotatedResult.generatedPassword), false);
	assert.equal(
		await VerifyClientPasswordHash(result.generatedPassword, rotatedCredentials.password_hash),
		false
	);
	assert.equal(
		await VerifyClientPasswordHash(
			rotatedResult.generatedPassword,
			rotatedCredentials.password_hash
		),
		true
	);

	const updateResult = await UpdateClientAuthCredentials({
		username: 'admin',
		new_password: 'changed-password-value',
	});

	assert.equal(updateResult.ok, true);
	assert.equal(updateResult.status?.username, 'admin');
	assert.equal(updateResult.status?.must_change_credentials, false);

	const secondUpdateResult = await UpdateClientAuthCredentials({
		username: 'admin',
		new_password: 'second-changed-password-value',
	});

	assert.equal(secondUpdateResult.ok, false);
	assert.match(String(secondUpdateResult.message), /Current password/);
});

test('validates signed client auth session tokens', async () => {
	const { CreateClientAuthSessionToken, IsClientAuthSessionTokenValid } = await import('./auth');

	const currentCredentials = {
		id: 'client',
		username: 'web-user',
		password_hash: 'hash',
		must_change_credentials: false,
		created_at: 1,
		updated_at: 123,
	};

	const token = CreateClientAuthSessionToken('web-user', currentCredentials.updated_at);
	const tamperedToken = `${token.slice(0, -1)}x`;
	const wrongUserToken = CreateClientAuthSessionToken(
		'other-user',
		currentCredentials.updated_at
	);
	const oldCredentialsToken = CreateClientAuthSessionToken('web-user', 122);

	assert.equal(IsClientAuthSessionTokenValid(token, currentCredentials), true);
	assert.equal(IsClientAuthSessionTokenValid(tamperedToken, currentCredentials), false);
	assert.equal(IsClientAuthSessionTokenValid(wrongUserToken, currentCredentials), false);
	assert.equal(IsClientAuthSessionTokenValid(oldCredentialsToken, currentCredentials), false);
});

test('validates worker IDs', async () => {
	const { IsValidWorkerID } = await import('./auth');

	assert.equal(IsValidWorkerID('worker-01.main'), true);
	assert.equal(IsValidWorkerID('worker 01'), false);
	assert.equal(IsValidWorkerID('../worker'), false);
	assert.equal(IsValidWorkerID('x'.repeat(65)), false);
});

test('creates, verifies, rotates, and revokes worker tokens', async () => {
	const {
		AuthenticateWorkerSocket,
		CreateWorkerAuthToken,
		RevokeWorkerAuthToken,
		RotateWorkerAuthToken,
		SetWorkerEnabled,
		VerifySecretHash,
	} = await import('./auth');
	const { DatabaseGetWorkerAuthToken } = await import('./database/database-worker-auth');
	const workerID = 'worker-token-test';

	const created = await CreateWorkerAuthToken(workerID);
	assert.equal(created.ok, true);
	assert.ok(created.token);

	const storedCreatedToken = await DatabaseGetWorkerAuthToken(workerID);
	assert.ok(storedCreatedToken);
	assert.equal(storedCreatedToken.accepts_jobs, true);
	assert.notEqual(storedCreatedToken.token_hash, created.token);
	assert.equal(storedCreatedToken.token_hash.includes(created.token), false);
	assert.equal(await VerifySecretHash(created.token, storedCreatedToken.token_hash), true);
	assert.equal(await VerifySecretHash('wrong token', storedCreatedToken.token_hash), false);

	const disabled = await SetWorkerEnabled(workerID, false);
	assert.equal(disabled.ok, true);
	const storedDisabledToken = await DatabaseGetWorkerAuthToken(workerID);
	assert.ok(storedDisabledToken);
	assert.equal(storedDisabledToken.accepts_jobs, false);
	const pausedWorkerSocket = {
		id: 'paused-worker-socket',
		data: {},
		handshake: {
			address: 'paused-worker-test',
			auth: { token: created.token },
			query: { workerID },
		},
		conn: { remoteAddress: 'paused-worker-test' },
	};
	await new Promise<void>((resolve, reject) => {
		AuthenticateWorkerSocket(pausedWorkerSocket as never, (err) => {
			if (err) reject(err);
			else resolve();
		});
	});
	assert.equal((pausedWorkerSocket.data as { acceptsJobs?: boolean }).acceptsJobs, false);

	const enabled = await SetWorkerEnabled(workerID, true);
	assert.equal(enabled.ok, true);
	const storedEnabledToken = await DatabaseGetWorkerAuthToken(workerID);
	assert.ok(storedEnabledToken);
	assert.equal(storedEnabledToken.accepts_jobs, true);

	const rotated = await RotateWorkerAuthToken(workerID);
	assert.equal(rotated.ok, true);
	assert.ok(rotated.token);
	assert.notEqual(rotated.token, created.token);

	const storedRotatedToken = await DatabaseGetWorkerAuthToken(workerID);
	assert.ok(storedRotatedToken);
	assert.equal(await VerifySecretHash(rotated.token, storedRotatedToken.token_hash), true);
	assert.equal(storedRotatedToken.last_used_at, null);

	const revoked = await RevokeWorkerAuthToken(workerID);
	assert.equal(revoked.ok, true);
	assert.equal(await DatabaseGetWorkerAuthToken(workerID), undefined);
});

test('migration preserves worker job acceptance state', async () => {
	const SQLite = (await import('better-sqlite3')).default;
	const { Kysely, SqliteDialect } = await import('kysely');
	const migration = await import('./database/migrations/migration-7');
	const sqlite = new SQLite(':memory:');
	const migrationDatabase = new Kysely<any>({
		dialect: new SqliteDialect({ database: sqlite }),
	});

	try {
		await migrationDatabase.schema
			.createTable('worker_auth_tokens')
			.addColumn('worker_id', 'text', (col) => col.primaryKey())
			.addColumn('is_enabled', 'boolean', (col) => col.notNull())
			.execute();
		await migrationDatabase
			.insertInto('worker_auth_tokens')
			.values([
				{ worker_id: 'enabled-worker', is_enabled: 1 },
				{ worker_id: 'disabled-worker', is_enabled: 0 },
			])
			.execute();

		await migration.up(migrationDatabase);
		const migratedWorkers = await migrationDatabase
			.selectFrom('worker_auth_tokens')
			.select(['worker_id', 'accepts_jobs'])
			.orderBy('worker_id')
			.execute();
		assert.deepEqual(migratedWorkers, [
			{ worker_id: 'disabled-worker', accepts_jobs: 0 },
			{ worker_id: 'enabled-worker', accepts_jobs: 1 },
		]);

		await migration.down(migrationDatabase);
		const restoredWorker = await migrationDatabase
			.selectFrom('worker_auth_tokens')
			.select(['worker_id', 'is_enabled'])
			.where('worker_id', '=', 'disabled-worker')
			.executeTakeFirstOrThrow();
		assert.equal(restoredWorker.is_enabled, 0);
	} finally {
		await migrationDatabase.destroy();
	}
});

test('accepts independent configured input and output paths', async () => {
	const { ValidateConfig } = await import('./config/config');
	const inputPath = path.join(testRoot, 'downloads');
	const outputPath = path.join(testRoot, 'encoded');

	assert.doesNotThrow(() =>
		ValidateConfig({
			config: {
				version: 3,
			},
			paths: {
				'input-path': inputPath,
				'output-path': outputPath,
			},
			presets: {
				'show-default-presets': true,
				'allow-preset-creator': false,
			},
			application: {
				'queue-startup-behavior': QueueStartupBehavior.Previous,
				'update-check-interval': 12,
			},
		})
	);
});

test('validates output upload Content-Length against 2x the input size', async () => {
	const { GetMaxOutputUploadBytes, ValidateOutputUploadContentLength } = await import(
		'./worker-transfers'
	);
	const maxOutputUploadBytes = GetMaxOutputUploadBytes(10);

	assert.deepEqual(ValidateOutputUploadContentLength(undefined, maxOutputUploadBytes), {
		ok: false,
		status: 411,
		message: 'Missing Content-Length.',
	});
	assert.deepEqual(ValidateOutputUploadContentLength(null, maxOutputUploadBytes), {
		ok: false,
		status: 400,
		message: 'Invalid Content-Length.',
	});
	assert.deepEqual(ValidateOutputUploadContentLength(21, maxOutputUploadBytes), {
		ok: false,
		status: 413,
		message: 'Output upload is larger than the allowed limit.',
	});
	assert.deepEqual(ValidateOutputUploadContentLength(20, maxOutputUploadBytes), {
		ok: true,
		contentLength: 20,
	});
});

test('stops output streams larger than the input size', async () => {
	const { ByteLimitTransform, UploadTooLargeError } = await import('./worker-transfers');
	const sink = new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		},
	});

	await assert.rejects(
		pipeline(Readable.from([Buffer.alloc(4), Buffer.alloc(4)]), new ByteLimitTransform(7), sink),
		UploadTooLargeError
	);
});

test('returns newest matching worker log and removes all job logs', async () => {
	const { GetJobLogByID, RemoveJobLogByID, logPath } = await import('./logging');
	const jobID = 987654;
	const olderLogPath = path.join(logPath, `worker-old-job-${jobID}.log`);
	const newerLogPath = path.join(logPath, `worker-new-job-${jobID}.log`);
	const olderTime = new Date(Date.now() - 10_000);
	const newerTime = new Date();

	await mkdir(logPath, { recursive: true });
	await writeFile(olderLogPath, 'old log');
	await writeFile(newerLogPath, 'new log');
	await utimes(olderLogPath, olderTime, olderTime);
	await utimes(newerLogPath, newerTime, newerTime);

	assert.equal(await GetJobLogByID(jobID), newerLogPath);

	await RemoveJobLogByID(jobID);

	assert.equal(await GetJobLogByID(jobID), undefined);
});

test('rejects browser-root symlink escapes', async (t) => {
	const { AssertExistingDirectoryInRoot } = await import('./path-safety');
	const outsidePath = path.join(testRoot, 'outside');
	const linkPath = path.join(videoPath, 'outside-link');
	await mkdir(outsidePath, { recursive: true });

	try {
		await symlink(outsidePath, linkPath, process.platform == 'win32' ? 'junction' : 'dir');
	} catch {
		t.skip('symlink creation is not available in this environment');
		return;
	}

	await assert.rejects(
		AssertExistingDirectoryInRoot(linkPath, videoPath, 'directory'),
		/outside the configured media roots/
	);
});

test('aborts recursive directory listing at the configured cap', async () => {
	const { GetDirectoryItems } = await import('./files');
	const cappedPath = path.join(videoPath, 'capped');
	await mkdir(cappedPath, { recursive: true });
	await writeFile(path.join(cappedPath, 'one.mkv'), '');
	await writeFile(path.join(cappedPath, 'two.mkv'), '');
	await writeFile(path.join(cappedPath, 'three.mkv'), '');

	process.env.HANDBRAKE_MAX_DIRECTORY_ITEMS = '2';

	await assert.rejects(GetDirectoryItems(cappedPath, true), /more than 2 items/);
});

test('rejects unsafe watcher regex rules', async () => {
	const { AssertSafeWatcherRegex } = await import('./watcher');

	assert.doesNotThrow(() => AssertSafeWatcherRegex('/^movie-\\d+$/i'));
	assert.throws(() => AssertSafeWatcherRegex('/(a+)+$/'), /not safe/);
	assert.throws(() => AssertSafeWatcherRegex(`/${'a'.repeat(300)}/`), /longer than/);
});

test('waits for watched file size and modification time to become stable', async () => {
	const { WaitForFileReady } = await import('./watcher');
	const watchedFile = path.join(videoPath, 'stability-test.mkv');
	await writeFile(watchedFile, 'aaaa');

	const startedAt = Date.now();
	const readiness = WaitForFileReady(watchedFile, {
		stabilityMs: 40,
		pollIntervalMs: 5,
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	await writeFile(watchedFile, 'bbbb');
	const updatedTime = new Date(Date.now() + 1000);
	await utimes(watchedFile, updatedTime, updatedTime);

	assert.equal(await readiness, true);
	assert.ok(Date.now() - startedAt >= 50);
});

test('cancels watched file readiness when aborted or deleted', async () => {
	const { WaitForFileReady } = await import('./watcher');
	const abortedFile = path.join(videoPath, 'aborted-stability-test.mkv');
	const deletedFile = path.join(videoPath, 'deleted-stability-test.mkv');
	await writeFile(abortedFile, 'video');
	await writeFile(deletedFile, 'video');

	const abortController = new AbortController();
	const abortedReadiness = WaitForFileReady(abortedFile, {
		stabilityMs: 100,
		pollIntervalMs: 5,
		signal: abortController.signal,
	});
	abortController.abort();
	assert.equal(await abortedReadiness, false);

	const deletedReadiness = WaitForFileReady(deletedFile, {
		stabilityMs: 100,
		pollIntervalMs: 5,
	});
	await rm(deletedFile);
	assert.equal(await deletedReadiness, false);
});

test('falls back to a sixty-second watcher quiet period for invalid configuration', async () => {
	const { GetWatcherStabilityMs } = await import('./watcher');

	assert.equal(GetWatcherStabilityMs(undefined), 60_000);
	assert.equal(GetWatcherStabilityMs('not-a-number'), 60_000);
	assert.equal(GetWatcherStabilityMs('12.5'), 12_500);
});

test('validates worker resource usage before relaying it to clients', async () => {
	const { NormalizeWorkerResourceUsage } = await import('./properties');

	assert.equal(NormalizeWorkerResourceUsage({ cpu_percent: 101 }), undefined);
	assert.equal(NormalizeWorkerResourceUsage({ memory_used_bytes: -1 }), undefined);
	const usage = NormalizeWorkerResourceUsage({
		cpu_percent: 25.5,
		memory_used_bytes: 1024,
		memory_limit_bytes: null,
	});
	assert.equal(usage?.cpu_percent, 25.5);
	assert.equal(usage?.memory_used_bytes, 1024);
	assert.equal(usage?.memory_limit_bytes, null);
	assert.equal(typeof usage?.sampled_at, 'number');
});

test('excludes workers that are not accepting jobs', async () => {
	const { WorkerAcceptsJobs } = await import('./queue');

	assert.equal(WorkerAcceptsJobs({ data: { acceptsJobs: true } } as never), true);
	assert.equal(WorkerAcceptsJobs({ data: { acceptsJobs: false } } as never), false);
	assert.equal(WorkerAcceptsJobs({ data: {} } as never), true);
});
