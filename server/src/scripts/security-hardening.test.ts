import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
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
		CreateWorkerAuthToken,
		RevokeWorkerAuthToken,
		RotateWorkerAuthToken,
		SetWorkerAuthTokenEnabled,
		VerifySecretHash,
	} = await import('./auth');
	const { DatabaseGetWorkerAuthToken } = await import('./database/database-worker-auth');
	const workerID = 'worker-token-test';

	const created = await CreateWorkerAuthToken(workerID);
	assert.equal(created.ok, true);
	assert.ok(created.token);

	const storedCreatedToken = await DatabaseGetWorkerAuthToken(workerID);
	assert.ok(storedCreatedToken);
	assert.equal(storedCreatedToken.is_enabled, true);
	assert.notEqual(storedCreatedToken.token_hash, created.token);
	assert.equal(storedCreatedToken.token_hash.includes(created.token), false);
	assert.equal(await VerifySecretHash(created.token, storedCreatedToken.token_hash), true);
	assert.equal(await VerifySecretHash('wrong token', storedCreatedToken.token_hash), false);

	const disabled = await SetWorkerAuthTokenEnabled(workerID, false);
	assert.equal(disabled.ok, true);
	const storedDisabledToken = await DatabaseGetWorkerAuthToken(workerID);
	assert.ok(storedDisabledToken);
	assert.equal(storedDisabledToken.is_enabled, false);

	const enabled = await SetWorkerAuthTokenEnabled(workerID, true);
	assert.equal(enabled.ok, true);
	const storedEnabledToken = await DatabaseGetWorkerAuthToken(workerID);
	assert.ok(storedEnabledToken);
	assert.equal(storedEnabledToken.is_enabled, true);

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
