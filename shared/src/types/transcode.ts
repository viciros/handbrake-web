export enum TranscodeStage {
	Waiting,
	Scanning,
	Transcoding,
	Finished,
	Stopped,
	Error,
	Unknown,
}

export function IsActiveTranscodeStage(stage: TranscodeStage | null | undefined) {
	return (
		stage == TranscodeStage.Scanning ||
		stage == TranscodeStage.Transcoding ||
		stage == TranscodeStage.Unknown
	);
}
