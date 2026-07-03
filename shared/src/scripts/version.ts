import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cwd, env } from 'node:process';

export function GetApplicationVersion(): string {
	if (env.HANDBRAKE_WEB_VERSION) return env.HANDBRAKE_WEB_VERSION;

	return JSON.parse(readFileSync(resolve(cwd(), 'package.json'), { encoding: 'utf-8' })).version;
}
