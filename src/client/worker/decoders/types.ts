
/** Per-character decode confidence for GSC, parallel to a message's text. */
export const GSC_CHAR_OK = 0;
export const GSC_CHAR_CORRECTED = 1;
export const GSC_CHAR_UNCORRECTABLE = 2;

/** A decoded FLEX message (re-exported from the flex decoder for the callback
 * and app message chain, alongside GSCMessage/POCSAGMessage). */
export type { FlexMessage } from './flex/types';

/** A decoded GSC (Golay Sequential Code) message. GSC has a single Table VII
 * character set, so there is no charset/codepage field. */
export interface GSCMessage {
	protocol: 'gsc';
	/** 7-digit functional address: I G1 G0 A2 A1 A0 suffix. */
	address: string;
	/** Address number 1-4 (derived from the function bits). */
	addressNumber: number;
	type: 'alpha' | 'numeric' | 'tone' | 'voice';
	text: string;
	/** Per-character confidence parallel to text: 0 ok, 1 corrected, 2 bad. */
	charStatus: number[];
	/** Corrected error count (Golay/BCH corrections applied). */
	errorCount: number;
	/** Uncorrectable codeword count (FEC decode failed). */
	uncorrectableCount: number;
	/** Preamble index 0-9. */
	preambleIndex: number;
	/** For voice pages: 'start' when the voice alert batch is decoded, 'stop'
	 * when the transmission ends. Undefined for data/tone pages. */
	voiceEvent?: 'start' | 'stop';
	/** Why a voice page ended (on the 'stop' event): the activation (stop) code,
	 * a new preamble, silence (TX stopped), or the recording timeout. */
	voiceEndReason?: 'activation' | 'preamble' | 'silence' | 'timeout';
}

/** The set of reasons a GSC voice page can end. */
export type GSCVoiceEndReason = 'activation' | 'preamble' | 'silence' | 'timeout';

/** Live link status for a GSC VFO (sync / bit-error rate). */
export interface GSCStatus {
	synced: boolean;
	baud: number | null;
	ber: number | null;
	codewords: number;
}

/** GSC receiver sync state. */
export type GSCRxState = 'idle' | 'preamble' | 'collect' | 'voice';

/** FLEX receiver pipeline stage, surfaced for the live status bar. */
export type FlexRxStage = 'hunt' | 'sync1' | 'fiw' | 'sync2' | 'data';

/**
 * Live link status for a FLEX VFO. FLEX has a richer receiver state machine
 * than POCSAG/GSC: a PLL lock, a multi-stage sync pipeline (S1 -> FIW -> S2 ->
 * DATA), a selectable air mode (2/4FSK at 1600/3200 baud), signal polarity,
 * and running cycle/frame counters from the last decoded FIW.
 */
export interface FlexStatus {
	/** PLL symbol-timing lock. */
	locked: boolean;
	/** Current pipeline stage. */
	stage: FlexRxStage;
	/** Signal polarity: true when the air signal is inverted. */
	inverted: boolean;
	/** Air-mode label (e.g. "A4 (6400bps/4FSK)"), or null before sync. */
	mode: string | null;
	/** Data symbol rate in baud (1600 or 3200), or null before sync. */
	baud: number | null;
	/** Modulation levels: 2 (2FSK) or 4 (4FSK), or null before sync. */
	levels: number | null;
	/** Cycle number 0-14 from the last decoded FIW, or null. */
	cycle: number | null;
	/** Frame number 0-127 from the last decoded FIW, or null. */
	frame: number | null;
	/** Smoothed bit-error rate (0..1): errored bits (BCH-corrected + full
	 * codeword for uncorrectable) over received bits, or null before data. */
	ber: number | null;
	/** Simulcast local channel ID (9-bit, from BIW SSID1), or null. */
	localId: number | null;
	/** Coverage zone (5-bit, from BIW SSID1), or null. */
	coverageZone: number | null;
	/** Country code (from BIW SSID2), or null. */
	countryCode: number | null;
	/** SSID2 traffic-management flags (4-bit), or null. */
	tmf?: number | null;
	/** Network date "YYYY-MM-DD" from the last BIW DATE word, or null. */
	date: string | null;
	/** Network local time "HH:MM:SS" from the last BIW TIME word, or null. */
	time: string | null;
	/** Timezone offset from UTC in minutes (from BIW SysInfo TZ), or null. */
	tzOffsetMin: number | null;
	/** Daylight-saving active (from BIW SysInfo DST flag), or null. */
	dst?: boolean | null;
	/** Temporary-address (group) slots for the active polarity: 16 entries,
	 * each 'idle' | 'registered' | 'delivering', with target frame + members. */
	groupSlots?: Array<{ state: string; targetFrame: number; members: number[] }>;
	/** In-flight fragment reassembly buffers for the active polarity. */
	reasmBuffers?: number;
}
export type Rtl433Message =
	{ type: 'rtl433_event'; freq: number; event: Record<string, unknown> } | { type: 'rtl433_status'; freq?: number; status: Rtl433Status };

