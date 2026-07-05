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
import type {
	ClientAuthStatusType,
	UpdateClientCredentialsResultType,
	UpdateClientCredentialsType,
} from '@handbrake-web/shared/types/auth';
import type { ClientAuthType } from '@handbrake-web/shared/types/database';
import type { Express, NextFunction, Request, Response } from 'express';
import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { ExtendedError, Socket } from 'socket.io';

import logger from 'logging';
import {
	DatabaseGetClientAuth,
	DatabaseInsertClientAuth,
	DatabaseUpdateClientAuth,
} from 'scripts/database/database-auth';

type Credentials = {
	username: string;
	password: string;
};

type ClientAuthSession = {
	username: string;
	credentialsUpdatedAt: number;
	expiresAt: number;
	nonce: string;
};

const workerAuthEnv = {
	localPrivateKey: 'local_private_key',
	remotePublicKey: 'remote_public_key',
};
const defaultClientAuthUsername = 'admin';
const clientAuthSessionCookieName = 'handbrake-web-client-auth';
const clientAuthSessionLifetimeMs = 12 * 60 * 60 * 1000;
const clientAuthSessionSecret = randomBytes(32);
const workerChallengeLifetimeMs = 60_000;
const maxPendingWorkerAuthChallenges = 1000;
const workerIDRegex = /^[A-Za-z0-9._-]{1,64}$/;
const usernameMaxLength = 64;
const passwordMinLength = 12;
const passwordMaxLength = 1024;

const scryptCost = 16_384;
const scryptBlockSize = 8;
const scryptParallelization = 1;
const scryptKeyLength = 64;

const workerAuthChallenges = new Map<string, WorkerAuthChallenge>();
let clientAuthCredentials: ClientAuthType | undefined;

type RateLimitRecord = {
	count: number;
	expiresAt: number;
};

