import { PresetFormatDict } from '@handbrake-web/shared/dict/presets.dict';
import { AddJobType } from '@handbrake-web/shared/types/database';
import { DirectoryItemType, DirectoryItemsType } from '@handbrake-web/shared/types/directory';
import { HandbrakeOutputExtensions } from '@handbrake-web/shared/types/file-extensions';
import { useContext, useState } from 'react';
import Overlay from '~components/root/overlay';
import { PrimaryContext } from '~layouts/primary/context';
import { CreateJobContext, CreateJobContextType } from './context';
import {
	CheckNameCollision,
	FilterVideoFiles,
	GetOutputItemFromInputItem,
	GetOutputItemsFromInputItems,
	RequestDirectory,
} from './funcs';
import ButtonsSection from './sections/buttons-section';
import InputSection from './sections/input-section';
import ModeSection from './sections/mode-section';
import OutputSection from './sections/output-section';
import PresetSection from './sections/preset-section';
import ResultSection from './sections/result-section';
import styles from './styles.module.scss';

interface Properties {
	onClose: () => void;
}

export enum JobFrom {
	FromFile,
	FromDirectory,
}

export default function CreateJob({ onClose }: Properties) {
	const { socket, config, presets, defaultPresets } = useContext(PrimaryContext)!;
	const [jobFrom, setJobFrom] = useState(JobFrom.FromFile);

	// Preset ------------------------------------------------------------------
	const [presetCategory, setPresetCategory] = useState('');
	const [preset, setPreset] = useState('');
	const [isDefaultPreset, setIsDefaultPreset] = useState(false);

	// Input -------------------------------------------------------------------
	const [inputPath, setInputPath] = useState('');
	const [inputFiles, setInputFiles] = useState<DirectoryItemsType>([]);
	const [isRecursive, setIsRecursive] = useState(false);

	// Output ------------------------------------------------------------------
	const [outputPath, setOutputPath] = useState('');
	const [outputFiles, setOutputFiles] = useState<DirectoryItemsType>([]);
	const [outputExtension, setOutputExtension] = useState(HandbrakeOutputExtensions.mkv);
	const [nameCollision, setNameCollision] = useState(false);
	const [outputChanged, setOutputChanged] = useState(false);
	const [allowCollision, setAllowCollision] = useState(false);

	// Results -----------------------------------------------------------------
	const [seeMore, setSeeMore] = useState(false);
	const socketAckTimeoutMs = 10000;

	const isDefaultPresetCategory = (category: string) => category.includes('Default: ');
	const getPresetCollection = (category: string) =>
		isDefaultPresetCategory(category)
			? defaultPresets[category.replace(/^Default:\s/, '')]
			: presets[category];
	const getPreset = (category: string, name: string) => getPresetCollection(category)?.[name];
	const getOutputExtensionFromPreset = (category: string, name: string) => {
		const presetFormat = getPreset(category, name)?.PresetList[0].FileFormat;
		return presetFormat ? PresetFormatDict[presetFormat] : HandbrakeOutputExtensions.mkv;
	};
	const selectedPreset = getPreset(presetCategory, preset);

	const canSubmit =
		inputPath != '' &&
		inputFiles.length > 0 &&
		outputPath != '' &&
		outputFiles.length > 0 &&
		outputFiles.length == inputFiles.length &&
		preset != '' &&
		selectedPreset != undefined &&
		((!nameCollision && !allowCollision) || (nameCollision && allowCollision));
	// noExistingCollision;

	const handleJobFromChange = (newJobFrom: JobFrom) => {
		if (jobFrom != newJobFrom) {
			setJobFrom(newJobFrom);
			setInputPath('');
			setInputFiles([]);
			setIsRecursive(false);
			setOutputPath('');
			setOutputFiles([]);
			setNameCollision(false);
		}
	};

	const handleCancel = (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
		event.preventDefault();
		onClose();
	};

	const handleSubmit = async (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
		event.preventDefault();

		// console.log(inputFiles, outputFiles);

		// inputFiles.forEach(async (file, index) => {
		// 	const outputFile = outputFiles[index];
		// 	const newJob: AddJobType = {
		// 		input_path: file.path,
		// 		output_path: outputFile.path,
		// 		preset_category: presetCategory,
		// 		preset_id: preset,
		// 	};
		// 	await socket.emitWithAck('add-job', newJob);
		// 	console.log(`[client] New job sent to the server.\n${newJob}`);
		// });

		if (!selectedPreset) return;

		for (const [index, inputFile] of inputFiles.entries()) {
			const outputFile = outputFiles[index];
			if (!outputFile) {
				console.error(`[client] [error] Missing output file for '${inputFile.path}'.`);
				return;
			}

			const newJob: AddJobType = {
				input_path: inputFile.path,
				output_path: outputFile.path,
				preset_category: presetCategory,
				preset_id: preset,
			};
			try {
				await socket.timeout(socketAckTimeoutMs).emitWithAck('add-job', newJob);
				console.log(
					`[client] New job sent to the server.\n${JSON.stringify(newJob, null, 2)}`
				);
			} catch (err) {
				console.error(`[client] [error] Could not add job for '${inputFile.path}'.`);
				console.error(err);
				return;
			}
		}

		onClose();
	};

	const handleFileInputConfirm = async (item: DirectoryItemType) => {
		setInputPath(item.path);
		setInputFiles([item]);

		const fileName = `${item.name}${item.extension ?? ''}`;
		const parentPath = item.path.endsWith(fileName)
			? item.path.slice(0, -fileName.length).replace(/[\\/]+$/, '')
			: item.path;
		const newOutputPath =
			outputChanged && outputPath ? outputPath : config.paths['output-path'] || parentPath;
		const newOutputFiles: DirectoryItemsType = [
			GetOutputItemFromInputItem(item, newOutputPath, outputExtension),
		];
		const dedupedOutputFiles = await CheckNameCollision(socket, newOutputPath, newOutputFiles);

		setOutputPath(newOutputPath);
		setOutputFiles(dedupedOutputFiles);
		setNameCollision(false);
		setAllowCollision(false);
	};

	const handleDirectoryInputConfirm = async (item: DirectoryItemType) => {
		const directory = await RequestDirectory(socket, item.path, isRecursive);
		if (!directory) return;

		const inputPathItems: DirectoryItemsType = FilterVideoFiles(directory.items);

		const newOutputPath = outputChanged
			? outputPath
			: config.paths['output-path']
			? config.paths['output-path']
			: item.path;
		const newOutputFiles = GetOutputItemsFromInputItems(
			inputPathItems,
			newOutputPath,
			outputExtension
		);
		const dedupedOutputFiles = await CheckNameCollision(socket, newOutputPath, newOutputFiles);

		setInputPath(item.path);
		if (outputPath != newOutputPath) {
			setOutputPath(newOutputPath);
		}

		setInputFiles(inputPathItems);
		setOutputFiles(dedupedOutputFiles);
		setNameCollision(false);
		setAllowCollision(false);
	};

	const handleInputConfirm = async (item: DirectoryItemType) => {
		switch (jobFrom) {
			case JobFrom.FromFile:
				await handleFileInputConfirm(item);
				break;
			case JobFrom.FromDirectory:
				await handleDirectoryInputConfirm(item);
				break;
		}
	};

	const handleRecursiveChange: React.ChangeEventHandler<HTMLInputElement> = (event) => {
		const value = event.target.checked;

		setIsRecursive(value);

		if (inputPath && outputPath) {
			(async function () {
				const directory = await RequestDirectory(socket, inputPath, value);
				if (!directory) return;

				const newInputFiles = FilterVideoFiles(directory.items);
				const newOutputFiles = await CheckNameCollision(
					socket,
					outputPath,
					GetOutputItemsFromInputItems(newInputFiles, outputPath, outputExtension)
				);
				setInputFiles(newInputFiles);
				setOutputFiles(newOutputFiles);
				setNameCollision(false);
				setAllowCollision(false);
			})();
		}
	};

	const handleOutputConfirm = async (item: DirectoryItemType) => {
		setOutputPath(item.path);
		const newOutputFiles = GetOutputItemsFromInputItems(inputFiles, item.path, outputExtension);
		const dedupedOutputFiles = await CheckNameCollision(socket, item.path, newOutputFiles);
		setOutputFiles(dedupedOutputFiles);
		setOutputChanged(true);
		setNameCollision(false);
		setAllowCollision(false);
	};

	const handleAllowOverwriteSelect = (event: React.ChangeEvent<HTMLSelectElement>) => {
		const value = event.target.value;
		setAllowCollision({ yes: true, no: false }[value]!);
	};

	const handleOutputNameChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		const name = event.target.value;

		if (outputFiles.length > 0) {
			(async function () {
				const newOutputFiles = outputFiles.map((file, index) =>
					index == 0
						? {
								...file,
								path: `${outputPath.replace(/[\\/]+$/, '')}/${name}${outputExtension}`,
								name: name,
								extension: outputExtension,
								isDirectory: false,
						  }
						: file
				);
				setOutputFiles(newOutputFiles);
				setOutputChanged(true);

				const dedupedOutputFiles = await CheckNameCollision(socket, outputPath, newOutputFiles);
				const requestedName = `${newOutputFiles[0].name}${newOutputFiles[0].extension}`;
				const dedupedName = dedupedOutputFiles[0]
					? `${dedupedOutputFiles[0].name}${dedupedOutputFiles[0].extension}`
					: requestedName;

				if (requestedName != dedupedName) {
					setNameCollision(true);
				} else if (nameCollision) {
					setNameCollision(false);
					setAllowCollision(false);
				}
			})();
		}
	};

	// const handleExtensionChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
	// 	const extension = event.target.value;

	// 	setOutputExtension(extension as HandbrakeOutputExtensions);
	// 	setOutputChanged(true);
	// 	const newOutputFiles = outputFiles.map((file) => {
	// 		const oldFileName = file.name + file.extension;

	// 		file.extension = extension;

	// 		const newFileName = file.name + file.extension;
	// 		file.path = file.path.replace(new RegExp(`${oldFileName}$`), newFileName);
	// 		return file;
	// 	});

	// 	console.log(newOutputFiles);

	// 	(async function () {
	// 		const existingFiles: DirectoryItemsType = (await RequestDirectory(socket, outputPath))
	// 			.items;
	// 		if (jobFrom == JobFrom.FromFile) {
	// 			if (
	// 				existingFiles
	// 					.map((item) => item.name + item.extension)
	// 					.includes(newOutputFiles[0].name + newOutputFiles[0].extension)
	// 			) {
	// 				setNameCollision(true);
	// 			} else if (nameCollision) {
	// 				setNameCollision(false);
	// 			}
	// 			setOutputFiles(newOutputFiles);
	// 		} else {
	// 			const dedupedOutputFiles = await socket.emitWithAck(
	// 				'check-name-collision',
	// 				outputPath,
	// 				newOutputFiles
	// 			);
	// 			setOutputFiles(dedupedOutputFiles);
	// 		}
	// 	})();
	// };

	const handlePresetCategoryChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
		const category = event.target.value;
		setPresetCategory(category);
		setIsDefaultPreset(isDefaultPresetCategory(category));
		setPreset('');
		setOutputFiles([]);
		setNameCollision(false);
		setAllowCollision(false);
	};

	const handlePresetChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
		const newPreset = event.target.value;
		if (!newPreset || !getPreset(presetCategory, newPreset)) {
			setPreset('');
			setOutputFiles([]);
			setNameCollision(false);
			setAllowCollision(false);
			return;
		}

		const newExtension = getOutputExtensionFromPreset(presetCategory, newPreset);

		setPreset(newPreset);
		setOutputExtension(newExtension);

		const newOutputFiles =
			jobFrom == JobFrom.FromFile && outputFiles[0]
				? outputFiles.map((file) => ({
						...file,
						path: `${outputPath.replace(/[\\/]+$/, '')}/${file.name}${newExtension}`,
						extension: newExtension,
						isDirectory: false,
				  }))
				: GetOutputItemsFromInputItems(inputFiles, outputPath, newExtension);

		if (outputPath) {
			(async function () {
				const dedupedOutputFiles = await CheckNameCollision(
					socket,
					outputPath,
					newOutputFiles
				);
				setOutputFiles(dedupedOutputFiles);
				setNameCollision(false);
				setAllowCollision(false);
			})();
		}
	};

	const handleSeeMore = (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
		event.preventDefault();
		setSeeMore(!seeMore);
	};

	const contextValue: CreateJobContextType = {
		jobFrom,
		inputPath,
		setInputPath,
		inputFiles,
		setInputFiles,
		isRecursive,
		setIsRecursive,
		outputPath,
		setOutputPath,
		outputFiles,
		setOutputFiles,
		outputExtension,
		setOutputExtension,
		nameCollision,
		setNameCollision,
		outputChanged,
		setOutputChanged,
		allowCollision,
		setAllowCollision,
		presetCategory,
		setPresetCategory,
		preset,
		setPreset,
		isDefaultPreset,
		setIsDefaultPreset,
		seeMore,
		setSeeMore,
		canSubmit,
		handleJobFromChange,
		handleCancel,
		handleSubmit,
		handleFileInputConfirm,
		handleDirectoryInputConfirm,
		handleInputConfirm,
		handleRecursiveChange,
		handleOutputConfirm,
		handleAllowOverwriteSelect,
		handleOutputNameChange,
		handlePresetCategoryChange,
		handlePresetChange,
		handleSeeMore,
	};

	return (
		<Overlay className={styles['create-job-overlay']}>
			<h1 className={styles['heading']}>Create New Job</h1>
			<CreateJobContext value={contextValue}>
				<ModeSection />
				<form action='' className={styles['job-form']}>
					<PresetSection />
					<InputSection />
					<OutputSection />
					{preset && inputFiles.length > 0 && outputFiles.length > 0 && <ResultSection />}
					<ButtonsSection />
				</form>
			</CreateJobContext>
		</Overlay>
	);
}
