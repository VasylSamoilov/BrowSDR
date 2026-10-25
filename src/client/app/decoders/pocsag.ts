import type { POCSAGMessage, POCSAGStatus } from '@/worker/decoders/types';
import type { AppInstance } from '@/app/core/receiver.types';
import type { PagerLogEntry } from '@/app/decoders/types';
import { CHARSETS, hasCharsets, defaultCharset } from '@/worker/decoders/charsets';
import type { PagerProtocol } from '@/worker/decoders/charsets';

/** Static descriptor for each pager protocol the UI can present. POCSAG is the
 * only wired decoder today; GSC and FLEX are listed so the UI renders their
 * controls as they come online (their boolean VFO flag + worker decoder land
 * with each protocol). `hasCharsets` is resolved from the registry so a
 * default-only protocol (GSC) never shows a charset selector. */
export const PAGER_PROTOCOLS: Array<{ id: PagerProtocol; label: string }> = [
	{ id: 'pocsag', label: 'POCSAG' },
	// { id: 'gsc', label: 'GSC' },   // added with the GSC decoder (default-only)
	// { id: 'flex', label: 'FLEX' }, // added with the FLEX decoder
];

/**
 * Represent one decoded character for the log display (after charset
 * conversion): newline and carriage return both show as the Unicode return
 * symbol ⏎ (they are line/message separators), other control / non-printable
 * codes as <0xNN>. Printable glyphs (incl. codepage glyphs) pass through
 * unchanged. CR must stay visible: dropping it merges HELLO⏎WORLD into
 * HELLOWORLD in both the display and the text export.
 */
export function pocsagDisplayChar(ch: string): string {
	const code = ch.charCodeAt(0);
	if (ch === '\n' || ch === '\r') return '⏎';
	if (code < 0x20 || code === 0x7f) return `<0x${code.toString(16).padStart(2, '0').toUpperCase()}>`;
	return ch;
}

/** Apply pocsagDisplayChar across a whole string. */
export function pocsagDisplayText(text: string): string {
	let out = '';
	for (const ch of text) out += pocsagDisplayChar(ch);
	return out;
}

