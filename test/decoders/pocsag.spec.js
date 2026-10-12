import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { POCSAGDecoder } from '@/worker/decoders/pocsag';

/*
 * Capture-based regression tests for the POCSAG decoder.
 *
 * Fixtures are the multimon-ng BCH reference captures (GPLv2,
 * multimon-ng/test/samples/bch_reference). Each is raw signed 16-bit
 * little-endian mono at 22050 Hz, holding the FM-demodulated NRZ baseband
 * (the same signal multimon-ng's demod slices at zero). We feed it to the
 * decoder as Float32 at the capture's native rate.
 *
 * Ground-truth decode (verified with the real multimon-ng binary):
 *   pocsag_clean      cap 111111 func 3  "POCSAG_REF_CLEAN"
 *   pocsag_1bit       cap 222222 func 3  "POCSAG_REF_1BIT"   (1 bit error / codeword)
 *   pocsag_2bit       cap 333333 func 3  "POCSAG_REF_2BIT"   (2 bit errors / codeword)
 *   pocsag_inv_clean  cap 444444 func 3  "POCSAG_INV_CLEAN"  (inverted polarity)
 *   pocsag_inv_1bit   cap 555555 func 3  "POCSAG_INV_1BIT"   (inverted + 1 bit)
 *   pocsag_inv_2bit   cap 666666 func 3  "POCSAG_INV_2BIT"   (inverted + 2 bit)
 */

const CAPTURE_RATE = 22050;
const FIXTURES = dirname(fileURLToPath(import.meta.url)) + '/../fixtures/pocsag';

/** Load an int16 LE mono .raw capture as normalised Float32. */
function loadCapture(name) {
	const buf = readFileSync(join(FIXTURES, name));
	const i16 = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
	const f32 = new Float32Array(i16.length);
	// The multimon-ng .raw fixtures are FM-demod baseband in the standard POCSAG
	// sign convention (mark = negative deviation). BrowSDR's slicer now matches
	// that convention, so the fixtures feed in directly and the decoder's
	// normal/inverted label agrees with multimon-ng's own detection.
	for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
	return f32;
}

/** Run a whole capture through a fresh decoder, returning the emitted messages. */
function decodeCapture(name) {
	const msgs = [];
	const dec = new POCSAGDecoder(CAPTURE_RATE, (m) => msgs.push(m));
	const samples = loadCapture(name);
	// Feed in realistic worker-sized chunks to exercise cross-chunk state.
	const CHUNK = 4096;
	for (let off = 0; off < samples.length; off += CHUNK) {
		dec.process(samples.subarray(off, Math.min(off + CHUNK, samples.length)));
	}
	return msgs;
}

const CASES = [
	{ file: 'pocsag_clean.raw', capcode: 111111, text: 'POCSAG_REF_CLEAN' },
	{ file: 'pocsag_1bit.raw', capcode: 222222, text: 'POCSAG_REF_1BIT' },
	{ file: 'pocsag_2bit.raw', capcode: 333333, text: 'POCSAG_REF_2BIT' },
	{ file: 'pocsag_inv_clean.raw', capcode: 444444, text: 'POCSAG_INV_CLEAN' },
	{ file: 'pocsag_inv_1bit.raw', capcode: 555555, text: 'POCSAG_INV_1BIT' },
	{ file: 'pocsag_inv_2bit.raw', capcode: 666666, text: 'POCSAG_INV_2BIT' },
];

describe('POCSAG decoder — multimon-ng BCH reference captures', () => {
	for (const c of CASES) {
		it(`decodes ${c.file} → cap ${c.capcode} "${c.text}"`, () => {
			const msgs = decodeCapture(c.file);
			const hit = msgs.find((m) => m.capcode === c.capcode);
			expect(hit, `no message with capcode ${c.capcode}; got ${JSON.stringify(msgs)}`).toBeTruthy();
			expect(hit.func).toBe(3);
			expect(hit.type).toBe('alpha');
			// Decoder trims trailing NUL/fill; compare on the printable payload.
			expect(hit.text).toContain(c.text);
		});
	}
});


