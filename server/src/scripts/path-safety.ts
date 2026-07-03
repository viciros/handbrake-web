import fs from 'fs/promises';
import path from 'path';

import { GetConfig } from './config/config';
import { getVideoPath } from './data';

const invalidPathSegmentRegex = /[<>:"|?*\u0000-\u001f]/g;

const unique = (values: string[]) => [...new Set(values)];

export const normalizePath = (value: string) => path.resolve(value);

export function IsSubPath(parent: string, child: string) {
	const relative = path.relative(normalizePath(parent), normalizePath(child));
	return relative == '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function GetMediaRoots() {
	const config = GetConfig();
	const roots = [getVideoPath(), config.paths['media-path']]
		.filter((value): value is string => typeof value == 'string' && value.length > 0)
		.map(normalizePath);

	return unique(roots);
}

export function IsPathInMediaRoots(value: string) {
	const resolvedPath = normalizePath(value);
	return GetMediaRoots().some((root) => IsSubPath(root, resolvedPath));
}

export function AssertPathInMediaRoots(value: string, label: string) {
	const resolvedPath = normalizePath(value);

	if (!IsPathInMediaRoots(resolvedPath)) {
		throw new Error(`${label} '${value}' is outside the configured media roots.`);
	}

	return resolvedPath;
}

export async function AssertExistingPathInMediaRoots(value: string, label: string) {
	const resolvedPath = AssertPathInMediaRoots(value, label);
	const realPath = await fs.realpath(resolvedPath);

	return AssertPathInMediaRoots(realPath, label);
}

export async function AssertOutputPathInMediaRoots(value: string, label: string) {
	const resolvedPath = AssertPathInMediaRoots(value, label);
	const parentPath = await fs.realpath(path.dirname(resolvedPath));

	AssertPathInMediaRoots(parentPath, `${label} parent`);
	return resolvedPath;
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