export interface Rtl433Protocol {
	id: number;
	name: string;
	disabled: boolean;
}

export interface Rtl433Status {
	state: 'off' | 'loading' | 'receiving' | 'error';
	message: string;
	sampleRate: number;
	samples: number;
	events: number;
	protocols?: Rtl433Protocol[];
}

export interface RtlModule {
	HEAPF32: Float32Array;
	_malloc(bytes: number): number;
	_free(ptr: number): void;
	stringToNewUTF8(text: string): number;
	UTF8ToString(ptr: number): string;
	_rtl433_init(rate: number, frequency: number, protocols: number): number;
	_rtl433_process(ptr: number, count: number): number;
	_rtl433_flush(): number;
	_rtl433_destroy(): void;
	_rtl433_protocol_count(): number;
	_rtl433_protocol_name(id: number): number;
	_rtl433_protocol_disabled(id: number): number;
}

export type RtlFactory = (options: {
	locateFile(path: string): string;
	onDecoded(json: string): void;
	print(): void;
	printErr(): void;
}) => Promise<RtlModule>;

export interface MbelibModule {
	HEAP8: Int8Array;
	HEAPF32: Float32Array;
	_malloc(this: void, size: number): number;
	_free(this: void, ptr: number): void;
	cwrap(name: string, result: 'number', args: ['number', 'number']): (frame: number, audio: number) => number;
	cwrap(name: string, result: null, args: []): () => void;
}

export type MbelibFactory = (options: { locateFile(path: string): string }) => Promise<MbelibModule>;

export interface SidebandState {
	ssbPhase?: number;
	agcGain?: number;
}

export interface RDSMessage {
	ps?: string;
	rt?: string;
	pi?: string;
	pty?: number;
	ptyLabel?: string;
	tp?: boolean;
	ta?: boolean;
}

/** Per-character decode confidence, parallel to a message's text. */
export const POCSAG_CHAR_OK = 0; // all source bits from clean codewords
export const POCSAG_CHAR_CORRECTED = 1; // at least one source bit BCH-corrected
export const POCSAG_CHAR_UNCORRECTABLE = 2; // at least one source bit from an uncorrectable codeword

export interface POCSAGMessage {
	capcode: number;
	func: number;
	type: 'alpha' | 'tone' | 'numeric';
	text: string;
	/**
	 * Per-character confidence, one entry per character of `text`:
	 * 0 = ok, 1 = corrected (BCH-repaired), 2 = uncorrectable (data was lost /
	 * placeholder). Lets the UI colour-code characters. Empty for tone pages.
	 */
	charStatus: number[];
	baud: number;
	/** Debug: content-detection scores (alpha vs numeric), when DEBUG build. */
	detectDebug?: string;
	/**
	 * Runner-up interpretation (the other of alpha/numeric), present only in
	 * auto mode when the "show second guess" option is on. The UI renders it
	 * dimmed beside the primary text.
	 */
	alt?: { type: 'alpha' | 'numeric'; text: string };
}

/** POCSAG type-detection mode. */
export type PocsagMode = 'auto' | 'alpha' | 'numeric';

/**
 * Live link status for a POCSAG VFO (sync / speed / polarity / bit-error rate).
 * Emitted periodically by the decoder for a glanceable UI readout, independent
 * of decoded messages.
 */
export interface POCSAGStatus {
	/** True while a sub-decoder is locked onto a batch (receiving data). */
	synced: boolean;
	/** Baud rate of the locked sub-decoder, or null when not synced. */
	baud: number | null;
	/** True when the locked signal is inverted polarity. */
	inverted: boolean;
	/**
	 * Rolling bit-error rate (0..1): BCH-corrected bits / total data bits over
	 * the recent window of codewords. null until enough codewords are seen.
	 */
	ber: number | null;
	/** Codewords observed in the current rolling window (for UI confidence). */
	codewords: number;
}
