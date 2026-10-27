/*
 * Dev-only POCSAG decode instrumentation.
 *
 * Extracted from pocsag.ts so the diagnostic code lives outside the decoder's
 * line budget while staying first-class (never stripped). Gated by the caller's
 * POCSAG_DEMOD_DIAG flag — zero cost in production. The functions take the
 * decoder instance via a narrow structural interface so they can read the ring
 * buffers and lock state without pocsag.ts depending on this module's shape.
 */

import type { PocsagDiagHost } from './pocsag.types';

const SYNC_WORD = 0x7cd215d8 >>> 0;
const IDLE_CW = 0x7a89c197 >>> 0;

/**
 * Report each between-batch FSC re-lock. `resyncBits` is how many bits into the
 * search the match fired: a clean re-lock fires at the bit that completes the
 * true 32-bit FSC (resyncBits === 32), NOT one bit early. `bchCorrectsToSync`
 * is whether the matched window BCH-corrects to EXACTLY the sync word — a bare-
 * Hamming match that does NOT correct to sync would be a near-sync neighbour at
 * a shifted offset (an early/misaligned re-lock that shifts the whole following
 * batch by one bit).
 */
export function pocsagDiagRelock(host: PocsagDiagHost, w: number, ham: number): void {
	const trial = (host.inverted ? ~w : w) >>> 0;
	const r = host._eccCorrect(trial);
	const exact = r.cw >>> 0 === SYNC_WORD && r.errors < 3;
	console.info(
		`[POCSAG ${host.baudRate}bd RELOCK] resyncBits=${host.resyncBits} ham=${ham} ` +
			`w=0x${w.toString(16).padStart(8, '0')} bchCorrectsToSync=${exact} (err=${r.errors})`,
	);
}

/**
 * Dump one codeword's decode evidence. For a BCH-corrected word it lists the
 * flipped bit positions with the soft slice sample, residual PLL phase, and raw
 * pre-DC demod sample at each (from the aligned ring), so a "why did a clean
 * signal need correction" question is answered by measurement: |soft|≈0 is a
 * marginal slice (timing/level); a large |soft| with centred phase is a
 * confident disagreement; a raw value pinned near ±max is a railed demod. On an
 * INVERTED lock the decoder applies ~raw before ECC, so the slicer's raw soft
 * sign is opposite the bit that entered the codeword; the dump negates soft and
 * raw so the reported value always describes the codeword bit (reportedSoft < 0
 * ⇒ bit 1), regardless of polarity.
 */
export function pocsagDiagDumpCodeword(host: PocsagDiagHost, cw: number, corrected: number, errors: number): void {
	const type = (corrected >>> 31) & 1;
	let kind: string;
	if (errors >= 3) kind = 'UNCORRECTABLE';
	else if (corrected === IDLE_CW) kind = 'IDLE';
	else if (type === 0)
		kind = `ADDR cap=${((corrected >>> 13) & 0x3ffff) * 8 + ((host.batchCwIdx >> 1) & 0x7)} func=${(corrected >>> 11) & 0x3}`;
	else kind = 'MSG';
	let detail = '';
	if (errors > 0 && errors < 3) {
		const flipped = (cw ^ corrected) >>> 0;
		const softSign = host.inverted ? -1 : 1;
		const parts: string[] = [];
		for (let b = 31; b >= 0; b--) {
			if ((flipped >>> b) & 1) {
				// bit b (0=LSB) was accumulated at ring index diagSoftPos+(31-b).
				const ringIdx = (host.diagSoftPos + (31 - b)) % 32;
				const soft = host.diagSoft[ringIdx] * softSign;
				const raw = host.diagRaw[ringIdx] * softSign;
				parts.push(`bit${b}=${soft.toFixed(3)}@ph${host.diagPhase[ringIdx].toFixed(3)}raw${raw.toFixed(3)}`);
			}
		}
		detail = ` flipped[${parts.join(' ')}]`;
	}
	console.info(
		`[POCSAG ${host.baudRate}bd CW#${host.batchCwIdx}] raw=0x${(cw >>> 0).toString(16).padStart(8, '0')} ` +
			`-> 0x${(corrected >>> 0).toString(16).padStart(8, '0')} errors=${errors} ${kind}${detail}`,
	);
}
