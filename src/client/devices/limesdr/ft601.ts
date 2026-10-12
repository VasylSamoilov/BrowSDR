/*
LimeSDR Mini (FT601) WebUSB link for BrowSDR
Copyright (c) 2026, jLynx <https://github.com/jLynx>

Based on LimeSuite (Apache 2.0) https://github.com/myriadrf/LimeSuite

All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
	Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
	Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the
	documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

/*
 * The LimeSDR Mini uses an FTDI FT601 USB3 bridge, not the Cypress FX3 of the
 * LimeSDR-USB. The LMS64C command framing (64-byte packets) is identical, but
 * the USB delivery differs:
 *
 *   FX3  (LimeSDR-USB):  control out EP 0x0F, control in EP 15, stream in EP 1.
 *   FT601 (LimeSDR Mini): control out EP 0x02, control in EP 0x82,
 *                         stream  out EP 0x03, stream  in EP 0x83,
 *                         and each pipe must be armed with a 20-byte
 *                         FT_SetStreamPipe / FT_FlushPipe control word written
 *                         to EP 0x01 before transfers on that pipe.
 *
 * (Endpoint numbers and the 20-byte pipe-control protocol come from LimeSuite's
 * ConnectionFT601.cpp.)
 *
 * The FT601 is a composite device exposing two interfaces; the data endpoints
 * live past interface 0, so this link claims every interface the device
 * presents rather than only interface 0.
 */

// FT601 endpoint addresses (full 8-bit addresses, direction bit included).
export const FT601_CTRL_WR = 0x02;
export const FT601_CTRL_RD = 0x82;
export const FT601_STREAM_WR = 0x03;
export const FT601_STREAM_RD = 0x83;
// Side-band pipe-control endpoint (bulk OUT) used to arm/flush a pipe.
export const FT601_PIPE_CTRL_EP = 0x01;

/** WebUSB transferIn/Out take the low 4 bits (endpoint number), not the full address. */
const epNum = (address: number): number => address & 0x0f;

/**
 * Enumerate and log the device's full interface / alternate / endpoint tree.
 * The Mini is composite, so this is the ground truth for which endpoints
 * WebUSB actually exposes after Zadig binding.
 */
export function describeUsbTree(dev: USBDevice): void {
	const cfg = dev.configuration;
	console.log(`FT601 USB descriptor: vid=${hex(dev.vendorId)} pid=${hex(dev.productId)}`);
	if (!cfg) {
		console.log('FT601: no active configuration');
		return;
	}
	for (const iface of cfg.interfaces) {
		for (const alt of iface.alternates) {
			console.log(
				`  interface ${iface.interfaceNumber} alt ${alt.alternateSetting} class=${alt.interfaceClass} (${alt.endpoints.length} endpoints)`,
			);
			for (const ep of alt.endpoints) {
				console.log(`    EP${ep.endpointNumber} ${ep.direction} ${ep.type} pktSize=${ep.packetSize}`);
			}
		}
	}
}

const hex = (n: number): string => '0x' + n.toString(16).padStart(4, '0');

/**
 * Claim every interface the device exposes. WebUSB only lets us transfer on
 * endpoints that belong to a claimed interface, and the FT601 data endpoints
 * are not on interface 0.
 */
export async function ft601ClaimAll(dev: USBDevice): Promise<void> {
	await dev.open();

	// Analog of LimeSuite's libusb_reset_device() in ConnectionFT601::Open(): it
	// re-initializes the FT601's 245-FIFO engine; without it the stream pipe can
	// arm yet never deliver. We reset on the opened-but-unclaimed device (WinUSB
	// and libusb both reject reset while an interface is claimed), then re-select
	// the configuration it clears. Non-standard WebUSB API — a failure is non-fatal
	// but logged distinctly so we can tell "reset ran" from "reset refused".
	if (typeof dev.reset === 'function') {
		try {
			await dev.reset();
			console.log('LimeSDR Mini: device.reset() OK (FT601 FIFO engine reinitialized)');
		} catch (error) {
			console.warn('LimeSDR Mini: device.reset() REFUSED — FT601 FIFO not reinitialized:', error instanceof Error ? error.message : String(error));
		}
	} else {
		console.warn('LimeSDR Mini: device.reset() not available in this browser');
	}

	if (!dev.configuration) await dev.selectConfiguration(1);
	const cfg = dev.configuration;
	if (!cfg) throw new Error('LimeSDR Mini: no USB configuration available');

	const claimed: number[] = [];
	for (const iface of cfg.interfaces) {
		try {
			await dev.claimInterface(iface.interfaceNumber);
			claimed.push(iface.interfaceNumber);
		} catch (error) {
			// A per-interface claim failure usually means only SOME interfaces were
			// bound to WinUSB by Zadig. Record and keep going so we can report
			// precisely which one is missing rather than failing blind.
			console.warn(`LimeSDR Mini: could not claim interface ${iface.interfaceNumber}:`, error);
		}
	}

	// The IQ stream endpoint (0x83 → endpoint number 3) lives on a data interface.
	// Find which interface exposes it and require that one to be claimed; if it is
	// not, WinUSB is bound to the wrong/too-few interfaces (common Zadig mistake:
	// binding only Interface 0). Fail now with an actionable message instead of
	// letting the stream time out 3 s later with no explanation.
	const dataIfaceNum = findStreamInterface(cfg);
	if (dataIfaceNum !== null && !claimed.includes(dataIfaceNum)) {
		throw new Error(
			`LimeSDR Mini: the IQ-stream interface (${dataIfaceNum}) is not claimable. The FT601 is a composite device; ` +
				'WinUSB must be bound to BOTH interfaces. In Zadig, enable Options → List All Devices, then install ' +
				'WinUSB on each "LimeSDR Mini (Interface 0)" and "(Interface 1)" entry, replug, and reconnect.',
		);
	}
	if (claimed.length === 0) {
		throw new Error(
			'LimeSDR Mini: no USB interface could be claimed. Install the WinUSB driver with Zadig (both interfaces) and replug.',
		);
	}
	console.log(`LimeSDR Mini: claimed interfaces [${claimed.join(', ')}], stream interface=${dataIfaceNum ?? 'unknown'}`);
}