/**
 * Decode a capture, sampling status after every chunk, and return the "peak"
 * status — the locked snapshot with the most codewords seen. This mirrors what
 * the live decoder emits on its 500 ms throttle WHILE audio is flowing, rather
 * than the idle snapshot at end-of-capture after lock is naturally dropped.
 */
function statusAfter(name) {
	const dec = new POCSAGDecoder(CAPTURE_RATE, () => {});
	const samples = loadCapture(name);
	const CHUNK = 4096;
	let peak = dec.getStatus();
	for (let off = 0; off < samples.length; off += CHUNK) {
		dec.process(samples.subarray(off, Math.min(off + CHUNK, samples.length)));
		const s = dec.getStatus();
		if (s.synced && s.codewords >= (peak.synced ? peak.codewords : -1)) peak = s;
		else if (!peak.synced && s.codewords > peak.codewords) peak = s;
	}
	return peak;
}

describe('POCSAG decoder — link status (sync / speed / inversion / BER)', () => {
	it('reports 1200 Bd, NORMAL polarity and BER on the clean capture', () => {
		// Standard sense (multimon-ng/osmocom-analog): normal polarity means the
		// sync word is received directly (not bit-inverted). multimon-ng's own
		// decoder reports this capture as normal.
		const s = statusAfter('pocsag_clean.raw');
		expect(s.baud).toBe(1200);
		expect(s.inverted).toBe(false);
		expect(s.ber).not.toBeNull();
		expect(s.codewords).toBeGreaterThan(0);
	});

	it('reports INVERTED polarity on the inverted capture', () => {
		// multimon-ng detects this capture as "inverted polarity"; our label
		// must agree with that standard sense.
		const s = statusAfter('pocsag_inv_clean.raw');
		expect(s.baud).toBe(1200);
		expect(s.inverted).toBe(true);
	});

	it('BER rises with injected bit errors (clean < 1bit < 2bit)', () => {
		const clean = statusAfter('pocsag_clean.raw').ber;
		const oneBit = statusAfter('pocsag_1bit.raw').ber;
		const twoBit = statusAfter('pocsag_2bit.raw').ber;
		// Monotonic with the injected error count — the captures are named for
		// how many bit errors per codeword were injected.
		expect(clean).toBeLessThanOrEqual(oneBit);
		expect(oneBit).toBeLessThanOrEqual(twoBit);
		expect(twoBit).toBeGreaterThan(0);
	});
});

describe('POCSAG decoder — per-character status', () => {
	it('emits charStatus parallel to text, all OK on the clean capture', () => {
		const msgs = decodeCapture('pocsag_clean.raw');
		const hit = msgs.find((m) => m.capcode === 111111);
		expect(hit).toBeTruthy();
		// One status entry per rendered character.
		expect(hit.charStatus).toHaveLength(hit.text.length);
		// Clean capture → no character should be flagged uncorrectable (2).
		expect(hit.charStatus.every((s) => s !== 2)).toBe(true);
	});

	it('flags corrected characters on the 2-bit-error capture', () => {
		const msgs = decodeCapture('pocsag_2bit.raw');
		const hit = msgs.find((m) => m.capcode === 333333);
		expect(hit).toBeTruthy();
		expect(hit.charStatus).toHaveLength(hit.text.length);
		// The payload codewords carry 2 injected bit errors each → at least one
		// character must be marked corrected (1). It still decodes correctly
		// because BCH repairs 2-bit errors.
		expect(hit.charStatus.some((s) => s === 1)).toBe(true);
	});
});

/*
 * Content-based message-type detection.
 *
 * The POCSAG function field is a sub-address, NOT a reliable encoding
 * indicator (ITU-R M.584 / osmocom-analog frame.c). The decoder must pick the
 * encoding by scoring the decoded content, so an alphanumeric page on func 0/1
 * is read as text and a numeric page on func 0 is read as digits — regardless
 * of the function bits.
 *
 * We synthesise valid batches directly through the decoder's bit interface,
 * computing BCH + even parity via the decoder's OWN ecc (a codeword is valid
 * iff _eccCorrect reports 0 errors), so the frames are guaranteed decodable.
 */
