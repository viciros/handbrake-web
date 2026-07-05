import { FileBrowserMode } from '@handbrake-web/shared/types/file-browser';
import { HTMLAttributes, useContext } from 'react';
import PathInput from '~components/base/inputs/path';
import Section from '~components/root/section';
import { SettingsContext } from '~pages/settings/context';
import styles from './styles.module.scss';

export default function SettingsPaths({}: HTMLAttributes<HTMLElement>) {
	const { currentConfig, setCurrentConfig, setPathsValid } = useContext(SettingsContext)!;

	const updatePathProperty = <K extends keyof typeof currentConfig.paths>(
		key: K,
		value: (typeof currentConfig.paths)[K]
	) => {
		setCurrentConfig({ ...currentConfig, paths: { ...currentConfig.paths, [key]: value } });
		setPathsValid(true);
	};

	return (
		<Section heading='Locations' className={styles['paths-section']}>
			<PathInput
				id='input-path-selection'
				label='Default Input Path'
				startPath='/'
				rootPath='/'
				mode={FileBrowserMode.Directory}
				allowCreate={true}
				value={currentConfig.paths['input-path']}
				onConfirm={(item) => {
					updatePathProperty('input-path', item.path);
				}}
			/>

			<PathInput
				id='output-path-selection'
				label='Default Output Path (optional)'
				startPath='/'
				rootPath='/'
				mode={FileBrowserMode.Directory}
				allowClear={true}
				allowCreate={true}
				value={currentConfig.paths['output-path']}
				setValue={(value) => updatePathProperty('output-path', value)}
				onConfirm={(item) => {
					updatePathProperty('output-path', item.path);
				}}
			/>
		</Section>
	);
}
