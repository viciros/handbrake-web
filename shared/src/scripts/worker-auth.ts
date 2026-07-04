import {
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	sign,
	verify,
	type KeyObject,
} from 'node:crypto';

const rawKeyLength = 32;
const ed25519Pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
const ed25519SpkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');

export type WorkerAuthKeyPair = {
	privateKey: string;
	publicKey: string;
};

export type WorkerAuthChallenge = {
	challengeID: string;
	workerID: string;
	nonce: string;
	expiresAt: number;
	serverSignature: string;
};

const getRawKey = (value: string, label: string) => {
	let rawKey: Buffer;

	try {
		rawKey = Buffer.from(value, 'base64url');
	} catch {
		throw new Error(`${label} is not valid base64url.`);
	}

	if (rawKey.length != rawKeyLength) {
		throw new Error(`${label} must decode to ${rawKeyLength} bytes.`);
	}

	return rawKey;
};

const extractRawKey = (derKey: Buffer, prefix: Buffer, label: string) => {
	if (
		derKey.length != prefix.length + rawKeyLength ||
		!derKey.subarray(0, prefix.length).equals(prefix)
	) {
		throw new Error(`Could not extract raw Ed25519 ${label}.`);
	}

	return derKey.subarray(prefix.length).toString('base64url');
};

export function GenerateWorkerAuthKeyPair(): WorkerAuthKeyPair {
	const { privateKey, publicKey } = generateKeyPairSync('ed25519');
	const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' });
	const publicDer = publicKey.export({ format: 'der', type: 'spki' });

	return {
		privateKey: extractRawKey(privateDer, ed25519Pkcs8Prefix, 'private key'),
		publicKey: extractRawKey(publicDer, ed25519SpkiPrefix, 'public key'),
	};
}

export function CreatePrivateKeyFromRawPrivateKey(privateKey: string): KeyObject {
	return createPrivateKey({
		format: 'der',
		type: 'pkcs8',
		key: Buffer.concat([ed25519Pkcs8Prefix, getRawKey(privateKey, 'local_private_key')]),
	});
}

export function CreatePublicKeyFromRawPublicKey(publicKey: string): KeyObject {
	return createPublicKey({
		format: 'der',
		type: 'spki',
		key: Buffer.concat([ed25519SpkiPrefix, getRawKey(publicKey, 'remote_public_key')]),
	});
}

export const GetServerChallengePayload = (challenge: WorkerAuthChallenge) =>
	`handbrake-web:server-auth:${challenge.challengeID}:${challenge.workerID}:${challenge.nonce}:${challenge.expiresAt}`;

export const GetWorkerChallengePayload = (challenge: WorkerAuthChallenge) =>
	`handbrake-web:worker-auth:${challenge.challengeID}:${challenge.workerID}:${challenge.nonce}:${challenge.expiresAt}`;

export function SignWorkerAuthPayload(payload: string, privateKey: string) {
	return sign(null, Buffer.from(payload), CreatePrivateKeyFromRawPrivateKey(privateKey)).toString(
		'base64url'
	);
}

export function VerifyWorkerAuthPayload(payload: string, signature: string, publicKey: string) {
	let decodedSignature: Buffer;

	try {
		decodedSignature = Buffer.from(signature, 'base64url');
	} catch {
		return false;
	}

	return verify(
		null,
		Buffer.from(payload),
		CreatePublicKeyFromRawPublicKey(publicKey),
		decodedSignature
	);
}
