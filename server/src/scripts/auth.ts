import {
	CreatePrivateKeyFromRawPrivateKey,
	CreatePublicKeyFromRawPublicKey,
	GenerateWorkerAuthKeyPair,
	GetServerChallengePayload,
	GetWorkerChallengePayload,
	SignWorkerAuthPayload,
	VerifyWorkerAuthPayload,
	type WorkerAuthChallenge,
} from '@handbrake-web/shared/scripts/worker-auth';
import type { Express, NextFunction, Request, Response } from 'express';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ExtendedError, Socket } from 'socket.io';

import logger from 'logging';

type Credentials = {
	username: string;
	password: string;
};

const userAuthEnv = {
	username: 'HANDBRAKE_WEB_USERNAME',
	password: 'HANDBRAKE_WEB_PASSWORD',
};
const workerAuthEnv = {
	localPrivateKey: 'local_private_key',
	remotePublicKey: 'remote_public_key',
};
const workerChallengeLifetimeMs = 60_000;

const workerAuthChallenges = new Map<string, WorkerAuthChallenge>();

const getServerCredentials = (): Credentials | undefined => {
	const username = process.env[userAuthEnv.username];
	const password = process.env[userAuthEnv.password];

	if (!username || !password) return undefined;

	return { username, password };
};

const getWorkerAuthKeys = () => {
	const localPrivateKey = process.env[workerAuthEnv.localPrivateKey];
	const remotePublicKey = process.env[workerAuthEnv.remotePublicKey];

	if (!localPrivateKey || !remotePublicKey) return undefined;

	return { localPrivateKey, remotePublicKey };
};

const safeEqual = (left: string, right: string) => {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);

	return (
		leftBuffer.length == rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
	);
};

const parseBasicAuth = (header: string | undefined): Credentials | undefined => {
	if (!header?.startsWith('Basic ')) return undefined;

	try {
		const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf-8');
		const separatorIndex = decoded.indexOf(':');
		if (separatorIndex < 0) return undefined;

		return {
			username: decoded.slice(0, separatorIndex),
			password: decoded.slice(separatorIndex + 1),
		};
	} catch {
		return undefined;
	}
};

const authenticateUser = (credentials: Credentials | undefined) => {
	const expected = getServerCredentials();
	if (!expected || !credentials) return false;

	return (
		safeEqual(credentials.username, expected.username) &&
		safeEqual(credentials.password, expected.password)
	);
};

export function ValidateAuthConfig() {
	const credentials = getServerCredentials();
	const workerKeys = getWorkerAuthKeys();
	if (!workerKeys) {
		LogGeneratedWorkerAuthKeys();
		if (!credentials) {
			logger.error(
				`[auth] Missing ${userAuthEnv.username}/${userAuthEnv.password}; server user auth is required.`
			);
		}
		process.exit(1);
	}

	if (!credentials) {
		throw new Error(
			`Missing ${userAuthEnv.username}/${userAuthEnv.password}; server user auth is required.`
		);
	}

	CreatePrivateKeyFromRawPrivateKey(workerKeys.localPrivateKey);
	CreatePublicKeyFromRawPublicKey(workerKeys.remotePublicKey);
}

function LogGeneratedWorkerAuthKeys() {
	const serverKeyPair = GenerateWorkerAuthKeyPair();
	const workerKeyPair = GenerateWorkerAuthKeyPair();

	logger.error(
		`[auth] Missing ${workerAuthEnv.localPrivateKey}/${workerAuthEnv.remotePublicKey}; worker keypair auth is required.`
	);
	logger.info('[auth] Generated server and worker keypairs. Copy these values into compose and restart.');
	logger.info('[auth] handbrake-server environment:');
	logger.info(`  - ${workerAuthEnv.localPrivateKey}=${serverKeyPair.privateKey}`);
	logger.info(`  - ${workerAuthEnv.remotePublicKey}=${workerKeyPair.publicKey}`);
	logger.info('[auth] handbrake-worker environment:');
	logger.info(`  - ${workerAuthEnv.localPrivateKey}=${workerKeyPair.privateKey}`);
	logger.info(`  - ${workerAuthEnv.remotePublicKey}=${serverKeyPair.publicKey}`);
}

