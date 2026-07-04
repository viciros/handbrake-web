import { TranscodeStage } from '../types/transcode';

export const statusSorting: { [key in TranscodeStage]: number } = {
	[TranscodeStage.Transcoding]: 1,
	[TranscodeStage.Scanning]: 2,
	[TranscodeStage.Transferring]: 3,
	[TranscodeStage.Waiting]: 4,
	[TranscodeStage.Stopped]: 5,
	[TranscodeStage.Error]: 6,
	[TranscodeStage.Unknown]: 7,
	[TranscodeStage.Finished]: 8,
};