import { _POCSAGSingleBaud } from '@/worker/decoders/pocsag';

/** Build a valid 32-bit codeword: 21-bit payload (type bit + 20 data) + BCH + even parity. */
function buildCodeword(payload21) {
	const dec = new _POCSAGSingleBaud(48000, 1200, () => {});
	// Place the 21-bit payload at bits 31..11, brute-force the 10 BCH bits
	// (bits 10..1) by asking the decoder's own ECC for a zero-error result,
	// then set the even-parity bit (bit 0).
	const base = (payload21 >>> 0) << 11;
	for (let ecc = 0; ecc < 1024; ecc++) {
		let cw = (base | (ecc << 1)) >>> 0;
		// Set even parity over the full 32 bits, then ask the decoder's own ECC
		// to confirm the word is valid. The decoder's correction is parity-aware
		// (osmocom-style), so a valid codeword must satisfy BCH AND parity.
		if (dec._popcount32(cw) & 1) cw = (cw | 1) >>> 0;
		const r = dec._eccCorrect(cw);
		if (r.errors === 0 && r.cw === cw) {
			return cw >>> 0;
		}
	}
	throw new Error('no valid BCH codeword found for payload');
}

/** Drive a list of 32-bit codewords through a sub-decoder as one batch. */
function decodeBatch(func, bodyCodewords) {
	const msgs = [];
	const dec = new _POCSAGSingleBaud(48000, 1200, (m) => msgs.push(m));
	// Address codeword: type bit 0, func in bits 12..11 of payload, placed at
	// frame slot 0 (cwIdx 0). payload21 layout: [type:1][addrHigh:18][func:2].
	const addrPayload = ((0 << 20) | (0x155 << 2) | (func & 3)) >>> 0;
	const addrCw = buildCodeword(addrPayload);
	// Feed sync, then address at cwIdx 0, then body, then IDLE to flush.
	dec._onSync();
	dec._onCodeword(addrCw);
	for (const cw of bodyCodewords) dec._onCodeword(cw);
	dec._onCodeword(_POCSAGSingleBaud.IDLE_CW);
	return msgs;
}

/** Encode an alpha string into message codewords (7-bit LSB-first, type bit 1). */
function alphaCodewords(text) {
	const bits = [];
	for (const ch of text) {
		const c = ch.charCodeAt(0) & 0x7f;
		for (let b = 0; b < 7; b++) bits.push((c >> b) & 1);
	}
	while (bits.length % 20) bits.push(0);
	const cws = [];
	for (let i = 0; i < bits.length; i += 20) {
		let data = 0;
		for (let b = 0; b < 20; b++) data = (data << 1) | bits[i + b];
		cws.push(buildCodeword(((1 << 20) | data) >>> 0));
	}
	return cws;
}

/** Encode a numeric string into message codewords (4-bit LSB-first, type bit 1). */
function numericCodewords(digits) {
	const NMAP = '0123456789RU -][';
	const bits = [];
	for (const ch of digits) {
		const n = NMAP.indexOf(ch);
		for (let b = 0; b < 4; b++) bits.push((n >> b) & 1);
	}
	while (bits.length % 20) bits.push(0);
	const cws = [];
	for (let i = 0; i < bits.length; i += 20) {
		let data = 0;
		for (let b = 0; b < 20; b++) data = (data << 1) | bits[i + b];
		cws.push(buildCodeword(((1 << 20) | data) >>> 0));
	}
	return cws;
}