export const pocsagMethods = {
	togglePagerPanel(this: AppInstance) {
		this.pager.panelOpen = !this.pager.panelOpen;
	},
	/** List of pager protocols for the per-VFO multi-select. */
	pagerProtocols(this: AppInstance): Array<{ id: PagerProtocol; label: string; hasCharsets: boolean }> {
		return PAGER_PROTOCOLS.map((p) => ({ ...p, hasCharsets: hasCharsets(p.id) }));
	},
	/** Set the panel's protocol row filter. */
	setPagerFilter(this: AppInstance, value: string) {
		this.pager.filter = (value as PagerProtocol | 'all') ?? 'all';
	},
	/** Panel rows after applying the protocol filter. */
	pagerRows(this: AppInstance): PagerLogEntry[] {
		const f = this.pager.filter;
		return f === 'all' ? this.pager.log : this.pager.log.filter((e) => e.protocol === f);
	},
	/**
	 * Decode-POCSAG toggle. On enable, apply POCSAG-friendly RX defaults so it
	 * works well out of the box: disable the speech low-pass (it rounds the FSK
	 * edges) and set a bandwidth sized for ±4.5 kHz deviation + 1200-baud
	 * sidebands. These are visible, user-overridable settings — not a hidden
	 * DSP override. Left as-is on disable so the user keeps whatever they had.
	 */
	togglePocsag(this: AppInstance, i: number) {
		const vfo = this.vfos[i];
		if (vfo.pocsag) {
			vfo.lowPass = false;
			if (vfo.bandwidth < 12500) vfo.bandwidth = 12500;
		}
		this.updateBackendVfoParams(i);
	},
	/** All selectable charsets for a protocol, grouped by vendor, for the UI
	 * dropdown. Data-driven off the registry so each protocol shows only its own
	 * codepages (POCSAG now; FLEX when populated). */
	pagerCharsetGroups(
		this: AppInstance,
		protocol: PagerProtocol,
	): Array<{ vendor: string; items: Array<{ value: string; label: string }> }> {
		const groups = new Map<string, Array<{ value: string; label: string }>>();
		for (const e of CHARSETS[protocol] ?? []) {
			const value = `${e.vendor}\u0000${e.model}\u0000${e.codepage}`;
			if (!groups.has(e.vendor)) groups.set(e.vendor, []);
			groups.get(e.vendor)!.push({ value, label: e.label });
		}
		return [...groups.entries()].map(([vendor, items]) => ({ vendor, items }));
	},
	/** Current POCSAG charset value string for a VFO's <select> binding. */
	pocsagCharsetValue(this: AppInstance, i: number): string {
		const k = this.vfos[i]?.pocsagCharset ?? defaultCharset('pocsag');
		return `${k.vendor}\u0000${k.model}\u0000${k.codepage}`;
	},
	/** Apply a POCSAG charset selection to a VFO and push it to the decoder. */
	setPocsagCharset(this: AppInstance, i: number, value: string) {
		const [vendor, model, codepage] = value.split('\u0000');
		this.vfos[i].pocsagCharset = { vendor, model, codepage };
		this.updateBackendVfoParams(i);
	},
	/** Apply the POCSAG type-detection mode (auto/alpha/numeric) to a VFO. */
	setPocsagMode(this: AppInstance, i: number, value: string) {
		this.vfos[i].pocsagMode = value === 'alpha' || value === 'numeric' ? value : 'auto';
		this.updateBackendVfoParams(i);
	},
	/** Format a decoded string for the log (control chars → ⏎ / <0xNN>). */
	pocsagDisplayText(this: AppInstance, text: string): string {
		return pocsagDisplayText(text);
	},
	_onPocsagStatus(this: AppInstance, vfoIndex: number, _freqMhz: number, status: POCSAGStatus) {
		if (!this.pocsagStatus) this.pocsagStatus = [];
		this.pocsagStatus[vfoIndex] = status;
	},
	_onPocsagMessage(this: AppInstance, vfoIndex: number, freqMhz: number, msg: POCSAGMessage) {
		const time = new Date().toLocaleTimeString();
		const freq = freqMhz ? this.formatFreq(freqMhz) + ' MHz' : '';
		this.pager.log.push({
			protocol: 'pocsag',
			time,
			freq,
			vfoIndex,
			capcode: String(msg.capcode),
			type: msg.type,
			func: msg.func,
			text: msg.text,
			charStatus: msg.charStatus ?? [],
			baud: msg.baud,
			detectDebug: msg.detectDebug,
			alt: msg.alt,
		});
		// Auto-scroll
		Promise.resolve(
			this.$nextTick(() => {
				const el = this.$refs.pagerBody;
				if (el) el.scrollTop = el.scrollHeight;
			}),
		).catch((error: unknown) => console.error(error));
	},
	/**
	 * Split a message's text into contiguous runs of the same decode status so
	 * the template can colour-code each run (ok / corrected / uncorrectable)
	 * with a single span per run instead of one span per character.
	 */
	pocsagSegments(this: AppInstance, entry: PagerLogEntry): Array<{ text: string; status: number }> {
		const { text, charStatus } = entry;
		if (!charStatus || charStatus.length === 0) return [{ text: pocsagDisplayText(text), status: 0 }];
		const segments: Array<{ text: string; status: number }> = [];
		let cur = '';
		let curStatus = charStatus[0] ?? 0;
		for (let i = 0; i < text.length; i++) {
			const st = charStatus[i] ?? 0;
			if (st !== curStatus && cur) {
				segments.push({ text: cur, status: curStatus });
				cur = '';
				curStatus = st;
			} else if (st !== curStatus) {
				curStatus = st;
			}
			cur += pocsagDisplayChar(text[i]);
		}
		if (cur) segments.push({ text: cur, status: curStatus });
		return segments;
	},
	clearPager(this: AppInstance) {
		this.pager.log = [];
	},
	exportPager(this: AppInstance) {
		const lines = this.pager.log.map(
			(e) =>
				`[${e.time}] ${e.protocol.toUpperCase()}  ${e.freq}  CAP:${e.capcode}  F:${['A', 'B', 'C', 'D'][e.func ?? -1] || '?'}  TYPE:${e.type}  ${e.text ? pocsagDisplayText(e.text) : '(tone)'}${e.alt && e.alt.text ? '  (' + e.alt.type + ': ' + pocsagDisplayText(e.alt.text) + ')' : ''}${e.detectDebug ? '  [' + e.detectDebug + ']' : ''}`,
		);
		const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `pager-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
		a.click();
		URL.revokeObjectURL(url);
	},
};
