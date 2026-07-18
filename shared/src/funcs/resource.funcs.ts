export const CalculateMemoryUsedPercent = (
	availableBytes: number | null,
	totalBytes: number | null
) => {
	if (
		availableBytes == null ||
		totalBytes == null ||
		availableBytes < 0 ||
		totalBytes <= 0 ||
		availableBytes > totalBytes
	) {
		return null;
	}

	return ((totalBytes - availableBytes) / totalBytes) * 100;
};
