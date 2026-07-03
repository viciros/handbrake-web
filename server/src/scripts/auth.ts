import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
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
const workerSecretEnv = 'HANDBRAKE_WORKER_SECRET';

const getServerCredentials = (): Credentials | undefined => {
	const username = process.env[userAuthEnv.username];
	const password = process.env[userAuthEnv.password];

	if (!username || !password) return undefined;

	return { username, password };
};

const getWorkerSecret = () => process.env[workerSecretEnv];

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
	if (!credentials) {
		throw new Error(
			`Missing ${userAuthEnv.username}/${userAuthEnv.password}; server user auth is required.`
		);
	}

	if (!getWorkerSecret()) {
		throw new Error(`Missing ${workerSecretEnv}; worker shared-secret auth is required.`);
	}
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
	const secret = (socket.handshake.auth as { workerSecret?: unknown } | undefined)?.workerSecret;
	const expectedSecret = getWorkerSecret();

	if (
		typeof workerID == 'string' &&
		typeof secret == 'string' &&
		expectedSecret &&
		safeEqual(secret, expectedSecret)
	) {
		next();
		return;
	}

	logger.warn(`[socket] Rejected unauthenticated worker connection '${socket.id}'.`);
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
