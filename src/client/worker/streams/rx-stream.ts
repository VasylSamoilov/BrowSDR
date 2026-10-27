import { installWorkerAudioHandler, createAudioBatchers } from './local-audio';
import { initializePerformanceReporting } from './performance';
import { dispatchIqChunk } from './channel-dispatch';
import { initializeVfoWorkers } from './vfo-workers';
import { configureReceiveGains, startUsbOnlyStream } from './usb-diagnostic';
import type {
	SamplesCallback,
	AudioCallback,
	WhisperCallback,
	PagerCallbacks,
	RdsCallback,
	RdsStatusCallback,
	Rtl433Callback,
	AdsbCallback,
	AisCallback,
	RadiosondeCallback,
	BleCallback,
	AcarsCallback,
	DsdCallback,
} from '@/worker/runtime/callbacks.types';

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

import * as Comlink from 'comlink';
import { FFT } from '@/worker/runtime/wasm-init';
import type { ChannelPlan } from './types';
import type { RxStreamOpts, VfoParams } from '@/worker/runtime/types';
import type { Backend } from '@/worker/runtime/backend';
import { displayToDeviceFrequencyHz } from '@/radio/frequency-shift';
import { spectrumSmoothingAlpha } from '@/display/spectrum-rate';

let _streamStarting = false;

