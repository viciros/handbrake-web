import {
	type DirectoryItemType,
	type DirectoryItemsType,
	type DirectoryType,
} from '@handbrake-web/shared/types/directory';
import { TranscodeStage } from '@handbrake-web/shared/types/transcode';
import fs from 'fs/promises';
import logger from 'logging';
import path from 'path';
import { AssertDirectoryNameSafe, AssertPathInMediaRoots, IsPathInMediaRoots } from './path-safety';
import { GetQueue } from './queue';

export async function GetDirectoryItems(absolutePath: string, recursive: boolean = false) {
	try {
		const safePath = AssertPathInMediaRoots(absolutePath, 'directory');

		// Get directory
		const dir = await fs.readdir(safePath, {
			encoding: 'utf-8',
			withFileTypes: true,
			recursive: recursive,
		});
		const maxDirectoryItems = parseInt(process.env.HANDBRAKE_MAX_DIRECTORY_ITEMS || '5000');
		if (dir.length > maxDirectoryItems) {
			throw new Error(
				`Directory '${safePath}' has ${dir.length} items, above the limit ${maxDirectoryItems}.`
			);
		}

		// Make parent item
		const parentPath = path.resolve(safePath, '..');
		const parentItem: DirectoryItemType | undefined =
			parentPath == safePath || !IsPathInMediaRoots(parentPath)
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
		const items: DirectoryItemsType = dir.map((item) => {
			const parsedName = path.parse(item.name);
			return {
				path: path.join(item.parentPath, item.name),
				name: parsedName.name,
				extension: parsedName.ext,
				isDirectory: item.isDirectory(),
			};
		});

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

export async function MakeDirectory(directoryPath: string, directoryName: string) {
	try {
		const safeDirectoryPath = AssertPathInMediaRoots(directoryPath, 'directory');
		const safeDirectoryName = AssertDirectoryNameSafe(directoryName);

		// Check if the program has write permissions in the parent dir
		await fs.access(safeDirectoryPath, fs.constants.W_OK);

		// Get parent directory permissions to copy to new directory
		const parentMode = (await fs.stat(safeDirectoryPath)).mode;

		// Make new directory
		const fullPath = AssertPathInMediaRoots(
			path.join(safeDirectoryPath, safeDirectoryName),
			'new directory'
		);
		await fs.mkdir(fullPath, { mode: parentMode, recursive: false });
		return true;
	} catch (err) {
		logger.error(err);
		return false;
	}
}

export async function CheckFilenameCollision(existingDir: string, newItems: DirectoryItemsType) {
	AssertPathInMediaRoots(existingDir, 'output directory');
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
