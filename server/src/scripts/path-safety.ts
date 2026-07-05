import fs from 'fs/promises';
import path from 'path';

import { GetConfig } from './config/config';

const invalidPathSegmentRegex = /[<>:"|?*\u0000-\u001f]/g;

const unique = (values: string[]) => [...new Set(values)];

export const normalizePath = (value: string) => path.resolve(value);

export function IsSubPath(parent: string, child: string) {
	const relative = path.relative(normalizePath(parent), normalizePath(child));
	return relative == '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function GetMediaRoots() {
	const config = GetConfig();
	const roots = [config.paths['input-path'], config.paths['output-path']]
		.filter((value): value is string => typeof value == 'string' && value.length > 0)
		.map(normalizePath);

	return unique(roots);
}

async function GetRealRoots(roots: string[]) {
	const realRoots = await Promise.all(
		roots.map(async (root) => {
			try {
				return await fs.realpath(root);
			} catch {
				return undefined;
			}
		})
	);

	return unique(
		realRoots
			.filter((value): value is string => typeof value == 'string' && value.length > 0)
			.map(normalizePath)
	);
}

export function IsPathInRoots(value: string, roots: string[]) {
	const resolvedPath = normalizePath(value);
	return roots.map(normalizePath).some((root) => IsSubPath(root, resolvedPath));
}

export function IsPathInMediaRoots(value: string) {
	return IsPathInRoots(value, GetMediaRoots());
}

export function AssertPathInRoots(value: string, roots: string[], label: string) {
	const resolvedPath = normalizePath(value);

	if (!IsPathInRoots(resolvedPath, roots)) {
		throw new Error(`${label} '${value}' is outside the configured media roots.`);
	}

	return resolvedPath;
}

export function AssertPathInMediaRoots(value: string, label: string) {
	return AssertPathInRoots(value, GetMediaRoots(), label);
}

async function AssertRealPathInRoots(value: string, roots: string[], label: string) {
	const resolvedPath = normalizePath(value);
	const realRoots = await GetRealRoots(roots);

	if (!realRoots.some((root) => IsSubPath(root, resolvedPath))) {
		throw new Error(`${label} '${value}' is outside the configured media roots.`);
	}

	return resolvedPath;
}

export async function AssertExistingPathInRoots(value: string, roots: string[], label: string) {
	const resolvedPath = AssertPathInRoots(value, roots, label);
	const realPath = await fs.realpath(resolvedPath);

	return AssertRealPathInRoots(realPath, roots, label);
}

export async function AssertExistingPathInMediaRoots(value: string, label: string) {
	return AssertExistingPathInRoots(value, GetMediaRoots(), label);
}

export async function AssertExistingDirectoryInRoots(value: string, roots: string[], label: string) {
	const realPath = await AssertExistingPathInRoots(value, roots, label);
	const stats = await fs.stat(realPath);
	if (!stats.isDirectory()) {
		throw new Error(`${label} '${value}' is not a directory.`);
	}

	return realPath;
}

export async function AssertExistingDirectoryInMediaRoots(value: string, label: string) {
	return AssertExistingDirectoryInRoots(value, GetMediaRoots(), label);
}

export async function AssertExistingDirectoryInRoot(value: string, root: string, label: string) {
	return AssertExistingDirectoryInRoots(value, [root], label);
}

export async function AssertOutputPathInRoots(value: string, roots: string[], label: string) {
	const resolvedPath = AssertPathInRoots(value, roots, label);
	const parentPath = await fs.realpath(path.dirname(resolvedPath));

	await AssertRealPathInRoots(parentPath, roots, `${label} parent`);
	return resolvedPath;
}

export async function AssertOutputPathInMediaRoots(value: string, label: string) {
	return AssertOutputPathInRoots(value, GetMediaRoots(), label);
}

export function AssertDirectoryNameSafe(value: string) {
	if (
		value.length == 0 ||
		value == '.' ||
		value == '..' ||
		value.includes('/') ||
		value.includes('\\')
	) {
		throw new Error(`Directory name '${value}' is not safe.`);
	}

	return value;
}

export function SanitizePathSegment(value: string) {
	const sanitized = value.trim().replaceAll(invalidPathSegmentRegex, '_');

	if (
		sanitized.length == 0 ||
		sanitized == '.' ||
		sanitized == '..' ||
		sanitized.includes('/') ||
		sanitized.includes('\\')
	) {
		throw new Error(`Path segment '${value}' is not safe.`);
	}

	return sanitized;
}

export function JoinUnderRoot(root: string, ...segments: string[]) {
	const resolvedRoot = normalizePath(root);
	const resolvedPath = path.resolve(resolvedRoot, ...segments);

	if (!IsSubPath(resolvedRoot, resolvedPath)) {
		throw new Error(`Resolved path '${resolvedPath}' escapes '${resolvedRoot}'.`);
	}

	return resolvedPath;
}
