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
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ExtendedError, Socket } from 'socket.io';

import logger from 'logging';

type Credentials = {
	username: string;
	password: string;
};

type ClientAuthSession = {
	username: string;
	expiresAt: number;
	nonce: string;
};

const userAuthEnv = {
	username: 'HANDBRAKE_WEB_USERNAME',
	password: 'HANDBRAKE_WEB_PASSWORD',
};
const workerAuthEnv = {
	localPrivateKey: 'local_private_key',
	remotePublicKey: 'remote_public_key',
};
const clientAuthSessionCookieName = 'handbrake-web-client-auth';
const clientAuthSessionLifetimeMs = 12 * 60 * 60 * 1000;
const clientAuthSessionSecret = randomBytes(32);
const workerChallengeLifetimeMs = 60_000;
const maxPendingWorkerAuthChallenges = 1000;
const workerIDRegex = /^[A-Za-z0-9._-]{1,64}$/;

const workerAuthChallenges = new Map<string, WorkerAuthChallenge>();

type RateLimitRecord = {
	count: number;
	expiresAt: number;
};

const createRateLimiter = (maxAttempts: number, windowMs: number) => {
	const records = new Map<string, RateLimitRecord>();

	const cleanup = () => {
		const now = Date.now();
		for (const [key, record] of records.entries()) {
			if (record.expiresAt <= now) {
				records.delete(key);
			}
		}
	};

	const limiter = {
		isLimited(key: string) {
			cleanup();
			const record = records.get(key);
			return record != undefined && record.count >= maxAttempts;
		},
		recordFailure(key: string) {
			cleanup();
			const now = Date.now();
			const record = records.get(key);
			if (!record || record.expiresAt <= now) {
				records.set(key, { count: 1, expiresAt: now + windowMs });
				return;
			}

			record.count += 1;
		},
		recordAttempt(key: string) {
			limiter.recordFailure(key);
		},
		reset(key: string) {
			records.delete(key);
		},
	};
	return limiter;
};

const httpAuthFailures = createRateLimiter(30, 5 * 60 * 1000);
const clientSocketAuthFailures = createRateLimiter(20, 5 * 60 * 1000);
const workerChallengeAttempts = createRateLimiter(120, 60 * 1000);

const getRequestRateLimitKey = (req: Request) => req.socket.remoteAddress || req.ip || 'unknown';
const getSocketRateLimitKey = (socket: Socket) =>
	socket.handshake.address || socket.conn.remoteAddress || 'unknown';

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

const parseCookieHeader = (header: string | undefined) => {
	const cookies = new Map<string, string>();
	if (!header) return cookies;

	for (const cookie of header.split(';')) {
		const separatorIndex = cookie.indexOf('=');
		if (separatorIndex < 0) continue;

		const name = cookie.slice(0, separatorIndex).trim();
		const value = cookie.slice(separatorIndex + 1).trim();
		if (name) {
			cookies.set(name, value);
		}
	}

	return cookies;
};

const authenticateUser = (credentials: Credentials | undefined) => {
	const expected = getServerCredentials();
	if (!expected || !credentials) return false;

	return (
		safeEqual(credentials.username, expected.username) &&
		safeEqual(credentials.password, expected.password)
	);
};

const isPlaceholderCredentials = (credentials: Credentials) =>
	credentials.password == 'change-this-password' ||
	credentials.password == credentials.username ||
	(credentials.username == 'admin' && credentials.password == 'admin');

const signClientAuthSessionPayload = (payload: string) =>
	createHmac('sha256', clientAuthSessionSecret).update(payload).digest('base64url');

export function CreateClientAuthSessionToken(username: string) {
	const session: ClientAuthSession = {
		username,
		expiresAt: Date.now() + clientAuthSessionLifetimeMs,
		nonce: randomBytes(16).toString('base64url'),
	};
	const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
	const signature = signClientAuthSessionPayload(payload);

	return `${payload}.${signature}`;
}

