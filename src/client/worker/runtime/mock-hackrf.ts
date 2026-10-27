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

import type { SdrDevice, SdrDeviceInfo, GainControl } from '@/radio/types';

export class MockHackRF implements SdrDevice {
	readonly deviceType = 'mock';
	readonly sampleRates = [2000000, 4000000, 5000000, 8000000, 10000000, 16000000, 20000000];
	readonly sampleFormat = 'int8' as const;
	readonly gainControls: GainControl[] = [
		{ name: 'LNA', min: 0, max: 40, step: 8, default: 16, type: 'slider' },
		{ name: 'VGA', min: 0, max: 62, step: 2, default: 16, type: 'slider' },
		{ name: 'Amp', min: 0, max: 1, step: 1, default: 0, type: 'checkbox' },
	];

	private running = false;
	private sampleRate = 2000000;
	private phase = 0;
	private thread: ReturnType<typeof setInterval> | null = null;

	async open(_device?: USBDevice): Promise<void> {
		/* no real device */
	}

	async close(): Promise<void> {
		await this.stopRx();
	}

	getInfo(): Promise<SdrDeviceInfo> {
		return Promise.resolve({ name: 'Mock SDR (Signal Gen)', firmware: 'Mock Firmware V1' });
	}

	setSampleRate(rate: number): Promise<void> {
		this.sampleRate = rate;

		return Promise.resolve();
	}
	async setFrequency(_freqHz: number): Promise<void> {}
	async setGain(_name: string, _value: number): Promise<void> {}

	startRx(callback: (data: ArrayBufferView) => void): Promise<void> {
		this.running = true;
		this.thread = setInterval(
			() => {
				if (!this.running) return;
				const chunkSize = 262144;
				const buffer = new ArrayBuffer(chunkSize);
				const view = new Int8Array(buffer);
				// Generate a 100 kHz tone relative to center freq + noise
				const toneFreq = 100000;
				const phaseInc = (2 * Math.PI * toneFreq) / this.sampleRate;
				for (let i = 0; i < chunkSize / 2; i++) {
					this.phase += phaseInc;
					if (this.phase > Math.PI * 2) this.phase -= Math.PI * 2;
					const i_val = Math.cos(this.phase) * 50 + (Math.random() - 0.5) * 20;
					const q_val = Math.sin(this.phase) * 50 + (Math.random() - 0.5) * 20;
					view[i * 2] = i_val;
					view[i * 2 + 1] = q_val;
				}
				callback(new Uint8Array(buffer, 0, chunkSize));
			},
			(262144 / 2 / this.sampleRate) * 1000,
		);

		return Promise.resolve();
	}

	stopRx(): Promise<void> {
		this.running = false;
		if (this.thread) {
			clearInterval(this.thread);
			this.thread = null;
		}

		return Promise.resolve();
	}
}