const deleteExpiredWorkerAuthChallenges = () => {
	const now = Date.now();

	for (const [challengeID, challenge] of workerAuthChallenges.entries()) {
		if (challenge.expiresAt <= now) {
			workerAuthChallenges.delete(challengeID);
		}
	}
};

export function RegisterWorkerAuthRoutes(app: Express) {
	app.get('/worker/auth/challenge', (req: Request<{}, {}, {}, { workerID?: string }>, res) => {
		deleteExpiredWorkerAuthChallenges();

		const workerID = req.query.workerID;
		const workerKeys = getWorkerAuthKeys();
		if (!workerKeys) {
			res.status(503).send('Worker auth is not configured.');
			return;
		}

		if (!workerID) {
			res.status(400).send('Missing workerID.');
			return;
		}

		const unsignedChallenge: WorkerAuthChallenge = {
			challengeID: randomUUID(),
			workerID,
			nonce: randomBytes(32).toString('base64url'),
			expiresAt: Date.now() + workerChallengeLifetimeMs,
			serverSignature: '',
		};
		const challenge: WorkerAuthChallenge = {
			...unsignedChallenge,
			serverSignature: SignWorkerAuthPayload(
				GetServerChallengePayload(unsignedChallenge),
				workerKeys.localPrivateKey
			),
		};

		workerAuthChallenges.set(challenge.challengeID, challenge);
		res.json(challenge);
	});
}

export function RequireHttpAuth(req: Request, res: Response, next: NextFunction) {
	if (authenticateUser(parseBasicAuth(req.header('authorization')))) {
		next();
		return;
	}

	res.setHeader('WWW-Authenticate', 'Basic realm="HandBrake Web"');
	res.status(401).send('Authentication required.');
}

export function AuthenticateClientSocket(socket: Socket, next: (err?: ExtendedError) => void) {
	const auth = socket.handshake.auth as Partial<Credentials> | undefined;

	if (
		authenticateUser({
			username: String(auth?.username ?? ''),
			password: String(auth?.password ?? ''),
		})
	) {
		next();
		return;
	}

	logger.warn(`[socket] Rejected unauthenticated client connection '${socket.id}'.`);
	next(new Error('unauthorized'));
}

export function AuthenticateWorkerSocket(socket: Socket, next: (err?: ExtendedError) => void) {
	const workerID = socket.handshake.query['workerID'];
	const auth = socket.handshake.auth as
		| { challengeID?: unknown; workerSignature?: unknown }
		| undefined;
	const workerKeys = getWorkerAuthKeys();

	if (typeof workerID != 'string' || !workerKeys) {
		logger.warn(`[socket] Rejected unauthenticated worker connection '${socket.id}'.`);
		next(new Error('unauthorized'));
		return;
	}

	if (typeof auth?.challengeID != 'string' || typeof auth.workerSignature != 'string') {
		logger.warn(`[socket] Rejected worker '${workerID}' with missing auth challenge.`);
		next(new Error('unauthorized'));
		return;
	}

	const challenge = workerAuthChallenges.get(auth.challengeID);
	workerAuthChallenges.delete(auth.challengeID);

	if (!challenge || challenge.workerID != workerID || challenge.expiresAt <= Date.now()) {
		logger.warn(`[socket] Rejected worker '${workerID}' with invalid auth challenge.`);
		next(new Error('unauthorized'));
		return;
	}

	if (
		VerifyWorkerAuthPayload(
			GetWorkerChallengePayload(challenge),
			auth.workerSignature,
			workerKeys.remotePublicKey
		)
	) {
		next();
		return;
	}

	logger.warn(`[socket] Rejected worker '${workerID}' with invalid auth signature.`);
	next(new Error('unauthorized'));
}

export function IsCorsOriginAllowed(origin: string | undefined) {
	if (!origin) return true;

	const configuredOrigins = (process.env.HANDBRAKE_WEB_CORS_ORIGINS || '')
		.split(',')
		.map((value) => value.trim())
		.filter(Boolean);

	if (configuredOrigins.length > 0) {
		return configuredOrigins.includes(origin);
	}

	if (process.env.NODE_ENV != 'production') {
		return ['http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin);
	}

	return false;
}

export const corsOptions = {
	credentials: true,
	origin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
		callback(null, IsCorsOriginAllowed(origin));
	},
};
