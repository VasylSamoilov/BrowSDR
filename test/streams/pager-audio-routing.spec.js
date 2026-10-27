import { describe, expect, it, vi, beforeEach } from 'vitest';

/*
 * Pager audio routing: each pager protocol is demodulated on its own
 * RX-bandwidth leg in the DSP worker and delivered as a tagged audio buffer.
 * decodeLocalPager must feed a tagged buffer to ONLY that protocol's decoder,
 * and an untagged (main VFO) buffer must decode nothing (it only tears a
 * decoder down when its protocol is disabled).
 */

const pocsagProcess = vi.fn();
const gscProcess = vi.fn();
const flexProcess = vi.fn();

vi.mock('@/worker/decoders/pocsag', () => ({
	POCSAGDecoder: class {
		process = pocsagProcess;
		setMode = vi.fn();
		setShowSecondGuess = vi.fn();
		setCharset = vi.fn();
		getStatus = vi.fn(() => ({}));
	},
}));
vi.mock('@/worker/decoders/golay', () => ({
	GSCDecoder: class {
		process = gscProcess;
		setShowSecondGuess = vi.fn();
		getStatus = vi.fn(() => ({}));
	},
}));
vi.mock('@/worker/decoders/flex/decoder', () => ({
	FlexDecoder: class {
		process = flexProcess;
		setCharset = vi.fn();
		getStatus = vi.fn(() => ({}));
	},
}));

import { decodeLocalPager } from '@/worker/streams/local-audio';

const PAGER_CB = { pocsag: vi.fn(), gsc: vi.fn(), flex: vi.fn() };

function makeParams() {
	return { freq: 160.5, mode: 'nfm', pocsag: true, gsc: true, flex: true };
}

beforeEach(() => {
	pocsagProcess.mockClear();
	gscProcess.mockClear();
	flexProcess.mockClear();
});

describe('pager audio routing', () => {
	it('feeds a pocsag-tagged buffer to only the POCSAG decoder', () => {
		const state = {};
		const out = new Float32Array(48);
		decodeLocalPager(PAGER_CB, makeParams(), state, 0, out, 'pocsag');
		expect(pocsagProcess).toHaveBeenCalledTimes(1);
		expect(gscProcess).not.toHaveBeenCalled();
		expect(flexProcess).not.toHaveBeenCalled();
	});

	it('feeds a flex-tagged buffer to only the FLEX decoder', () => {
		const state = {};
		const out = new Float32Array(48);
		decodeLocalPager(PAGER_CB, makeParams(), state, 0, out, 'flex');
		expect(flexProcess).toHaveBeenCalledTimes(1);
		expect(pocsagProcess).not.toHaveBeenCalled();
		expect(gscProcess).not.toHaveBeenCalled();
	});

	it('feeds a gsc-tagged buffer to only the GSC decoder', () => {
		const state = {};
		const out = new Float32Array(48);
		decodeLocalPager(PAGER_CB, makeParams(), state, 0, out, 'gsc');
		expect(gscProcess).toHaveBeenCalledTimes(1);
		expect(pocsagProcess).not.toHaveBeenCalled();
		expect(flexProcess).not.toHaveBeenCalled();
	});

	it('decodes nothing on the untagged main buffer', () => {
		const state = {};
		const out = new Float32Array(48);
		decodeLocalPager(PAGER_CB, makeParams(), state, 0, out, undefined);
		expect(pocsagProcess).not.toHaveBeenCalled();
		expect(gscProcess).not.toHaveBeenCalled();
		expect(flexProcess).not.toHaveBeenCalled();
	});

	it('tears a decoder down on the untagged sweep when its protocol is disabled', () => {
		const state = { pocsagDecoder: { process: pocsagProcess }, pocsagStatusAt: 123 };
		const params = { ...makeParams(), pocsag: false };
		const out = new Float32Array(48);
		decodeLocalPager(PAGER_CB, params, state, 0, out, undefined);
		expect(state.pocsagDecoder).toBeNull();
	});
});