export async function startRxStream(
	backend: Backend,
	opts: RxStreamOpts,
	spectrumCallback: SamplesCallback,
	audioCallback: AudioCallback,
	whisperCallback: WhisperCallback | null,
	pager: PagerCallbacks,
	rdsCallback: RdsCallback | null = null,
	rdsStatusCallback: RdsStatusCallback | null = null,
	dsdStatusCallback: DsdCallback | null = null,
	rtl433Callback: Rtl433Callback | null = null,
	adsbCallback: AdsbCallback | null = null,
	aisCallback: AisCallback | null = null,
	bleCallback: BleCallback | null = null,
	acarsCallback: AcarsCallback | null = null,
	radiosondeCallback: RadiosondeCallback | null = null,
): Promise<void> {
	if (_streamStarting) return;
	_streamStarting = true;
	const generation = (backend._streamGeneration = (backend._streamGeneration ?? 0) + 1);
	backend._remoteClientAudioCb = audioCallback; // Save reference for when chunk arrives
	backend._remoteClientWhisperCb = whisperCallback; // Save for remote client transcription
	try {
		const { device } = backend;
		if (!device) throw new Error('No device connected');
		const { centerFreq, frequencyShift = 0, sampleRate, fftSize, gains } = opts;

		await device.setSampleRate(sampleRate);
		await device.setFrequency(displayToDeviceFrequencyHz(centerFreq, frequencyShift));
		await configureReceiveGains(device, gains);
		if (import.meta.env.DEV && device.deviceType === 'limesdr' && gains?.['Receive Mode'] === 1) {
			return await startUsbOnlyStream(backend, sampleRate);
		}

		// ── Spectrum FFT setup ────────────────────────────────────────
		const { spectrumFft, spectrumOutput } = initializeSpectrum(fftSize, backend);

		// Double buffer for Comlink zero-copy memory transfers
		let specFlip = new Float32Array(fftSize);
		let specFlop = new Float32Array(fftSize);
		let useFlip = true;

		const iqBuffer = new Int8Array(fftSize * 2);
		let iqBufferPos = 0;
		backend.setSpectrumFps(opts.spectrumFps ?? 20);
		backend._sharedChannelization = opts.sharedChannelization !== false;
		backend.setWhisperEnabled(opts.whisperEnabled === true);
		const channel = {
			worker: undefined as Worker | undefined,
			plan: undefined as ChannelPlan | undefined,
			targets: [] as Array<{ worker: Worker; params: VfoParams; shared: boolean }>,
			pending: 0,
			key: '',
			perf: { calls: 0, sum: 0, max: 0 },
		};
		installChannelCleanup(backend, channel);
		let lastSpectrumTime = 0;

		// ── Audio DDC setup ───────────────────────────────────────────
		// Full SDR++ pipeline in Rust: NCO → polyphase resampler (→50kHz)
		// → channel FIR → squelch → FM demod → post-demod FIR → audio resampler (→48kHz)
		initializeWorkers(backend, opts, {
			rtl433Callback,
			rdsCallback,
			rdsStatusCallback,
			dsdStatusCallback,
			adsbCallback,
			aisCallback,
			bleCallback,
			acarsCallback,
			radiosondeCallback,
		});

		// ── DSP Performance Counters ──────────────────────────────────
		const perf = initializePerformanceReporting(backend, channel.perf, sampleRate);

		// ── Audio Batching Buffer ─────────────────────────────────────
		// Batch local PCM over at least 5ms to feed adaptive playback promptly.
		// Remote PCM uses larger batches to limit transport message overhead.
		const { pushWhisper, pushAudio } = createAudioBatchers(backend, whisperCallback, perf, audioCallback);

		// ── Audio Processing — helper processes a single VFO ──────────
		// Returns Float32Array of audio samples, or null if none produced
		let chunkCounter = 0;
		installWorkerAudioHandler(backend, 0, perf, whisperCallback, pushWhisper, pager, pushAudio);

		// Apply initial gains BEFORE starting bulk reads to avoid
		// control transfer conflicts with in-flight bulk transfers.
		// Matches librtlsdr / SDR++ which configure everything before streaming.
		await device.startRx((data: ArrayBufferView) => {
			if (backend._streamGeneration !== generation) return;
			if (skipRetuningInput(backend)) {
				chunkCounter++;
				return;
			}
			perf.usbCallbacks++;

			const signed = new Int8Array(data.buffer, data.byteOffset, data.byteLength);
			perf.lastChunkSize = signed.length;
			perf.inputSamplesSum += signed.length / 2;

			chunkCounter++;

			// Bulk copy for spectrum buffer
			({ iqBufferPos, lastSpectrumTime, useFlip, specFlip, specFlop } = processSpectrumChunk(
				signed,
				iqBuffer,
				iqBufferPos,
				lastSpectrumTime,
				backend,
				spectrumFft,
				spectrumOutput,
				useFlip,
				specFlip,
				specFlop,
				fftSize,
				spectrumCallback,
			));

			// Broadcast to DSP workers
			dispatchIqChunk(backend, sampleRate, centerFreq, channel, perf, signed, chunkCounter);
		});

		// Reinitialize all remote client DSP workers with the new sample rate
		// and shared IQ buffers. Without this, remote workers hold stale references
		// from the previous startRxStream and produce garbled audio.
		backend._reinitRemoteClientWorkers();
	} catch (e) {
		console.error('DEBUG CRASH IN STARTRXSTREAM:', e);
		throw e;
	} finally {
		_streamStarting = false;
	}
}

function initializeSpectrum(fftSize: number, backend: Backend) {
	const spectrumWindowFunc = (x: number): number => {
		const n = x * fftSize;
		const N = fftSize;
		const a0 = 0.355768;
		const a1 = 0.487396;
		const a2 = 0.144232;
		const a3 = 0.012604;
		return a0 - a1 * Math.cos((2.0 * Math.PI * n) / N) + a2 * Math.cos((4.0 * Math.PI * n) / N) - a3 * Math.cos((6.0 * Math.PI * n) / N);
	};
	const spectrumWindow = new Float32Array(fftSize);
	for (let i = 0; i < fftSize; i++) {
		spectrumWindow[i] = spectrumWindowFunc(i / fftSize);
	}
	const spectrumFft = new FFT(fftSize, spectrumWindow);
	backend._disposeSpectrum?.();
	backend._disposeSpectrum = () => spectrumFft.free();
	spectrumFft.set_smoothing_speed(0.6);
	const spectrumOutput = new Float32Array(fftSize);
	return { spectrumFft, spectrumOutput };
}

