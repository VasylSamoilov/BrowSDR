import type { PagerProtocol } from '@/worker/decoders/charsets';

export interface PagerState {
	panelOpen: boolean;
	log: PagerLogEntry[];
	/** Row filter in the panel: a protocol id or 'all'. */
	filter: PagerProtocol | 'all';
}

export type RdsStations = Record<
	number,
	{ ps: string; rt: string; pi: string; pty: number; ptyLabel: string; tp: boolean; ta: boolean; freq: string }
>;

export interface PagerLogEntry {
	/** Which pager protocol produced this message. */
	protocol: PagerProtocol;
	time: string;
	freq: string;
	vfoIndex: number;
	capcode: string;
	type: string;
	/** Function sub-address 0-3 (shown as A-D). POCSAG-specific; optional. */
	func?: number;
	text: string;
	/** Per-character decode status parallel to text: 0 ok, 1 corrected, 2 bad. */
	charStatus?: number[];
	baud?: number;
	detectDebug?: string;
	/** Runner-up interpretation (second guess), shown dimmed when enabled. */
	alt?: { type: 'alpha' | 'numeric'; text: string };
	/** GSC: corrected (FEC-repaired) codeword count for the message. */
	errorCount?: number;
	/** GSC: uncorrectable codeword count (decode failed) for the message. */
	uncorrectableCount?: number;
	/** GSC voice page lifecycle: 'start' / 'stop'. */
	voiceEvent?: 'start' | 'stop';
	/** GSC: why the voice page ended (on a 'stop' event). */
	voiceEndReason?: 'activation' | 'preamble' | 'silence' | 'timeout';
}

/** @deprecated Use PagerLogEntry. Kept as an alias during migration. */
export type PocsagLogEntry = PagerLogEntry;

export interface Rtl433LogEntry {
	time: string;
	freq: string;
	vfoIndex: number;
	event: Record<string, unknown>;
}

export interface RdsLogEntry {
	time: string;
	field: string;
	value: string;
	freq: string;
	vfoIndex: number;
}
