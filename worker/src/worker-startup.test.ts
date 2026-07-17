import { strict as assert } from 'node:assert';
import test from 'node:test';

import { GetServerBaseAddress } from './worker-startup';
import { ConnectionRetryController, GetConnectionRetryDelayMs } from './connection-retry';

test('requires a full worker server URL', () => {
	assert.throws(
		() => GetServerBaseAddress('handbrake-server:9999'),
		/SERVER_URL must include/
	);
});

test('requires HTTPS for public worker server URLs', () => {
	assert.throws(
		() => GetServerBaseAddress('http://example.com'),
		/public hosts/
	);
	assert.throws(
		() => GetServerBaseAddress('http://example.com:9999'),
		/public hosts/
	);
	assert.equal(
		GetServerBaseAddress('https://example.com'),
		'https://example.com'
	);
	assert.equal(
		GetServerBaseAddress('https://example.com:8443'),
		'https://example.com:8443'
	);
});

test('rejects HTTPS over port 80 for public worker server URLs', () => {
	assert.throws(
		() => GetServerBaseAddress('https://example.com:80'),
		/port 80/
	);
});

test('allows local and private worker server URLs over HTTP', () => {
	assert.equal(
		GetServerBaseAddress('http://handbrake-server:9999'),
		'http://handbrake-server:9999'
	);
	assert.equal(
		GetServerBaseAddress('http://handbrake-server'),
		'http://handbrake-server'
	);
	assert.equal(
		GetServerBaseAddress('http://handbrake-server:80'),
		'http://handbrake-server'
	);
	assert.equal(
		GetServerBaseAddress('http://192.168.1.50:9999'),
		'http://192.168.1.50:9999'
	);
	assert.equal(
		GetServerBaseAddress('http://media.local:9999'),
		'http://media.local:9999'
	);
});

test('caps connection retry delay at sixty seconds', () => {
	assert.equal(GetConnectionRetryDelayMs(0, 0.5), 1000);
	assert.equal(GetConnectionRetryDelayMs(20, 1), 60_000);
});

test('keeps exactly one connection retry scheduled and resets after connection', () => {
	let connectCalls = 0;
	let scheduledCallback: (() => void) | undefined;
	const scheduledDelays: number[] = [];
	let clearedTimers = 0;
	const fakeTimer = {} as ReturnType<typeof setTimeout>;
	const controller = new ConnectionRetryController(
		() => {
			connectCalls += 1;
		},
		{ info() {}, warn() {} },
		{
			random: () => 0.5,
			setTimeoutFn: (callback, delayMs) => {
				scheduledCallback = callback;
				scheduledDelays.push(delayMs);
				return fakeTimer;
			},
			clearTimeoutFn: () => {
				clearedTimers += 1;
			},
		}
	);

	controller.start();
	assert.equal(connectCalls, 1);
	controller.failed('offline');
	controller.failed('duplicate event');
	assert.equal(scheduledDelays.length, 1);
	assert.equal(controller.hasPendingRetry(), true);
	assert.ok(scheduledCallback);
	scheduledCallback();
	assert.equal(connectCalls, 2);

	controller.failed('offline');
	assert.equal(scheduledDelays.at(-1), 2000);
	controller.connected();
	assert.equal(controller.hasPendingRetry(), false);
	assert.equal(clearedTimers, 1);

	controller.failed('offline');
	assert.equal(scheduledDelays.at(-1), 1000);
	controller.stop();
	assert.equal(controller.hasPendingRetry(), false);
});

test('suppresses repeated connection failure log noise', () => {
	let scheduledCallback: (() => void) | undefined;
	let warningCount = 0;
	const fakeTimer = {} as ReturnType<typeof setTimeout>;
	const controller = new ConnectionRetryController(
		() => {},
		{
			info() {},
			warn() {
				warningCount += 1;
			},
		},
		{
			random: () => 0.5,
			setTimeoutFn: (callback) => {
				scheduledCallback = callback;
				return fakeTimer;
			},
			clearTimeoutFn: () => {},
		}
	);

	controller.start();
	for (let attempt = 0; attempt < 10; attempt += 1) {
		controller.failed('same failure');
		assert.ok(scheduledCallback);
		scheduledCallback();
	}

	assert.equal(warningCount, 2);
	controller.stop();
});