/** Find the interface number whose default alt-setting exposes the FT601 IQ-stream
 *  input endpoint (address 0x83 → endpointNumber 3, direction 'in'). Returns null
 *  if no interface advertises it (unexpected descriptor). */
function findStreamInterface(cfg: USBConfiguration): number | null {
	const streamEpNum = FT601_STREAM_RD & 0x0f; // 0x83 → 3
	for (const iface of cfg.interfaces) {
		for (const ep of iface.alternate.endpoints) {
			if (ep.direction === 'in' && ep.endpointNumber === streamEpNum) return iface.interfaceNumber;
		}
	}
	return null;
}

/**
 * Flush an FT601 pipe. Two 20-byte control words to EP 0x01:
 *   word1: counter + [4]=ep        (select pipe)
 *   word2: counter + [4]=ep + [5]=0x03   (flush)
 * Mirrors LimeSuite ConnectionFT601::FT_FlushPipe exactly.
 */
export async function ft601FlushPipe(dev: USBDevice, counter: number, ep: number): Promise<number> {
	const w1 = new Uint8Array(20);
	writeCounter(w1, counter++);
	w1[4] = ep;
	await bulkOut(dev, FT601_PIPE_CTRL_EP, w1);

	const w2 = new Uint8Array(20);
	writeCounter(w2, counter++);
	w2[4] = ep;
	w2[5] = 0x03; // flush
	await bulkOut(dev, FT601_PIPE_CTRL_EP, w2);
	return counter;
}

/**
 * Set an FT601 stream pipe size. Two 20-byte control words to EP 0x01:
 *   word1: counter + [4]=ep                        (select pipe)
 *   word2: counter + [4]=ep + [5]=0x02 + [8..11]=size (set stream pipe size)
 * LimeSuite ConnectionFT601::FT_SetStreamPipe reuses ONE non-zeroed buffer, so
 * [4]=ep set in word1 persists into word2 — it must be set on both. `size` is
 * the FPGA data-packet size (not the USB transfer length).
 */
export async function ft601SetPipe(dev: USBDevice, counter: number, ep: number, size: number): Promise<number> {
	const w1 = new Uint8Array(20);
	writeCounter(w1, counter++);
	w1[4] = ep;
	await bulkOut(dev, FT601_PIPE_CTRL_EP, w1);

	// LimeSuite reuses one non-zeroed buffer, so [4]=ep carries over from w1.
	const w2 = new Uint8Array(20);
	writeCounter(w2, counter++);
	w2[4] = ep;
	w2[5] = 0x02; // SetStreamPipe
	w2[8] = size & 0xff;
	w2[9] = (size >> 8) & 0xff;
	w2[10] = (size >> 16) & 0xff;
	w2[11] = (size >> 24) & 0xff;
	await bulkOut(dev, FT601_PIPE_CTRL_EP, w2);
	return counter;
}

/**
 * Reset a stream pipe the way LimeSuite ResetStreamBuffers does: flush then
 * re-arm with the FPGA data-packet size. Returns the advanced USB counter.
 */
export async function ft601ResetStreamPipe(dev: USBDevice, counter: number, ep: number, packetSize: number): Promise<number> {
	counter = await ft601FlushPipe(dev, counter, ep);
	counter = await ft601SetPipe(dev, counter, ep, packetSize);
	return counter;
}

function writeCounter(buf: Uint8Array, counter: number): void {
	buf[0] = counter & 0xff;
	buf[1] = (counter >> 8) & 0xff;
	buf[2] = (counter >> 16) & 0xff;
	buf[3] = (counter >> 24) & 0xff;
}

async function bulkOut(dev: USBDevice, address: number, data: Uint8Array<ArrayBuffer>): Promise<void> {
	const result = await dev.transferOut(epNum(address), data);
	if (result.status !== 'ok' || result.bytesWritten !== data.length) {
		throw new Error(`FT601: pipe-control write failed on EP${hex(address)} (status=${result.status}, bytes=${result.bytesWritten})`);
	}
}

/** Write a 64-byte LMS64C control packet to the FT601 control-out pipe. */
export async function ft601ControlWrite(dev: USBDevice, pkt: Uint8Array<ArrayBuffer>): Promise<void> {
	const result = await dev.transferOut(epNum(FT601_CTRL_WR), pkt);
	if (result.status !== 'ok' || result.bytesWritten !== pkt.length) {
		throw new Error(`FT601: control write failed (status=${result.status}, bytes=${result.bytesWritten})`);
	}
}

/** Read a 64-byte LMS64C response from the FT601 control-in pipe. */
export async function ft601ControlRead(dev: USBDevice): Promise<Uint8Array> {
	const result = await dev.transferIn(epNum(FT601_CTRL_RD), 64);
	if (result.status !== 'ok' || !result.data) {
		throw new Error(`FT601: control read failed (status=${result.status})`);
	}
	return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
}
