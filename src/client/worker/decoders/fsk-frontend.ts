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
	/** Optional dev tap: receives the soft (DC-removed) sample value used for
	 * each bit decision, plus the residual PLL phase at the decision instant
	 * (fractional overshoot past the ideal sample point, in bit units: 0 = dead
	 * on the bit centre, growing magnitude = the sample drifted off centre). A
	 * decoder logs both so a "why did a clean bit decode wrong" question is
	 * answered by measurement: |soft|≈0 is a marginal slice; a large |soft| with
	 * a large residual phase is a timing/boundary drift. The raw (pre-DC) demod
	 * sample is also reported: a value pinned near the discriminator's ±max while
	 * the bit still decodes wrong is a railed/clipped demod fault UPSTREAM of the
	 * slicer, distinct from a DC-tracker or slicer fault. Null = off, zero cost. */
	onSoftBit: ((soft: number, phase: number, raw: number) => void) | null = null;

	// ── DC removal ──
	private dcLevel = 0;
	/** DC-removal IIR — osmocom 0.010 s time constant (FSK_PLL_DC_OFFSET_FILTER),
	 * calculated from sample rate. Each update is clamped to ±DC_CLAMP of the
	 * current envelope so a single marginal sample cannot yank the DC estimate
	 * by more than a small fraction of the signal amplitude per symbol. Without
	 * the clamp, long same-symbol codeword runs drag the estimate toward the
	 * symbol level and flip the bits that follow. */
	private readonly dcAlpha: number;
	private static readonly DC_CLAMP = 0.001; // max DC shift per sample as fraction of env
	private static readonly DC_MAX   = 0.10;  // hard cap on DC estimate as fraction of env

	// ── PLL / timing ──
	/** PLL lock state (drives the timing gain). Read and set by the decoder's
	 * sync logic, so it is public. */
	pllLocked = false;
	private pllTimeout = 0;
	/** Mid-symbol crossings within the current symbol. High on a wrong-baud
	 * signal → a decoder uses it to block false sync acquisition. Public so the
	 * sync logic can read it. */
	nonconsec = 0;
	private lastSample = 0;

	// ── Integer phase accumulator + majority vote (osmocom libfsk_pll). ──
	// phase runs 0..phaseMax over one symbol; phaseRate advances it per sample.
	// The bit is decided by MAJORITY VOTE over the middle 80% of the symbol
	// (10% < phase < 90%), not a single centre sample — so one marginal sample
	// on a perfect signal cannot flip the bit (the other ~80% outvote it).
	// phase_max = 100 * samplerate, phase_rate = 100 * baud (osmocom's scaling).
	private readonly phaseMax: number;
	private readonly phaseRate: number;
	private phase = 0;
	private voteHigh = 0;
	private voteLow = 0;

	// ── Envelope tracking (adaptive deviation reference). ──
	// The FM discriminator's output deviation is NOT fixed: it rails past the
	// nominal full scale on strong/over-deviated bursts and shrinks toward zero
	// on weak ones. A running estimate of the signal envelope (mean |DC-removed
	// sample|) gives an adaptive reference so the eye looks consistent at both
	// extremes. The 2-FSK bit decision stays a scale-free SIGN vote (osmocom
	// does not use the envelope for 2-level slicing); the envelope is used to
	// express the zero-crossing hysteresis and the reported soft confidence in
	// envelope units, and is available for GSC/FLEX multi-level thresholds. A
	// slow IIR so a single railed burst cannot yank the reference. While
	// unlocked it does not track the (noise) input; instead it DECAYS slowly
	// back toward a neutral start value, so a long gap between transmissions
	// relaxes the reference to a sensible baseline rather than holding a stale
	// burst's envelope or snapping to noise.
	private env = 0.5;
	/** Neutral envelope baseline: the nominal 2-FSK symbol amplitude the demod
	 * produces at standard deviation (order 0.5 full-scale). The unlocked decay
	 * relaxes toward this, and it seeds the estimate before first lock. */
	private static readonly ENV_DEFAULT = 0.5;
	/** Envelope IIR coefficient (~64-bit time constant, like the old DC scale),
	 * slow enough to average over several codewords. */
	private readonly envAlpha: number;
	/** Unlocked decay coefficient: much slower than envAlpha, so between
	 * transmissions the envelope relaxes gently toward ENV_DEFAULT (over ~1000
	 * bit periods) instead of snapping or holding a stale value. */
	private readonly envDecayAlpha: number;

	constructor(audioRate: number, baud: number, onBit: (bit: number) => void) {
		this.spb = audioRate / baud;
		// osmocom fsk_pll.c: dc = (dc*tc + x)/(tc+1), tc = samplerate * 0.010 s.
		// A seconds-based constant converges in ~10 ms regardless of baud, so a
		// short page's DC offset is nulled within the burst; the old bit-scaled
		// 1/(64*spb) was ~12x slower at 512 bd and left the slice DC-biased for
		// the whole of a short page.
		// DC: osmocom 0.010 s time constant, clamped per update (see removeDc).
		this.dcAlpha = 1 / (audioRate * 0.010 + 1);
		// Envelope tracks slower than DC (it should average the symbol
		// amplitude across runs, not follow individual symbols): ~64 bits.
		this.envAlpha = 1 / (64 * this.spb);
		// Unlocked decay ~16x slower (~1000 bits) so the reference relaxes
		// gently toward the neutral baseline between transmissions.
		this.envDecayAlpha = 1 / (1024 * this.spb);
		// osmocom integer phase scaling (fsk_pll_init): phase_max = 100*sr,
		// phase_rate = 100*baud. phase wraps once per symbol.
		this.phaseMax = 100 * audioRate;
		this.phaseRate = 100 * baud;
		this.onBit = onBit;
	}

	reset(): void {
		this.dcLevel = 0;
		this.pllLocked = false;
		this.pllTimeout = 0;
		this.nonconsec = 0;
		this.lastSample = 0;
		this.phase = 0;
		this.voteHigh = 0;
		this.voteLow = 0;
		this.env = FskBitSlicer.ENV_DEFAULT;
	}

	/**
	 * Re-anchor the bit clock to a just-verified symbol boundary. The decoder
	 * calls this the instant it accepts a frame sync codeword (FSC): the FSC's
	 * last bit IS a true symbol boundary, so the phase accumulator is reset to
	 * the start of a symbol and the in-progress vote is cleared. This pins each
	 * batch's 16-codeword grid to the verified FSC (osmocom resets fsk_rx_index
	 * to 0 at every sync) so that even a one-bit timing slip during a prior
	 * batch cannot propagate: the next FSC re-aligns the grid exactly, instead
	 * of the free-running count carrying a half-bit offset into the new batch.
	 */
	syncPhase(): void {
		this.phase = 0;
		this.voteHigh = 0;
		this.voteLow = 0;
		this.pllLocked = true;
		this.pllTimeout = 0;
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
		// When locked, the DC offset is a fixed hardware property of the FM
		// discriminator — it does not change within a transmission. Updating the
		// IIR while locked lets same-symbol codeword runs (IDLE, long message
		// runs) bias the estimate toward the symbol level, collapsing the eye.
		// Freeze the DC estimate while locked; let it track only during preamble
		// acquisition where the alternating pattern gives unbiased updates.
		if (!this.pllLocked) {
			const delta = this.dcAlpha * (x - this.dcLevel);
			const maxDelta = FskBitSlicer.DC_CLAMP * this.env;
			this.dcLevel +=
				delta > maxDelta ? maxDelta : delta < -maxDelta ? -maxDelta : delta;
		}
		// Hard clamp: DC estimate never exceeds ±DC_MAX × env even during
		// acquisition, so a very noisy preamble cannot park a huge offset.
		const maxDc = FskBitSlicer.DC_MAX * this.env;
		if (this.dcLevel > maxDc) this.dcLevel = maxDc;
		else if (this.dcLevel < -maxDc) this.dcLevel = -maxDc;
		return x - this.dcLevel;
	}

	/** Feed a block of FM-demodulated samples; emits bits via the callback.
	 *
	 * Ported precisely from osmocom-analog src/libfsk_pll/fsk_pll.c
	 * (fsk_pll_process), itself from multimon-ng's FLEX decoder. The bit is
	 * decided by MAJORITY VOTE over the middle 80% of each symbol, NOT a single
	 * centre sample: on a perfect signal a lone marginal sample (DC-tracker
	 * ripple on a same-symbol run, one noisy sample) cannot flip the bit because
	 * the other ~80% of the symbol's samples outvote it. A single-sample slicer
	 * flips such bits, which is what produced spurious BCH corrections on clean
	 * IDLE/message codewords. */
	process(samples: Float32Array): void {
		const phaseMax = this.phaseMax;
		const lockedRate = 0.045;
		const unlockedRate = 0.05;

		for (let i = 0; i < samples.length; i++) {
			const val = this.removeDc(samples[i]);

			// Update the envelope (mean |val|) with a slow IIR, then express the
			// decision variable in ENVELOPE UNITS. This makes the eye consistent
			// whether the discriminator over-deviates (|val| railing past full
			// scale) or under-deviates (|val| near zero): norm sits near +/-1 for
			// a solid symbol at ANY deviation. The SIGN is unchanged, so the
			// 2-FSK majority vote stays the scale-free osmocom sign vote; only
			// the crossing hysteresis and the reported soft confidence benefit
			// from the normalisation.
			//
			// The envelope only TRACKS the real symbol amplitude while locked.
			// While unlocked the input is noise, so instead of tracking it the
			// envelope DECAYS slowly back toward the neutral baseline
			// (ENV_DEFAULT) — a long gap relaxes the reference gently rather than
			// holding a stale burst value or snapping to noise. norm uses the
			// envelope whenever it is positive (always, since it decays toward a
			// positive baseline, not zero), so the eye is in consistent envelope
			// units; sign is unchanged so sign-based acquisition is never starved.
			if (this.pllLocked) {
				this.env += this.envAlpha * (Math.abs(val) - this.env);
			} else {
				this.env += this.envDecayAlpha * (FskBitSlicer.ENV_DEFAULT - this.env);
			}
			const norm = this.env > 1e-6 ? val / this.env : val;
			const phasePercent = (100 * this.phase) / phaseMax;

			// Majority voting in the middle 80% of the symbol period (sign of the
			// envelope-normalised sample — identical sign to val, scale-free).
			if (phasePercent > 10 && phasePercent < 90) {
				if (norm > 0) this.voteHigh++;
				else this.voteLow++;
			}

			// Zero-crossing timing PLL on the envelope-normalised sample.
			// Proportional correction: a crossing in the first half (phase < 50%)
			// means we are late (positive error); in the second half, early.
			if (this.lastSample < 0 !== norm < 0) {
				const phaseError = phasePercent < 50 ? this.phase : this.phase - phaseMax;
				const rate = this.pllLocked ? lockedRate : unlockedRate;
				this.phase -= Math.trunc(phaseError * rate);
				// Mid-symbol-crossing classification: a crossing in the middle 80%
				// is near where a transition is expected (PLL tracking); outside
				// that range it is a symbol-centre crossing that a wrong-baud or
				// noisy signal produces. The decoder's sync logic reads nonconsec.
				if (phasePercent > 10 && phasePercent < 90) this.nonconsec++;
				else this.nonconsec = 0;
				this.pllTimeout = 0;
			}
			this.lastSample = norm;

			// Advance the phase accumulator.
			this.phase += this.phaseRate;

			// Symbol boundary: decide the bit by majority vote.
			if (this.phase >= phaseMax) {
				this.phase -= phaseMax;
				this.nonconsec = 0;
				// 2-FSK mark ("1") = negative deviation. osmocom votes high for
				// val > 0; here a HIGH (positive) sample is bit 0, LOW is bit 1,
				// so the mark bit is (voteLow >= voteHigh). Fall back to the last
				// sample's sign when the symbol had no votes.
				let bit: number;
				if (this.voteHigh + this.voteLow > 0) bit = this.voteLow >= this.voteHigh ? 1 : 0;
				else bit = val < 0 ? 1 : 0;
				// Representative soft value for the dev tap: the signed vote
				// margin scaled to the symbol, negative ⇒ bit 1 (same sign
				// convention as the single-sample slicer it replaces).
				const total = this.voteHigh + this.voteLow;
				const soft = total > 0 ? (this.voteHigh - this.voteLow) / total : val;
				this.onSoftBit?.(soft, this.phase / phaseMax, val);
				this.voteHigh = 0;
				this.voteLow = 0;
				if (++this.pllTimeout > 100) this.pllLocked = false;
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
