import type { POCSAGDecoder } from '@/worker/decoders/pocsag';
import type { GSCDecoder } from '@/worker/decoders/golay';
import type { FlexDecoder } from '@/worker/decoders/flex/decoder';
import type { RDSDecoder } from '@/worker/decoders/rds';
import type { CharsetKey } from '@/worker/decoders/charsets';
import type { PocsagMode } from '@/worker/decoders/types';
import type { RationalResampler } from '@/worker/streams/dsp-pipeline';
import type { DSDDecoder } from '@/worker/decoders/dsd/dsd-decoder';
import type { RxStreamStats } from '@/radio/types';
/*
 * Copyright (c) 2026 jLynx <https://github.com/jLynx>
 *
 * This file is part of BrowSDR.
 *
 * BrowSDR is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of
 * the License, or (at your option) any later version.
 *
 * BrowSDR is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public
 * License along with this program. If not, see
 * <https://www.gnu.org/licenses/>.
 */

export interface VfoParams {
	stereo?: boolean;
	adsb?: boolean;
	ais?: boolean;
	radiosonde?: boolean;
	ble?: boolean;
	acars?: boolean;
	rtl433?: boolean;
	rtl433SampleRate?: number;
	rtl433Protocols?: string;
	/** Silence only the speaker mix while keeping decoding and transcription running. */
	audioMuted?: boolean;
	freq: number;
	mode: string;
	enabled: boolean;
	deEmphasis: string;
	squelchEnabled: boolean;
	squelchLevel: number;
	lowPass: boolean;
	highPass: boolean;
	bandwidth: number;
	volume: number;
	pocsag: boolean;
	pocsagCharset?: CharsetKey;
	pocsagMode?: PocsagMode;
	pocsagSecondGuess?: boolean;
	gsc?: boolean;
	/** Show the runner-up GSC alpha/numeric interpretation; default false. */
	gscSecondGuess?: boolean;
	/** Decode FLEX on this NFM VFO. */
	flex?: boolean;
	/** Selected FLEX charset (ASCII default, or Kanji which switches decoding). */
	flexCharset?: CharsetKey;
	rds: boolean;
	rdsRegion: string;
}

export interface VfoState {
	squelchOpen: boolean;
	squelchDb: number;
	pocsagDecoder: POCSAGDecoder | null;
	/** Last time (ms) a POCSAG status snapshot was emitted, for throttling. */
	pocsagStatusAt?: number;
	/** Charset key currently applied to pocsagDecoder, to detect live changes. */
	pocsagCharset?: CharsetKey;
	/** GSC decoder instance (when params.gsc). */
	gscDecoder?: GSCDecoder | null;
	/** Last time (ms) a GSC status snapshot was emitted, for throttling. */
	gscStatusAt?: number;
	/** FLEX decoder instance (when params.flex). */
	flexDecoder?: FlexDecoder | null;
	/** Charset key currently applied to flexDecoder, to detect live changes. */
	flexCharset?: CharsetKey;
	/** Last time (ms) a FLEX status snapshot was emitted, for throttling. */
	flexStatusAt?: number;
	rdsDecoder: RDSDecoder | null;
	audioQueue: Float32Array;
	audioQueueLen: number;
	audioRightQueue?: Float32Array;
	audioChannels?: 1 | 2;
	lastMode?: string;
	deemphPrev?: number;
	dcAvg?: number;
	agcGain?: number;
	ssbPhase?: number;
	cwTone?: number;
	currentIfRate?: number;
	audioResampler?: RationalResampler;
	lastBandwidth?: number;
	audioTarget?: Float32Array;
	scratchBuf?: Float32Array;
	/** DSD decoder instance (when mode === 'dsd') */
	dsdDecoder?: DSDDecoder;
	/** Resampler 8000 → 48000 Hz for DSD audio output */
	dsdAudioResampler?: RationalResampler;
	/** Accumulator for DSD decoded audio at 8 kHz */
	dsdAudioBuf?: Float32Array;
	/** Number of valid samples in dsdAudioBuf */
	dsdAudioBufLen?: number;
}

export interface PerfCounters {
	usbCallbacks: number;
	audioCalls: number;
	audioSamplesOut: number;
	dspTimeSum: number;
	dspTimeMax: number;
	inputSamplesSum: number;
	droppedChunks: number;
	msgsSent: number;
	whisperMsgsSent?: number;
	lastReportTime: number;
	lastChunkSize?: number;
	report: PerfReport;
}

export interface PerfReport extends Partial<RxStreamStats> {
	usbFps: number;
	audioFps: number;
	dspAvgMs: number | string;
	dspMaxMs: number | string;
	audioRate: number;
	inputRate: number;
	dropped: number;
	/** Cumulative skipped IQ consumer deliveries since this stream started. */
	droppedTotal?: number;
	chunkSize: number;
	msgRate?: number;
	whisperMsgRate?: number;
	channelAvgMs?: number;
	channelMaxMs?: number;
	channelCpuMs?: number;
}

export interface RxStreamOpts {
	centerFreq: number;
	frequencyShift?: number;
	sampleRate: number;
	fftSize: number;
	spectrumFps?: number;
	sharedChannelization?: boolean;
	whisperEnabled?: boolean;
	gains?: Record<string, number>;
	/** @deprecated Use gains instead */
	lnaGain?: number;
	/** @deprecated Use gains instead */
	vgaGain?: number;
	/** @deprecated Use gains instead */
	ampEnabled?: boolean;
}

export interface RemoteClientState {
	perf?: { audioCalls: number; audioSamplesOut: number; dspTimeSum: number; dspTimeMax: number; msgsSent: number };
	channelization?: { bands: number; vfos: number; sampleRate: number };
	sharedChannelization?: boolean;
	workers: Array<Worker | null>;
	params: Array<VfoParams | null>;
	audioQueues: Array<{ queue: Float32Array; len: number; right?: Float32Array; channels?: 1 | 2 }>;
	mixBuf: Float32Array | null;
	pocsagDecoders: Array<POCSAGDecoder | null>;
	/** Per-index last POCSAG status emission time (ms) for throttling. */
	pocsagStatusAt?: number[];
	/** Per-index charset key currently applied, to detect live changes. */
	pocsagCharsets?: Array<CharsetKey | undefined>;
	/** Per-index GSC decoder instances. */
	gscDecoders?: Array<GSCDecoder | null>;
	/** Per-index last GSC status emission time (ms) for throttling. */
	gscStatusAt?: number[];
	/** Per-index FLEX decoder instances. */
	flexDecoders?: Array<FlexDecoder | null>;
	/** Per-index last FLEX status emission time (ms) for throttling. */
	flexStatusAt?: number[];
	rdsDecoders: Array<RDSDecoder | null>;
	squelchOpen: boolean[];
}

export interface DeviceOpenOpts {
	/** Index in getDevices() disambiguates missing or duplicated serial numbers. */
	deviceIndex?: number;
	vendorId?: number;
	productId?: number;
	serialNumber?: string;
}
