import { FirstLetterUpperCase } from '@handbrake-web/shared/funcs/string.funcs';
import {
	HandbrakePresetCategoryType,
	HandbrakePresetType,
} from '@handbrake-web/shared/types/preset';
import WarningIcon from '@icons/exclamation-circle-fill.svg?react';
import { useState } from 'react';
import { Socket } from 'socket.io-client';
import ButtonInput from '~components/base/inputs/button';
import SelectInput from '~components/base/inputs/select';
import TextInput from '~components/base/inputs/text';
import Overlay from '~components/root/overlay';
import styles from './styles.module.scss';

interface Properties {
	socket: Socket;
	presets: HandbrakePresetCategoryType;
	handleClose: () => void;
}

export default function UploadPreset({ socket, presets, handleClose }: Properties) {
	const [preset, setPreset] = useState<null | HandbrakePresetType>(null);
	const [presetCategory, setPresetCategory] = useState(
		Object.keys(presets).filter((category) => category != 'uncategorized').length > 0
			? Object.keys(presets).filter((category) => category != 'uncategorized')[0]
			: 'new'
	);
	const [newCategory, setNewCategory] = useState('');
	const [presetName, setPresetName] = useState('');
	const [fileError, setFileError] = useState('');

	const getPresetName = (value: unknown) => {
		const candidate = value as Partial<HandbrakePresetType> | null;
		const name = candidate?.PresetList?.[0]?.PresetName;
		return typeof name == 'string' && name.trim() ? name : null;
	};

	const handlePresetFile = (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		setFileError('');

		if (!file) return;
		if (
			file.type &&
			file.type != 'application/json' &&
			!file.name.toLowerCase().endsWith('.json')
		) {
			setPreset(null);
			setPresetName('');
			setFileError('Selected file is not JSON.');
			return;
		}

		const reader = new FileReader();
		reader.onload = (event) => {
			try {
				const result = event.target?.result?.toString();
				const json: HandbrakePresetType = JSON.parse(result || '');
				const name = getPresetName(json);
				if (!name) throw new Error('PresetList[0].PresetName is missing.');

				setPreset(json);
				setPresetName(name);
				console.log(`[client] Preset has been updated to '${name}'`);
			} catch (err) {
				console.error('[client] [error] Could not parse preset file.');
				console.error(err);
				setPreset(null);
				setPresetName('');
				setFileError('Selected file is not a valid HandBrake preset.');
			}
		};
		reader.readAsText(file);
	};

	const handleCategoryChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
		setPresetCategory(event.target.value);
	};

	const handleNewCategoryChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		setNewCategory(event.target.value);
	};

	const handlePresetName = (event: React.ChangeEvent<HTMLInputElement>) => {
		const newName = event.target.value;
		if (!preset) return;

		const newPreset = {
			...preset,
			PresetList: preset.PresetList.map((presetItem, index) =>
				index == 0 ? { ...presetItem, PresetName: newName } : presetItem
			),
		};
		setPreset(newPreset);
		setPresetName(newName);
	};

	const handleAddPreset = (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
		event.preventDefault();
		if (preset && presetName != '') {
			const category = newCategory ? newCategory : presetCategory;
			socket.emit('add-preset', preset, category);
		}
		handleClose();
	};

	return (
		<Overlay className={styles['upload-preset-overlay']}>
			<div className={styles['wrapper']}>
				<h1>Upload Preset</h1>
				<div className={styles['file-section']}>
					<label htmlFor='preset-file'>Preset: </label>
					<input
						className={styles['file-upload']}
						type='file'
						id='preset-file'
						onChange={handlePresetFile}
					/>
					{fileError && <span>{fileError}</span>}
				</div>
				{preset && (
					<div className={styles['fields-section']}>
						<h3>New Preset</h3>
						<SelectInput
							id='category-select'
							label='Category'
							value={presetCategory}
							onChange={handleCategoryChange}
						>
							{Object.keys(presets)
								.filter((category) => category != 'uncategorized')
								.map((category) => (
									<option value={category} key={`preset-category-${category}`}>
										{FirstLetterUpperCase(category)}
									</option>
								))}
							<option value='new'>New Category</option>
						</SelectInput>
						{presetCategory == 'new' && (
							<TextInput
								id='new-category-input'
								label='New Category'
								value={newCategory}
								onChange={handleNewCategoryChange}
							/>
						)}
						<div>
							{presets[presetCategory] &&
								Object.keys(presets[presetCategory]).includes(presetName) && (
									<div className={styles['preset-overwrite']}>
										<WarningIcon />
										<span>
											Preset <strong>'{presetName}'</strong> already exists
											and will be overwriten if the name is not changed.
										</span>
									</div>
								)}
							<TextInput
								id='preset-name'
								label='Preset Name'
								value={presetName}
								onChange={handlePresetName}
							/>
						</div>
					</div>
				)}
				<div className={styles['buttons-section']}>
					<ButtonInput label='Cancel' color='red' onClick={handleClose} />
					<ButtonInput
						label='Upload'
						color='blue'
						disabled={
							preset == null ||
							presetName == '' ||
							(presetCategory == 'new' && !newCategory)
						}
						onClick={handleAddPreset}
					/>
				</div>
			</div>
		</Overlay>
	);
}