export function IsClientAuthSessionTokenValid(token: string | undefined) {
	if (!token) return false;

	const parts = token.split('.');
	if (parts.length != 2 || !parts[0] || !parts[1]) return false;

	const [payload, signature] = parts;
	const expectedSignature = signClientAuthSessionPayload(payload);
	if (!safeEqual(signature, expectedSignature)) return false;

	try {
		const session = JSON.parse(
			Buffer.from(payload, 'base64url').toString('utf-8')
		) as Partial<ClientAuthSession>;
		const expectedCredentials = getServerCredentials();

		return (
			!!expectedCredentials &&
			session.username == expectedCredentials.username &&
			typeof session.expiresAt == 'number' &&
			Number.isSafeInteger(session.expiresAt) &&
			session.expiresAt > Date.now() &&
			typeof session.nonce == 'string' &&
			session.nonce.length > 0
		);
	} catch {
		return false;
	}
}

const getClientAuthSessionCookie = (cookieHeader: string | undefined) =>
	parseCookieHeader(cookieHeader).get(clientAuthSessionCookieName);

const isSecureRequest = (req: Request) =>
	req.secure ||
	String(req.header('x-forwarded-proto') || '')
		.split(',')
		.map((value) => value.trim().toLowerCase())
		.includes('https');

const setClientAuthSessionCookie = (req: Request, res: Response, credentials: Credentials) => {
	res.cookie(clientAuthSessionCookieName, CreateClientAuthSessionToken(credentials.username), {
		httpOnly: true,
		maxAge: clientAuthSessionLifetimeMs,
		path: '/',
		sameSite: 'lax',
		secure: isSecureRequest(req),
	});
};

export function IsValidWorkerID(workerID: string) {
	return workerIDRegex.test(workerID);
}

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
	if (isPlaceholderCredentials(credentials)) {
		throw new Error(
			`${userAuthEnv.username}/${userAuthEnv.password} must not use placeholder or matching values.`
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
		const rateLimitKey = getRequestRateLimitKey(req);
		if (workerChallengeAttempts.isLimited(rateLimitKey)) {
			res.status(429).send('Too many worker auth challenge requests.');
			return;
		}
		workerChallengeAttempts.recordAttempt(rateLimitKey);

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
		if (!IsValidWorkerID(workerID)) {
			res.status(400).send('Invalid workerID.');
			return;
		}
		if (workerAuthChallenges.size >= maxPendingWorkerAuthChallenges) {
			res.status(503).send('Too many pending worker auth challenges.');
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
	const rateLimitKey = getRequestRateLimitKey(req);
	if (httpAuthFailures.isLimited(rateLimitKey)) {
		res.status(429).send('Too many authentication attempts.');
		return;
	}

	if (IsClientAuthSessionTokenValid(getClientAuthSessionCookie(req.header('cookie')))) {
		httpAuthFailures.reset(rateLimitKey);
		next();
		return;
	}

	const credentials = parseBasicAuth(req.header('authorization'));
	if (credentials && authenticateUser(credentials)) {
		httpAuthFailures.reset(rateLimitKey);
		setClientAuthSessionCookie(req, res, credentials);
		next();
		return;
	}

	httpAuthFailures.recordFailure(rateLimitKey);
	res.setHeader('WWW-Authenticate', 'Basic realm="HandBrake Web"');
	res.status(401).send('Authentication required.');
}

export function AuthenticateClientSocket(socket: Socket, next: (err?: ExtendedError) => void) {
	const rateLimitKey = getSocketRateLimitKey(socket);
	if (clientSocketAuthFailures.isLimited(rateLimitKey)) {
		logger.warn(`[socket] Rate limited unauthenticated client connection '${socket.id}'.`);
		next(new Error('rate limited'));
		return;
	}

	const auth = socket.handshake.auth as Partial<Credentials> | undefined;

	if (
		IsClientAuthSessionTokenValid(
			getClientAuthSessionCookie(socket.request.headers.cookie)
		) ||
		authenticateUser({
			username: String(auth?.username ?? ''),
			password: String(auth?.password ?? ''),
		})
	) {
		clientSocketAuthFailures.reset(rateLimitKey);
		next();
		return;
	}

	clientSocketAuthFailures.recordFailure(rateLimitKey);
	logger.warn(`[socket] Rejected unauthenticated client connection '${socket.id}'.`);
	next(new Error('unauthorized'));
}

export function AuthenticateWorkerSocket(socket: Socket, next: (err?: ExtendedError) => void) {
	const workerID = socket.handshake.query['workerID'];
	const auth = socket.handshake.auth as
		| { challengeID?: unknown; workerSignature?: unknown }
		| undefined;
	const workerKeys = getWorkerAuthKeys();

	if (typeof workerID != 'string' || !IsValidWorkerID(workerID) || !workerKeys) {
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
