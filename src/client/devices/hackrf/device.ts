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

import { HackRF } from './usb';
import type { SdrDevice, SdrDeviceInfo, GainControl } from '@/radio/types';
import { registerDriver } from '@/radio/sdr-device';
import { HackRFRxLevel } from './rx-level';

export class HackRFDevice implements SdrDevice {
	readonly deviceType = 'hackrf';
	readonly sampleRates = [2000000, 4000000, 5000000, 8000000, 10000000, 16000000, 20000000];
	readonly sampleFormat = 'int8' as const;
	readonly gainControls: GainControl[] = [
		{ name: 'LNA', min: 0, max: 40, step: 8, default: 16, type: 'slider' },
		{ name: 'VGA', min: 0, max: 62, step: 2, default: 16, type: 'slider' },
		{ name: 'Amp (14dB)', min: 0, max: 1, step: 1, default: 0, type: 'checkbox' },
	];

	private hackrf = new HackRF();
	private rxLevel = new HackRFRxLevel();
	getRxLevel() {
		return this.rxLevel.level;
	}

	async open(device: USBDevice): Promise<void> {
		await this.hackrf.open(device);
	}

	async close(): Promise<void> {
		await this.hackrf.close();
		await this.hackrf.exit();
		this.rxLevel.reset();
	}

	async getInfo(): Promise<SdrDeviceInfo> {
		const boardId = await this.hackrf.readBoardId();
		const versionString = await this.hackrf.readVersionString();
		const { serialNo, partId } = await this.hackrf.readPartIdSerialNo();
		const name = HackRF.BOARD_ID_NAME.get(boardId) || 'Unknown HackRF';
		const serial = serialNo.map((i: number) => (i + 0x100000000).toString(16).slice(1)).join('');

		// Log additional info
		const apiVersion = await this.hackrf.readApiVersion();
		const [apiMajor, apiMinor, apiSubminor] = apiVersion;
		const bcdVersion = (apiMajor << 8) | (apiMinor << 4) | apiSubminor;
		const info: SdrDeviceInfo = {
			name,
			serial,
			firmware: versionString,
			boardId,
			partId: partId.map((value) => value.toString(16).padStart(8, '0')).join(''),
			apiVersion: `${apiMajor}.${String(apiMinor) + String(apiSubminor)}`,
		};
		console.log(`Board ID: ${boardId} (${name})`);
		console.log(`Firmware: ${versionString} (API:${apiMajor}.${String(apiMinor) + String(apiSubminor)})`);
		console.log(`Serial: ${serial}`);

		if (bcdVersion >= 0x0106 && (boardId === 2 || boardId === 4 || boardId === 5)) {
			try {
				const boardRev = await this.hackrf.boardRevRead();
				const revName = HackRF.BOARD_REV_NAME.get(boardRev);
				info.hardware = revName ?? `Unknown (${boardRev})`;
				if (revName) console.log(`Hardware Revision: ${revName}`);
			} catch (_) {
				/* not supported */
			}
		}

		return info;
	}

	async setSampleRate(rate: number): Promise<void> {
		await this.hackrf.setSampleRateManual(rate, 1);
		await this.hackrf.setBasebandFilterBandwidth(HackRF.computeBasebandFilterBw(rate));
	}

	async setFrequency(freqHz: number): Promise<void> {
		await this.hackrf.setFreq(freqHz);
	}

	async setGain(name: string, value: number): Promise<void> {
		switch (name) {
			case 'LNA':
				await this.hackrf.setLnaGain(value);
				break;
			case 'VGA':
				await this.hackrf.setVgaGain(value);
				break;
			case 'Amp (14dB)':
				await this.hackrf.setAmpEnable(!!value);
				break;
			default:
				console.warn(`HackRF: unknown gain "${name}"`);
		}
	}

	async setBandwidth(bwHz: number): Promise<void> {
		await this.hackrf.setBasebandFilterBandwidth(bwHz);
	}

	async startRx(callback: (data: ArrayBufferView) => void): Promise<void> {
		this.rxLevel.reset();
		let firstSample: () => void;
		let timeout: ReturnType<typeof setTimeout>;
		const started = new Promise<void>((resolve, reject) => {
			firstSample = resolve;
			timeout = setTimeout(
				() => reject(new Error('HackRF returned no USB samples. Reconnect it and close other applications using it.')),
				5000,
			);
		});
		// Attach the rejection handler before USB commands, which may themselves fail.
		started.catch(() => {});
		try {
			await this.hackrf.startRx((data) => {
				this.rxLevel.observe(data);
				callback(data);
				firstSample();
			});
			await started;
		} catch (error) {
			await this.hackrf.stopRx();
			throw error;
		} finally {
			clearTimeout(timeout!);
		}
	}

	async stopRx(): Promise<void> {
		await this.hackrf.stopRx();
		this.rxLevel.reset();
	}
}

// USB VID/PID filters for HackRF devices
const HACKRF_FILTERS: USBDeviceFilter[] = [
	{ vendorId: 0x1d50, productId: 0x604b },
	{ vendorId: 0x1d50, productId: 0x6089 },
	{ vendorId: 0x1d50, productId: 0xcc15 },
	{ vendorId: 0x1fc9, productId: 0x000c },
];

registerDriver({
	type: 'hackrf',
	name: 'HackRF',
	filters: HACKRF_FILTERS,
	create: () => new HackRFDevice(),
});
