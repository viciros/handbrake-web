import {
	DirectoryItemType,
	DirectoryItemsType,
	DirectoryRequestType,
	DirectoryType,
} from '@handbrake-web/shared/types/directory';
import mime from 'mime';
import { Socket } from 'socket.io-client';

const socketAckTimeoutMs = 10000;

export async function RequestDirectory(
	socket: Socket,
	path: string,
	isRecursive: boolean = false
) {
	const request: DirectoryRequestType = {
		path: path,
		isRecursive: isRecursive,
	};
	try {
		const response: DirectoryType = await socket
			.timeout(socketAckTimeoutMs)
			.emitWithAck('get-directory', request);
		return response;
	} catch (err) {
		console.error(`[client] [error] Could not load directory '${path}'.`);
		console.error(err);
		return null;
	}
}

export async function CheckNameCollision(
	socket: Socket,
	outputPath: string,
	outputItems: DirectoryItemsType
) {
	if (!outputPath || outputItems.length == 0) return outputItems;

	try {
		const response: DirectoryItemsType = await socket
			.timeout(socketAckTimeoutMs)
			.emitWithAck('check-name-collision', outputPath, outputItems);
		return response;
	} catch (err) {
		console.error(`[client] [error] Could not check output name collisions.`);
		console.error(err);
		return outputItems;
	}
}

export function FilterVideoFiles(items: DirectoryItemsType) {
	return items
		.filter((item) => !item.isDirectory)
		.filter((item) => mime.getType(item.path)?.includes('video'));
}

const JoinOutputPath = (outputPath: string, name: string, extension: string) => {
	const directory = outputPath.replace(/[\\/]+$/, '');
	return `${directory}/${name}${extension}`;
};

export function GetOutputItemFromInputItem(
	inputItem: DirectoryItemType,
	outputPath: string,
	extension: string
) {
	return {
		path: JoinOutputPath(outputPath, inputItem.name, extension),
		name: inputItem.name,
		extension: extension,
		isDirectory: false,
	};
}

export function GetOutputItemsFromInputItems(
	inputItems: DirectoryItemsType,
	outputPath: string,
	extension: string
) {
	return inputItems.map((item) => {
		return GetOutputItemFromInputItem(item, outputPath, extension);
	});
}
