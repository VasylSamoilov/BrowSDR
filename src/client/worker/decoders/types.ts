
/** Pager protocol message/status types. Re-exported here so the many existing
 * `@/worker/decoders/types` importers keep working; the definitions now live in
 * each protocol's own file (POCSAG and GSC as peers of the FLEX module). */
export {
	GSC_CHAR_OK,
	GSC_CHAR_CORRECTED,
	GSC_CHAR_UNCORRECTABLE,
} from './gsc.types';
export type { GSCMessage, GSCVoiceEndReason, GSCStatus, GSCRxState } from './gsc.types';
export {
	POCSAG_CHAR_OK,
	POCSAG_CHAR_CORRECTED,
	POCSAG_CHAR_UNCORRECTABLE,
} from './pocsag.types';
export type { POCSAGMessage, PocsagMode, POCSAGStatus } from './pocsag.types';
export type { FlexMessage } from './flex/types';
export type { FlexRxStage, FlexStatus } from './flex/types';

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
	// Group 1A
	ecc?: number;           // Extended Country Code (0x00-0xFF)
	countryName?: string;   // Resolved from PI+ECC (region-dependent)
	lic?: number;           // Language Identification Code
	languageName?: string;  // Resolved LIC name
	pin?: number;           // Programme Item Number (scheduled time, raw 16-bit)
	pinDay?: number;        // PIN decoded day-of-month (1-31)
	pinHour?: number;       // PIN decoded hour (0-23)
	pinMinute?: number;     // PIN decoded minute (0-59)
	hasTmc?: boolean;       // TMC service detected (Group 1A variant 1)
	// Group 3A (ODA)
	odaAid?: number;        // Open Data Application ID registered on a group
	odaGroup?: number;      // Group number carrying this ODA (0-15)
	odaVersion?: number;    // Group version (0=A, 1=B)
	// Group 4A (CT)
	ct?: string;            // Clock time formatted "YYYY-MM-DD HH:MM" local
	ctUtcOffset?: number;   // UTC offset in half-hours (signed)
	// Group 5-9, 11-13 ODA data — raw for paging / TMC consumers
	odaData?: { group: number; version: number; b: number; c: number; d: number };
	// Group 10A (PTYN)
	ptyn?: string;          // Programme Type Name (8 chars free text)
	// Group 14A (EON)
	eon?: { pi: string; ps?: string; tp: boolean; ta: boolean; af?: number[] };
	// Group 3A RT+ ODA (AID 0x4BD7) and Group 11A RT+ data
	rtPlusItem1?: string;   // Now-playing tag 1 text (e.g. artist)
	rtPlusItem1Tag?: number;
	rtPlusItem2?: string;   // Now-playing tag 2 text (e.g. title)
	rtPlusItem2Tag?: number;
	// Group 0A AF list
	af?: number[];          // Alternative frequencies in kHz
	// Paging (ODA AID 0x3DC5 / Group 1A pager variant / Group 7A)
	paging?: { address: number; functionBits: number; data: string };
}
