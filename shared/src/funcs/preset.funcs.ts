import type { HandbrakePresetCategoryType } from '../types/preset';

export const getPresetCount = (presets: HandbrakePresetCategoryType) => {
	return Object.values(presets).reduce((result, category) => {
		return result + Object.keys(category).length;
	}, 0);
};
