import {
	QueueStartupBehavior,
	type ConfigType,
	type UnknownConfigType,
} from '@handbrake-web/shared/types/config';
import fs from 'fs';
import { readFile, writeFile } from 'fs/promises';
import logger from 'logging';
import path from 'path';
import { getDataPath } from 'scripts/data';
import { parse, stringify } from 'yaml';
import { EmitToAllClients } from '../connections';
import { RunMigrations } from './utilities/migrator';

// Defines the latest config schema and default values
const defaultConfig: ConfigType = {
	config: {
		version: 2,
	},
	paths: {
		'media-path': '/',
		'input-path': '/',
		'output-path': '',
	},
	presets: {
		'show-default-presets': true,
		'allow-preset-creator': false,
	},
	application: {
		'queue-startup-behavior': QueueStartupBehavior.Previous,
		'update-check-interval': 12,
	},
};

export const configFilePath = path.join(getDataPath(), 'config.yaml');

// Initialize configuration with defaults
let config = JSON.parse(JSON.stringify(defaultConfig)) as ConfigType;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value == 'object' && value != null && !Array.isArray(value);

const isQueueStartupBehavior = (value: unknown): value is QueueStartupBehavior =>
	typeof value == 'number' &&
	Object.values(QueueStartupBehavior)
		.filter((entry) => typeof entry == 'number')
		.includes(value);

const validateConfigPath = (value: string, label: string, allowEmpty = false) => {
	if (allowEmpty && value.length == 0) return;
	if (value.length == 0) {
		throw new Error(`${label} must not be empty.`);
	}
	if (!path.isAbsolute(value)) {
		throw new Error(`${label} must be an absolute path.`);
	}
};

export function ValidateConfig(value: UnknownConfigType): ConfigType {
	if (!isRecord(value.config) || typeof value.config.version != 'number') {
		throw new Error("Config section 'config.version' must be a number.");
	}
	if (
		!isRecord(value.paths) ||
		typeof value.paths['media-path'] != 'string' ||
		typeof value.paths['input-path'] != 'string' ||
		typeof value.paths['output-path'] != 'string'
	) {
		throw new Error("Config section 'paths' is invalid.");
	}
	validateConfigPath(value.paths['media-path'], "Config path 'media-path'");
	validateConfigPath(value.paths['input-path'], "Config path 'input-path'");
	validateConfigPath(value.paths['output-path'], "Config path 'output-path'", true);
	if (
		!isRecord(value.presets) ||
		typeof value.presets['show-default-presets'] != 'boolean' ||
		typeof value.presets['allow-preset-creator'] != 'boolean'
	) {
		throw new Error("Config section 'presets' is invalid.");
	}
	if (
		!isRecord(value.application) ||
		!isQueueStartupBehavior(value.application['queue-startup-behavior']) ||
		typeof value.application['update-check-interval'] != 'number' ||
		!Number.isFinite(value.application['update-check-interval']) ||
		value.application['update-check-interval'] < 0
	) {
		throw new Error("Config section 'application' is invalid.");
	}

	return value as ConfigType;
}

async function InitializeConfig() {
	const configData = stringify(defaultConfig);

	try {
		await writeFile(configFilePath, configData, { encoding: 'utf-8' });
		logger.info(
			`[server] [config] Created the config file at '${configFilePath}' with recommended defaults.`
		);
	} catch (err) {
		logger.error(`[config] Could not create the config file at '${configFilePath}'.`);
		throw err;
	}
}

export async function ReadConfigFile() {
	return parse(await readFile(configFilePath, { encoding: 'utf-8' })) as UnknownConfigType;
}

export async function WriteConfigFile(config: UnknownConfigType) {
	await writeFile(configFilePath, stringify(config), { encoding: 'utf-8' });
}

export async function LoadConfig() {
	try {
		if (!fs.existsSync(configFilePath)) {
			await InitializeConfig();
		} else {
			await RunMigrations(defaultConfig.config.version);
		}

		const configFile = ValidateConfig(await ReadConfigFile());
		config = configFile;

		EmitToAllClients('config-update', config);
		logger.info(`[server] [config] The config file at '${configFilePath}' has been loaded.`);
	} catch (error) {
		logger.error(
			`[server] [config] [error] Could not load the config file from '${configFilePath}'. The application will now shut down.`
		);
		logger.error(error);
		throw error;
	}
}

export async function WriteConfig(newConfig: ConfigType) {
	try {
		const validatedConfig = ValidateConfig(newConfig);
		const fileData = stringify(validatedConfig);
		await writeFile(configFilePath, fileData);

		config = validatedConfig;

		EmitToAllClients('config-update', validatedConfig);
		logger.info(`[server] [config] The config file at '${configFilePath}' has been written.`);
	} catch (error) {
		logger.error(`[server] [config] [error] Could not write new config to file.`);
		logger.error(error);
		throw error;
	}
}

export function GetConfig() {
	return config;
}
