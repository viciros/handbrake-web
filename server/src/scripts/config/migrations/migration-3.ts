import type { UnknownConfigType } from '@handbrake-web/shared/types/config';
import logger from 'logging';

export default async function Migration3(config: UnknownConfigType): Promise<UnknownConfigType> {
	if (Object.hasOwn(config.paths, 'media-path')) {
		logger.info(`[config] [migration-3] Removing config property 'paths.media-path'.`);
		delete config.paths['media-path'];
	}

	return config;
}
