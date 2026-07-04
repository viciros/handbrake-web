import { strict as assert } from 'node:assert';
import test from 'node:test';

import { GetServerBaseAddress } from './worker-startup';

test('requires HTTPS for public worker server URLs', () => {
	assert.throws(
		() => GetServerBaseAddress('example.com', '443'),
		/public hosts/
	);
	assert.throws(
		() => GetServerBaseAddress('http://example.com', '9999'),
		/public hosts/
	);
	assert.equal(
		GetServerBaseAddress('https://example.com', '443'),
		'https://example.com'
	);
});

test('allows local and private worker server URLs over HTTP', () => {
	assert.equal(
		GetServerBaseAddress('handbrake-server', '9999'),
		'http://handbrake-server:9999'
	);
	assert.equal(
		GetServerBaseAddress('192.168.1.50', '9999'),
		'http://192.168.1.50:9999'
	);
	assert.equal(
		GetServerBaseAddress('media.local', '9999'),
		'http://media.local:9999'
	);
});