function processSpectrumChunk(
	signed: Int8Array<ArrayBufferLike>,
	iqBuffer: Int8Array<ArrayBuffer>,
	iqBufferPos: number,
	lastSpectrumTime: number,
	backend: Backend,
	spectrumFft: FFT,
	spectrumOutput: Float32Array<ArrayBuffer>,
	useFlip: boolean,
	specFlip: Float32Array<ArrayBuffer>,
	specFlop: Float32Array<ArrayBuffer>,
	fftSize: number,
	spectrumCallback: SamplesCallback,
) {
	{
		let srcOff = 0;
		while (srcOff < signed.length) {
			const space = iqBuffer.length - iqBufferPos;
			const toCopy = Math.min(space, signed.length - srcOff);
			iqBuffer.set(signed.subarray(srcOff, srcOff + toCopy), iqBufferPos);
			iqBufferPos += toCopy;
			srcOff += toCopy;
			if (iqBufferPos >= iqBuffer.length) {
				iqBufferPos = 0;
				const now = performance.now();
				if (now - lastSpectrumTime >= 1000 / backend._spectrumFps) {
					spectrumFft.set_smoothing_speed(spectrumSmoothingAlpha(lastSpectrumTime === 0 ? 50 : now - lastSpectrumTime));
					lastSpectrumTime = now;
					// Revert back to copy-based FFT for the spectrum waterfall
					// because `iqBuffer` batches data across USB chunk boundaries.
					spectrumFft.fft(iqBuffer, spectrumOutput);

					// Double buffer the output since Comlink.transfer neuters the buffer on this side.
					let specCopy = useFlip ? specFlip : specFlop;
					if (specCopy.length === 0) {
						// Was neutered by Comlink
						specCopy = new Float32Array(fftSize);
						if (useFlip) specFlip = specCopy;
						else specFlop = specCopy;
					}

					specCopy.set(spectrumOutput);
					useFlip = !useFlip;

					// Slice for remote BEFORE Comlink.transfer — transfer detaches specCopy.buffer,
					// making any subsequent .slice() throw "detached ArrayBuffer".
					if (backend._remoteHostFftCb) backend._remoteHostFftCb(specCopy.slice());
					if (spectrumCallback) spectrumCallback(Comlink.transfer(specCopy, [specCopy.buffer]));
				}
			}
		}
	}
	return { iqBufferPos, lastSpectrumTime, useFlip, specFlip, specFlop };
}

function skipRetuningInput(backend: Backend): boolean {
	return backend._retuning || performance.now() < backend._settleUntil;
}

function initializeWorkers(
	backend: Backend,
	opts: RxStreamOpts,
	callbacks: {
		rtl433Callback: Rtl433Callback | null;
		rdsCallback: RdsCallback | null;
		rdsStatusCallback: RdsStatusCallback | null;
		dsdStatusCallback: DsdCallback | null;
		adsbCallback: AdsbCallback | null;
		aisCallback: AisCallback | null;
		bleCallback: BleCallback | null;
		acarsCallback: AcarsCallback | null;
		radiosondeCallback: RadiosondeCallback | null;
	},
): void {
	initializeVfoWorkers(
		backend,
		opts.centerFreq,
		callbacks.rtl433Callback,
		callbacks.rdsCallback,
		callbacks.rdsStatusCallback,
		callbacks.dsdStatusCallback,
		opts.sampleRate,
		callbacks.adsbCallback,
		callbacks.aisCallback,
		callbacks.bleCallback,
		callbacks.acarsCallback,
		callbacks.radiosondeCallback,
	);
}

function installChannelCleanup(backend: Backend, channel: { worker?: Worker; pending: number }): void {
	backend._disposeChannelization?.();
	backend._disposeChannelization = () => {
		channel.worker?.terminate();
		channel.worker = undefined;
		channel.pending = 0;
	};
}
