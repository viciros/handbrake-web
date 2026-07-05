import {
	type DirectoryItemType,
	type DirectoryItemsType,
	type DirectoryType,
} from '@handbrake-web/shared/types/directory';
import { TranscodeStage } from '@handbrake-web/shared/types/transcode';
import type { Dirent } from 'fs';
import fs from 'fs/promises';
import logger from 'logging';
import path from 'path';
import {
	AssertDirectoryNameSafe,
	AssertExistingDirectoryInMediaRoots,
	AssertExistingDirectoryInRoots,
	IsPathInMediaRoots,
	IsPathInRoots,
} from './path-safety';
import { GetQueue } from './queue';

const getMaxDirectoryItems = () => parseInt(process.env.HANDBRAKE_MAX_DIRECTORY_ITEMS || '5000');

const directoryItemFromDirent = (parentPath: string, item: Dirent): DirectoryItemType => {
	const parsedName = path.parse(item.name);

	return {
		path: path.join(parentPath, item.name),
		name: parsedName.name,
		extension: parsedName.ext,
		isDirectory: item.isDirectory(),
	};
};

const GetDirectoryItemList = async (rootPath: string, recursive: boolean) => {
	const maxDirectoryItems = getMaxDirectoryItems();
	const pendingDirectories = [rootPath];
	const items: DirectoryItemsType = [];

	while (pendingDirectories.length > 0) {
		const currentPath = pendingDirectories.shift()!;
		const dir = await fs.readdir(currentPath, {
			encoding: 'utf-8',
			withFileTypes: true,
		});

		for (const item of dir) {
			if (items.length >= maxDirectoryItems) {
				throw new Error(
					`Directory '${rootPath}' has more than ${maxDirectoryItems} items.`
				);
			}

			items.push(directoryItemFromDirent(currentPath, item));

			if (recursive && item.isDirectory()) {
				pendingDirectories.push(path.join(currentPath, item.name));
			}
		}
	}

	return items;
};

export async function GetDirectoryItems(
	absolutePath: string,
	recursive: boolean = false,
	rootPath?: string
) {
	try {
		const roots = rootPath ? [rootPath] : undefined;
		const safePath = roots
			? await AssertExistingDirectoryInRoots(absolutePath, roots, 'directory')
			: await AssertExistingDirectoryInMediaRoots(absolutePath, 'directory');

		// Make parent item
		const parentPath = path.resolve(safePath, '..');
		const canNavigateToParent = roots
			? IsPathInRoots(parentPath, roots)
			: IsPathInMediaRoots(parentPath);
		const parentItem: DirectoryItemType | undefined =
			parentPath == safePath || !canNavigateToParent
				? undefined
				: {
						path: parentPath,
						name: path.basename(parentPath) || parentPath,
						isDirectory: true,
				  };

		// Make current item
		const currentItem: DirectoryItemType = {
			path: safePath,
			name: path.basename(safePath) || safePath,
			isDirectory: true,
		};

		// Make directory items
		const items = await GetDirectoryItemList(safePath, recursive);

		// Build directory object
		const result: DirectoryType = {
			parent: parentPath != absolutePath ? parentItem : undefined,
			current: currentItem,
			items: items,
		};
		// logger.info(result);
		return result;
	} catch (err) {
		logger.error(`[files] Cannot get directory '${absolutePath}'.`);
		throw err;
	}
}

export async function MakeDirectory(
	directoryPath: string,
	directoryName: string,
	rootPath?: string
) {
	try {
		const safeDirectoryPath = rootPath
			? await AssertExistingDirectoryInRoots(directoryPath, [rootPath], 'directory')
			: await AssertExistingDirectoryInMediaRoots(directoryPath, 'directory');
		const safeDirectoryName = AssertDirectoryNameSafe(directoryName);

		// Check if the program has write permissions in the parent dir
		await fs.access(safeDirectoryPath, fs.constants.W_OK);

		// Get parent directory permissions to copy to new directory
		const parentMode = (await fs.stat(safeDirectoryPath)).mode;

		// Make new directory
		const fullPath = path.join(safeDirectoryPath, safeDirectoryName);
		await fs.mkdir(fullPath, { mode: parentMode, recursive: false });
		return true;
	} catch (err) {
		logger.error(err);
		return false;
	}
}

export async function CheckFilenameCollision(existingDir: string, newItems: DirectoryItemsType) {
	await AssertExistingDirectoryInMediaRoots(existingDir, 'output directory');
	const directory = await GetDirectoryItems(existingDir);
	const existingItems = directory ? directory.items : [];
	const queue = await GetQueue();
	const waitingOutputPaths = queue
		.filter((job) => job.transcode_stage == TranscodeStage.Waiting)
		.map((job) => job.output_path);
	const fileCollisions: { [index: string]: number[] } = {};

	newItems.forEach((newItem, newItemIndex) => {
		// Init fileCollisions object with an empty array
		fileCollisions[newItem.name] = [];

		// Check for collisions against existing files
		existingItems.forEach((existingItem) => {
			if (newItem.name + newItem.extension == existingItem.name + existingItem.extension) {
				fileCollisions[newItem.name].push(newItemIndex);
				logger.info(
					`[server] [files] '${
						newItem.name + newItem.extension
					}' collides with existing file '${
						existingItem.name + existingItem.extension
					}' at the output path.`
				);
				return;
			}
		});

		// Check for collisions against other output files that may now have the same name
		newItems
			.filter((_, index) => index != newItemIndex)
			.forEach((otherNewItem) => {
				if (
					newItem.name == otherNewItem.name &&
					!fileCollisions[newItem.name].includes(newItemIndex)
				) {
					fileCollisions[newItem.name].push(newItemIndex);
					logger.info(
						`[server] [files] '${
							newItem.name + newItem.extension
						}' collides with another output '${
							otherNewItem.name + otherNewItem.extension
						}'`
					);
					return;
				}
		});

		// Check for collisions against waiting jobs in the queue (files don't exist yet)
		waitingOutputPaths.forEach((waitingItem) => {
				if (
					waitingItem == newItem.path &&
					!fileCollisions[newItem.name].includes(newItemIndex)
				) {
					fileCollisions[newItem.name].push(newItemIndex);
					logger.info(
						`[server] [files] '${
							newItem.name + newItem.extension
						}' collides with a pending job '${path.basename(waitingItem)}'`
					);
					return;
				}
			});
	});

	const renamedItems: DirectoryItemsType = JSON.parse(JSON.stringify(newItems));
	Object.values(fileCollisions).forEach((collisionArray) => {
		let fileIndex = 1;
		collisionArray.forEach((value) => {
			const renamedItem = renamedItems[value];
			// Increment the file index while a filename with the appended index exists either in the existing or renamed files
			while (
				existingItems
					.map((existingItem) => existingItem.name + existingItem.extension)
					.includes(renamedItem.name + `_${fileIndex}` + renamedItem.extension) ||
				waitingOutputPaths
					.map((outputPath) => path.basename(outputPath))
					.includes(renamedItem.name + `_${fileIndex}` + renamedItem.extension) ||
				renamedItems.map((item) => item.name).includes(renamedItem.name + `_${fileIndex}`)
			) {
				fileIndex += 1;
			}

			const newName = renamedItem.name + `_${fileIndex}`;
			const newPath =
				path.join(path.dirname(renamedItem.path), newName) + renamedItem.extension;
			renamedItems[value].name = newName;
			renamedItems[value].path = newPath;
		});
	});

	return renamedItems;
}