type ParsedPasswordHash = {
	cost: number;
	blockSize: number;
	parallelization: number;
	keyLength: number;
	salt: string;
	hash: string;
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

const getLoadedClientAuthCredentials = () => clientAuthCredentials;

const requireLoadedClientAuthCredentials = () => {
	const credentials = getLoadedClientAuthCredentials();
	if (!credentials) {
		throw new Error('Client auth credentials have not been initialized.');
	}

	return credentials;
};

const toClientAuthStatus = (credentials = requireLoadedClientAuthCredentials()) => ({
	username: credentials.username,
	must_change_credentials: Boolean(credentials.must_change_credentials),
});

const deriveScryptKey = (
	password: string,
	salt: string,
	keyLength: number,
	cost: number,
	blockSize: number,
	parallelization: number
) =>
	new Promise<Buffer>((resolve, reject) => {
		scrypt(
			password,
			salt,
			keyLength,
			{ N: cost, r: blockSize, p: parallelization },
			(err, derivedKey) => {
				if (err) {
					reject(err);
					return;
				}

				resolve(derivedKey);
			}
		);
	});

const parsePasswordHash = (storedHash: string): ParsedPasswordHash | undefined => {
	const parts = storedHash.split('$');
	if (parts.length != 7) return undefined;

	const [algorithm, cost, blockSize, parallelization, keyLength, salt, hash] = parts;
	if (algorithm != 'scrypt' || !salt || !hash) return undefined;

	const numericParts = [cost, blockSize, parallelization, keyLength].map((value) =>
		Number(value)
	);
	if (
		numericParts.some(
			(value) => !Number.isSafeInteger(value) || value <= 0 || value > 1_000_000
		)
	) {
		return undefined;
	}

	return {
		cost: numericParts[0],
		blockSize: numericParts[1],
		parallelization: numericParts[2],
		keyLength: numericParts[3],
		salt,
		hash,
	};
};

export async function HashClientPassword(password: string) {
	const salt = randomBytes(16).toString('base64url');
	const hash = await deriveScryptKey(
		password,
		salt,
		scryptKeyLength,
		scryptCost,
		scryptBlockSize,
		scryptParallelization
	);

	return [
		'scrypt',
		scryptCost,
		scryptBlockSize,
		scryptParallelization,
		scryptKeyLength,
		salt,
		hash.toString('base64url'),
	].join('$');
}

export async function VerifyClientPasswordHash(password: string, storedHash: string) {
	const parsedHash = parsePasswordHash(storedHash);
	if (!parsedHash) return false;

	const expectedHash = Buffer.from(parsedHash.hash, 'base64url');
	const candidateHash = await deriveScryptKey(
		password,
		parsedHash.salt,
		parsedHash.keyLength,
		parsedHash.cost,
		parsedHash.blockSize,
		parsedHash.parallelization
	);

	return (
		expectedHash.length == candidateHash.length && timingSafeEqual(expectedHash, candidateHash)
	);
}

const generateClientAuthPassword = () => randomBytes(24).toString('base64url');

const logGeneratedClientAuthCredentials = (password: string) => {
	logger.warn('[auth] Created initial web UI credentials.');
	logger.warn(`[auth] Username: ${defaultClientAuthUsername}`);
	logger.warn(`[auth] Password: ${password}`);
	logger.warn('[auth] Change the password in the web UI after signing in.');
};

const validateNewClientCredentials = (
	username: string,
	password: string
) => {
	if (!username) return 'Username is required.';
	if (username.length > usernameMaxLength) {
		return `Username must be ${usernameMaxLength} characters or fewer.`;
	}
	if (username.includes(':')) return 'Username cannot contain a colon.';
	if (/[\u0000-\u001f\u007f]/.test(username)) {
		return 'Username cannot contain control characters.';
	}
	if (password.length < passwordMinLength) {
		return `Password must be at least ${passwordMinLength} characters.`;
	}
	if (password.length > passwordMaxLength) {
		return `Password must be ${passwordMaxLength} characters or fewer.`;
	}
	if (password == username || password == 'change-this-password') {
		return 'Password must not match a placeholder value.';
	}
};

const authenticateUser = async (credentials: Credentials | undefined) => {
	const expected = getLoadedClientAuthCredentials();
	if (!expected || !credentials) return false;

	return (
		safeEqual(credentials.username, expected.username) &&
		(await VerifyClientPasswordHash(credentials.password, expected.password_hash))
	);
};

const signClientAuthSessionPayload = (payload: string) =>
	createHmac('sha256', clientAuthSessionSecret).update(payload).digest('base64url');

export function CreateClientAuthSessionToken(
	username: string,
	credentialsUpdatedAt = requireLoadedClientAuthCredentials().updated_at
) {
	const session: ClientAuthSession = {
		username,
		credentialsUpdatedAt,
		expiresAt: Date.now() + clientAuthSessionLifetimeMs,
		nonce: randomBytes(16).toString('base64url'),
	};
	const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
	const signature = signClientAuthSessionPayload(payload);

	return `${payload}.${signature}`;
}

export function IsClientAuthSessionTokenValid(
	token: string | undefined,
	expectedCredentials = getLoadedClientAuthCredentials()
) {
	if (!token || !expectedCredentials) return false;

	const parts = token.split('.');
	if (parts.length != 2 || !parts[0] || !parts[1]) return false;

	const [payload, signature] = parts;
	const expectedSignature = signClientAuthSessionPayload(payload);
	if (!safeEqual(signature, expectedSignature)) return false;

	try {
		const session = JSON.parse(
			Buffer.from(payload, 'base64url').toString('utf-8')
		) as Partial<ClientAuthSession>;

		return (
			session.username == expectedCredentials.username &&
			session.credentialsUpdatedAt == expectedCredentials.updated_at &&
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

export function GetClientAuthStatus(): ClientAuthStatusType {
	return toClientAuthStatus();
}

export async function InitializeClientAuth() {
	const existingCredentials = await DatabaseGetClientAuth();
	if (existingCredentials) {
		clientAuthCredentials = existingCredentials;
		return { status: GetClientAuthStatus() };
	}

	const now = Date.now();
	const generatedPassword = generateClientAuthPassword();
	const credentials = await DatabaseInsertClientAuth({
		username: defaultClientAuthUsername,
		password_hash: await HashClientPassword(generatedPassword),
		must_change_credentials: true,
		created_at: now,
		updated_at: now,
	});
	if (!credentials) {
		throw new Error('Could not create client auth credentials.');
	}

	clientAuthCredentials = credentials;
	logGeneratedClientAuthCredentials(generatedPassword);

	return { generatedPassword, status: GetClientAuthStatus() };
}

export async function UpdateClientAuthCredentials(
	data: UpdateClientCredentialsType
): Promise<UpdateClientCredentialsResultType> {
	const currentCredentials = requireLoadedClientAuthCredentials();
	const currentPassword = String(data.current_password ?? '');
	const username = String(data.username ?? '').trim();
	const newPassword = String(data.new_password ?? '');

	if (
		!(await VerifyClientPasswordHash(currentPassword, currentCredentials.password_hash))
	) {
		return { ok: false, message: 'Current password is incorrect.' };
	}

	const validationError = validateNewClientCredentials(username, newPassword);
	if (validationError) {
		return { ok: false, message: validationError };
	}

	const now = Date.now();
	const updatedCredentials = await DatabaseUpdateClientAuth({
		username,
		password_hash: await HashClientPassword(newPassword),
		must_change_credentials: false,
		updated_at: now,
	});
	if (!updatedCredentials) {
		return { ok: false, message: 'Could not update credentials.' };
	}

	clientAuthCredentials = updatedCredentials;

	return {
		ok: true,
		message: 'Credentials updated.',
		status: GetClientAuthStatus(),
		requires_reauth: true,
	};
}

export function IsValidWorkerID(workerID: string) {
	return workerIDRegex.test(workerID);
}

export function ValidateAuthConfig() {
	const workerKeys = getWorkerAuthKeys();
	if (!workerKeys) {
		LogGeneratedWorkerAuthKeys();
		process.exit(1);
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

export async function RequireHttpAuth(req: Request, res: Response, next: NextFunction) {
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
	if (credentials && (await authenticateUser(credentials))) {
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
	void (async () => {
		const rateLimitKey = getSocketRateLimitKey(socket);
		if (clientSocketAuthFailures.isLimited(rateLimitKey)) {
			logger.warn(`[socket] Rate limited unauthenticated client connection '${socket.id}'.`);
			next(new Error('rate limited'));
			return;
		}

		const auth = socket.handshake.auth as Partial<Credentials> | undefined;
		const isAuthenticated =
			IsClientAuthSessionTokenValid(
				getClientAuthSessionCookie(socket.request.headers.cookie)
			) ||
			(await authenticateUser({
				username: String(auth?.username ?? ''),
				password: String(auth?.password ?? ''),
			}));

		if (isAuthenticated) {
			clientSocketAuthFailures.reset(rateLimitKey);
			next();
			return;
		}

		clientSocketAuthFailures.recordFailure(rateLimitKey);
		logger.warn(`[socket] Rejected unauthenticated client connection '${socket.id}'.`);
		next(new Error('unauthorized'));
	})().catch((err) => {
		logger.error(`[socket] [error] Could not authenticate client '${socket.id}'.`);
		logger.error(err);
		next(new Error('unauthorized'));
	});
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
