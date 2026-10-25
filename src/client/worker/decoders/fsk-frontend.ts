/**
 * Shared NFM / 2-FSK bit-recovery front end for pager decoders.
 *
 * Extracted verbatim from the POCSAG decoder's signal path so GSC (and later
 * FLEX) reuse the same, proven bit recovery instead of duplicating it. It takes
 * FM-demodulated Float32 audio (the FM discriminator itself lives upstream in
 * the Rust/WASM DSP, shared by every NFM decoder) and emits one hard bit per
 * symbol via a callback. Everything above the bit stream — sync acquisition,
 * FEC, framing, charset — stays protocol-specific in each decoder.
 *
 * What it owns:
 *   - adaptive, unclamped DC removal (gain-independent slicing),
 *   - a zero-crossing timing PLL that centres sampling in each symbol,
 *   - the mid-symbol-crossing count (`nonconsec`) and PLL-lock flag that a
 *     decoder's sync logic reads to reject wrong-baud candidates.
 *
 * Bit convention matches POCSAG/GSC 2-FSK: mark ("1") = negative deviation, so
 * a sample below zero is bit 1.
 */
export class FskBitSlicer {
	/** Samples per bit = audioRate / baud. */
	readonly spb: number;
	private readonly onBit: (bit: number) => void;

	// ── DC removal ──
	private dcLevel = 0;
	/** DC-removal time constant fixed in BIT units (~64 bits), so it is
	 * identical at every baud. Scaling by spb keeps it slow at all rates. */
	private readonly dcAlpha: number;

	// ── PLL / timing ──
	/** PLL lock state (drives the timing gain). Read and set by the decoder's
	 * sync logic, so it is public. */
	pllLocked = false;
	private pllTimeout = 0;
	/** Mid-symbol crossings within the current symbol. High on a wrong-baud
	 * signal → a decoder uses it to block false sync acquisition. Public so the
	 * sync logic can read it. */
	nonconsec = 0;
	private clockPhase = 0;
	private lastSample = 0;

	constructor(audioRate: number, baud: number, onBit: (bit: number) => void) {
		this.spb = audioRate / baud;
		this.dcAlpha = 1 / (64 * this.spb);
		this.onBit = onBit;
	}

	reset(): void {
		this.dcLevel = 0;
		this.pllLocked = false;
		this.pllTimeout = 0;
		this.nonconsec = 0;
		this.clockPhase = 0;
		this.lastSample = 0;
	}

	/**
	 * Adaptive DC removal. Tracks the signal DC continuously with an unclamped
	 * IIR so the zero-crossing slicer stays gain-independent (an absolute clamp
	 * in signal units caps the correctable offset, so at high gain a real DC
	 * offset leaks through and biases the slice). The estimate must be allowed
	 * to converge to the ACTUAL offset even before lock — pulling it toward 0
	 * on every unlocked sample stops it cancelling a steady offset and blocks
	 * acquisition of a DC-offset page. The IIR time constant alone keeps a
	 * transient glitch from parking a large stale offset. Returns the
	 * DC-removed sample.
	 */
	private removeDc(x: number): number {
		this.dcLevel += this.dcAlpha * (x - this.dcLevel);
		return x - this.dcLevel;
	}

	/** Feed a block of FM-demodulated samples; emits bits via the callback. */
	process(samples: Float32Array): void {
		const spb = this.spb;
		const spbHalf = spb * 0.5;

		for (let i = 0; i < samples.length; i++) {
			const s = this.removeDc(samples[i]);

			// Zero-crossing timing PLL: nudge the clock so transitions land at
			// the symbol midpoint (spbHalf), i.e. bit centres at phase 0/spb.
			if (this.lastSample < 0 !== s < 0) {
				let err = this.clockPhase - spbHalf;
				if (err > spbHalf) err -= spb;
				if (err < -spbHalf) err += spb;
				// Crossing-quality (in our phase convention):
				// a GOOD transition lands near the expected point (spbHalf, small
				// |err|). A crossing far from it — near the bit CENTRE at 0/spb —
				// is a mid-symbol transition that shouldn't exist at the correct
				// baud rate. Count those within a symbol; a wrong-rate signal
				// produces many, which blocks sync acquisition in the decoder.
				if (Math.abs(err) < spb * 0.25) this.nonconsec = 0;
				else this.nonconsec++;
				// Hard-gate: ignore corrections larger than 40% of a bit period.
				if (Math.abs(err) < spb * 0.4) {
					const rate = this.pllLocked ? 0.045 : 0.05;
					this.clockPhase -= err * rate;
				}
				this.pllTimeout = 0;
			}
			this.lastSample = s;

			// Sample at the bit centre (phase wrap). 2-FSK mark ("1") = negative
			// deviation, so s < 0 → 1.
			if (++this.clockPhase >= spb) {
				this.clockPhase -= spb;
				const bit = s < 0 ? 1 : 0;
				// PLL timeout: grows each symbol with no crossing; too many in a
				// row → treat the PLL as unlocked (back to the faster gain).
				if (++this.pllTimeout > 100) this.pllLocked = false;
				this.nonconsec = 0;
				this.onBit(bit);
			}
		}
	}
}

/**
 * Rolling bit-error-rate accumulator over a decaying window of codewords,
 * extracted from POCSAG so GSC/FLEX report BER the same way. `add(errorBits,
 * payloadBits)` per decoded codeword; the window halves once it fills, giving
 * an exponentially-decaying recent average.
 */
export class BerWindow {
	private errBits = 0;
	private totalBits = 0;
	private codewords = 0;

	reset(): void {
		this.errBits = 0;
		this.totalBits = 0;
		this.codewords = 0;
	}

	add(errorBits: number, payloadBits: number): void {
		this.errBits += errorBits;
		this.totalBits += payloadBits;
		this.codewords++;
		if (this.codewords >= 64) {
			this.errBits *= 0.5;
			this.totalBits *= 0.5;
			this.codewords = 32;
		}
	}

	/** Bit-error rate 0..1, or null until any codeword is seen. */
	get ber(): number | null {
		return this.totalBits > 0 ? this.errBits / this.totalBits : null;
	}

	get count(): number {
		return this.codewords;
	}
}
