export type DirectoryItemType = {
	path: string;
	name: string;
	extension?: string;
	isDirectory: boolean;
};

export type DirectoryItemsType = DirectoryItemType[];

export type DirectoryType = {
	parent?: DirectoryItemType;
	current: DirectoryItemType;
	items: DirectoryItemType[];
};

export type DirectoryRequestType = {
	path: string;
	isRecursive: boolean;
	rootPath?: string;
};

export type CreateDirectoryRequestType = {
	path: string;
	name: string;
	rootPath?: string;
};