describe('POCSAG decoder — content-based type detection', () => {
	it('reads an alphanumeric page sent on func 0 as text (not tone/numeric)', () => {
		const msgs = decodeBatch(0, alphaCodewords('HELLO'));
		expect(msgs.length).toBeGreaterThan(0);
		const m = msgs[0];
		expect(m.func).toBe(0); // func is preserved as metadata
		expect(m.type).toBe('alpha'); // but type is chosen by content
		expect(m.text).toContain('HELLO');
	});

	it('reads an alphanumeric page sent on func 1 as text', () => {
		const msgs = decodeBatch(1, alphaCodewords('PAGE'));
		expect(msgs.length).toBeGreaterThan(0);
		expect(msgs[0].type).toBe('alpha');
		expect(msgs[0].text).toContain('PAGE');
	});

	it('reads a numeric page sent on func 0 as digits (not dropped as tone)', () => {
		const msgs = decodeBatch(0, numericCodewords('0123456789'));
		expect(msgs.length).toBeGreaterThan(0);
		const m = msgs[0];
		expect(m.type).toBe('numeric');
		expect(m.text).toContain('0123456789');
	});
});

/*
 * Codepage selection. The same 7-bit codes map to different glyphs depending
 * on the selected pager codepage. We drive synthetic alpha batches through the
 * sub-decoder with a chosen charset and assert the vendor/national glyphs.
 */
import { pocsagCodepage, POCSAG_CHARSETS } from '@/worker/decoders/charsets';

/** Decode a synthetic alpha batch under a given charset key. */
function decodeAlphaWithCharset(text, charset) {
	const msgs = [];
	const dec = new _POCSAGSingleBaud(48000, 1200, (m) => msgs.push(m), charset);
	const addrPayload = ((0 << 20) | (0x155 << 2) | 3) >>> 0;
	dec._onSync();
	dec._onCodeword(buildCodeword(addrPayload));
	for (const cw of alphaCodewords(text)) dec._onCodeword(cw);
	dec._onCodeword(_POCSAGSingleBaud.IDLE_CW);
	return msgs[0];
}

describe('POCSAG decoder — codepage selection', () => {
	it('registers 26 identities over 19 unique tables', () => {
		expect(POCSAG_CHARSETS).toHaveLength(26);
		const tableIds = new Set(POCSAG_CHARSETS.map((e) => e.tableId));
		expect(tableIds.size).toBe(19);
	});

	it('German codepage maps [ \\ ] { | } ~ to umlauts', () => {
		const cp = pocsagCodepage({ vendor: 'generic', model: 'generic', codepage: 'latin-german' });
		expect(cp[0x5b]).toBe('Ä');
		expect(cp[0x5c]).toBe('Ö');
		expect(cp[0x5d]).toBe('Ü');
		expect(cp[0x7b]).toBe('ä');
		expect(cp[0x7e]).toBe('ß');
		expect(cp[0x40]).toBe('§');
	});

	it('ASCII codepage keeps [ \\ ] as brackets', () => {
		const cp = pocsagCodepage({ vendor: 'generic', model: 'generic', codepage: 'ascii' });
		expect(cp[0x5b]).toBe('[');
		expect(cp[0x7e]).toBe('~');
	});

	it('unknown charset key falls back to ASCII', () => {
		const cp = pocsagCodepage({ vendor: 'nope', model: 'nope', codepage: 'nope' });
		expect(cp[0x41]).toBe('A');
		expect(cp[0x5b]).toBe('[');
	});

	it('decodes the same bytes to German glyphs under the German codepage', () => {
		// A letter-heavy string so content-scoring picks alpha; the chars [ \\ ]
		// (codes 0x5B 0x5C 0x5D) render as Ä Ö Ü under the German codepage and
		// stay brackets under ASCII.
		const text = 'STRASSE[\\]ENDE';
		const ascii = decodeAlphaWithCharset(text, { vendor: 'generic', model: 'generic', codepage: 'ascii' });
		const german = decodeAlphaWithCharset(text, { vendor: 'generic', model: 'generic', codepage: 'latin-german' });
		expect(ascii.text).toContain('[');
		expect(ascii.text).toContain('STRASSE');
		expect(german.text).toContain('Ä');
		expect(german.text).toContain('Ö');
		expect(german.text).toContain('Ü');
		expect(german.text).toContain('STRASSE');
	});
});
