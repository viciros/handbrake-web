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
});

test('rejects placeholder admin credentials', async () => {
	const { GenerateWorkerAuthKeyPair } = await import(
		'@handbrake-web/shared/scripts/worker-auth'
	);
	const { ValidateAuthConfig } = await import('./auth');
	const serverKeys = GenerateWorkerAuthKeyPair();
	const workerKeys = GenerateWorkerAuthKeyPair();

	process.env.HANDBRAKE_WEB_USERNAME = 'admin';
	process.env.HANDBRAKE_WEB_PASSWORD = 'change-this-password';
	process.env.local_private_key = serverKeys.privateKey;
	process.env.remote_public_key = workerKeys.publicKey;

	assert.throws(() => ValidateAuthConfig(), /placeholder/);
});

test('validates signed client auth session tokens', async () => {
	const { CreateClientAuthSessionToken, IsClientAuthSessionTokenValid } = await import('./auth');

	process.env.HANDBRAKE_WEB_USERNAME = 'web-user';
	process.env.HANDBRAKE_WEB_PASSWORD = 'web-password';

	const token = CreateClientAuthSessionToken('web-user');
	const tamperedToken = `${token.slice(0, -1)}x`;
	const wrongUserToken = CreateClientAuthSessionToken('other-user');

	assert.equal(IsClientAuthSessionTokenValid(token), true);
	assert.equal(IsClientAuthSessionTokenValid(tamperedToken), false);
	assert.equal(IsClientAuthSessionTokenValid(wrongUserToken), false);
});

test('validates worker IDs', async () => {
	const { IsValidWorkerID } = await import('./auth');

	assert.equal(IsValidWorkerID('worker-01.main'), true);
	assert.equal(IsValidWorkerID('worker 01'), false);
	assert.equal(IsValidWorkerID('../worker'), false);
	assert.equal(IsValidWorkerID('x'.repeat(65)), false);
});

test('accepts independent configured input and output paths', async () => {
	const { ValidateConfig } = await import('./config/config');
	const inputPath = path.join(testRoot, 'downloads');
	const outputPath = path.join(testRoot, 'encoded');

	assert.doesNotThrow(() =>
		ValidateConfig({
			config: {
				version: 2,
			},
			paths: {
				'media-path': '/',
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
