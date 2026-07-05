import { strict as assert } from 'node:assert';
import test from 'node:test';

import { GetServerBaseAddress } from './worker-startup';

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
