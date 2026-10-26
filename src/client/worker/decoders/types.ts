
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
}
