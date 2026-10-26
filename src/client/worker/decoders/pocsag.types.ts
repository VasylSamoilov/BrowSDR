/** POCSAG decoder message and status types. */

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
