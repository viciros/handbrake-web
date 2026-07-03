/* eslint-disable react-hooks/exhaustive-deps */
import {
	CreateDirectoryRequestType,
	DirectoryItemType,
	DirectoryRequestType,
	DirectoryType,
} from '@handbrake-web/shared/types/directory';
import { FileBrowserMode } from '@handbrake-web/shared/types/file-browser';
import AddFolderIcon from '@icons/folder-plus.svg?react';
import { HTMLAttributes, useContext, useEffect, useState } from 'react';
import ButtonInput from '~components/base/inputs/button';
import { PrimaryContext } from '~layouts/primary/context';
import AddDirectory from './components/add-directory';
import FileBrowserBody from './components/browser-body';
import styles from './styles.module.scss';

interface Properties extends HTMLAttributes<HTMLDivElement> {
	startPath: string;
	rootPath: string;
	mode: FileBrowserMode;
	allowCreate: boolean;
	onConfirm: (item: DirectoryItemType) => void;
}

export default function FileBrowser({
	startPath,
	rootPath,
	mode,
	allowCreate,
	onConfirm,
	className,
	...properties
}: Properties) {
	const { socket } = useContext(PrimaryContext)!;

	const [currentPath, setCurrentPath] = useState(startPath);
	const [selectedItem, setSelectedItem] = useState<DirectoryItemType>();
	const [directory, setDirectory] = useState<DirectoryType | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [createNewItem, setCreateNewItem] = useState(false);
	const [errorMessage, setErrorMessage] = useState('');
	const socketAckTimeoutMs = 10000;

	const requestDirectory = async (path: string, isRecursive: boolean = false) => {
		setIsLoading(true);
		setErrorMessage('');
		console.log(`[client] Requesting directory ${path}...`);
		const request: DirectoryRequestType = {
			path: path,
			isRecursive: isRecursive,
		};
		try {
			const response: DirectoryType = await socket
				.timeout(socketAckTimeoutMs)
				.emitWithAck('get-directory', request);
			console.log(
				`[client] Received directory ${response.current.path} with ${response.items.length} items.`
			);
			setDirectory(response);
			return response;
		} catch (err) {
			console.error(`[client] [error] Could not load directory '${path}'.`);
			console.error(err);
			setErrorMessage('Unable to load directory.');
			return null;
		} finally {
			setIsLoading(false);
		}
	};

	useEffect(() => {
		async function InitDirectory() {
			const newDirectory = await requestDirectory(currentPath);
			if (!newDirectory) return;
			if (mode == FileBrowserMode.Directory && !selectedItem) {
				setSelectedItem(newDirectory.current);
			}
		}
		InitDirectory();
	}, []);

	const handleUpdateDirectory = async (newPath: string) => {
		const newDirectory = await requestDirectory(newPath);
		if (!newDirectory) return;

		setCurrentPath(newDirectory.current.path);
		setSelectedItem(mode == FileBrowserMode.Directory ? newDirectory.current : undefined);
	};

	const selectedFileLabel =
		mode == FileBrowserMode.SingleFile
			? 'Selected File:'
			: mode == FileBrowserMode.Directory
			? 'Selected Directory:'
			: '';

	const handleAddDirectoryButton = (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
		event.preventDefault();
		setCreateNewItem(true);
	};

	const handleAddDirectoryCancel = () => {
		setCreateNewItem(false);
	};

	const handleAddDirectorySubmit = async (directoryName: string) => {
		const request: CreateDirectoryRequestType = {
			path: currentPath,
			name: directoryName,
		};
		try {
			const result = await socket
				.timeout(socketAckTimeoutMs)
				.emitWithAck('make-directory', request);
			setCreateNewItem(false);
			if (result) {
				requestDirectory(currentPath);
			}
		} catch (err) {
			console.error(`[client] [error] Could not create directory '${directoryName}'.`);
			console.error(err);
			setErrorMessage('Unable to create directory.');
		}
	};

	const handleConfirmButton = async (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
		event.preventDefault();
		if (selectedItem) {
			onConfirm(selectedItem);
		} else {
			console.error('[client] [error] Cannot confirm, there is no selected path.');
		}
	};

	return (
		<div
			className={`file-browser ${styles['file-browser']} ${className || ''}`}
			{...properties}
		>
			<div className={styles['header']}>
				<div className={styles['current-path']}>
					<span>{currentPath}</span>
					{isLoading && <span> (Loading...)</span>}
					{errorMessage && <span> ({errorMessage})</span>}
				</div>
				{mode == FileBrowserMode.Directory && allowCreate && (
					<button
						className={styles['add-directory']}
						title='Add New Directory'
						onClick={handleAddDirectoryButton}
						onKeyDown={(event) => {
							event.preventDefault();
						}}
					>
						<AddFolderIcon />
					</button>
				)}
			</div>
			<div className={styles['main']}>
				<FileBrowserBody
					mode={mode}
					rootPath={rootPath}
					directory={directory}
					updateDirectory={handleUpdateDirectory}
					selectedItem={selectedItem}
					setSelectedItem={setSelectedItem}
				/>
				<div className={styles['footer']}>
					<div className={styles['selected-file']}>
						<span className={styles['selected-file-label']}>{selectedFileLabel}</span>
						<span className={styles['selected-file-path']}>
							{selectedItem ? selectedItem.path : 'N/A'}
						</span>
						<ButtonInput
							label='Confirm'
							color='green'
							onClick={handleConfirmButton}
							disabled={selectedItem == undefined}
						/>
					</div>
				</div>
				{directory && createNewItem && (
					<AddDirectory
						existingItems={directory.items}
						onCancel={handleAddDirectoryCancel}
						onSubmit={handleAddDirectorySubmit}
					/>
				)}
			</div>
		</div>
	);
}
