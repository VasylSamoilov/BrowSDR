import type { RDSMessage } from '@/worker/decoders/types';
import type { AppInstance } from '@/app/core/receiver.types';

const EMPTY_STATION = { ps: '', rt: '', pi: '', pty: 0, ptyLabel: '', tp: false, ta: false, freq: '',
	ptyn: '', ct: '', ctUtcOffset: 0 as number | null, ecc: -1, countryName: '', lic: -1, languageName: '',
	af: [] as number[], hasTmc: false, rtPlusItem1: '', rtPlusItem1Tag: 0, rtPlusItem2: '', rtPlusItem2Tag: 0,
	psCharStatus: [] as number[], rtCharStatus: [] as number[],
};

export const rdsMethods = {
	toggleRdsPanel(this: AppInstance) {
		this.rds.panelOpen = !this.rds.panelOpen;
	},
	/** Get (or create) the per-VFO RDS station state */
	_rdsStation(this: AppInstance, vfoIndex: number) {
		if (!this.rds.stations[vfoIndex]) {
			this.rds.stations[vfoIndex] = { ...EMPTY_STATION };
		}
		return this.rds.stations[vfoIndex];
	},
	/** Get the active VFO's RDS station (for display in header) */
	rdsActive(this: AppInstance) {
		return this.rds.stations[this.activeVfoIndex] || EMPTY_STATION;
	},
	/** Get all VFOs that have RDS data, as an array with vfoIndex attached */
	rdsStationList(this: AppInstance): Array<{
		vfoIndex: number;
		ps: string;
		rt: string;
		pi: string;
		pty: number;
		ptyLabel: string;
		tp: boolean;
		ta: boolean;
		freq: string;
	}> {
		const result: Array<AppInstance['rds']['stations'][number] & { vfoIndex: number }> = [];
		for (const key of Object.keys(this.rds.stations)) {
			const idx = Number(key);
			const stn = this.rds.stations[idx];
			if (stn && (stn.ps || stn.pi || stn.rt)) result.push({ ...stn, vfoIndex: idx });
		}
		return result;
	},
	_onRdsMessage(this: AppInstance, vfoIndex: number, freqMhz: number, msg: RDSMessage) {
		const time = new Date().toLocaleTimeString();
		const freq = freqMhz ? this.formatFreq(freqMhz) + ' MHz' : '';
		const stn = this._rdsStation(vfoIndex);

		if (msg.pi !== undefined) { stn.pi = msg.pi; stn.freq = freq; }
		if (msg.ps !== undefined) {
			stn.ps = msg.ps;
			stn.psCharStatus = msg.psCharStatus ?? [];
			stn.freq = freq;
			this.rds.log.push({ time, field: 'PS', value: msg.ps, freq, vfoIndex });
		}
		if (msg.rt !== undefined) {
			stn.rt = msg.rt;
			stn.rtCharStatus = msg.rtCharStatus ?? [];
			this.rds.log.push({ time, field: 'RT', value: msg.rt, freq, vfoIndex });
		}
		if (msg.ptyn !== undefined) {
			stn.ptyn = msg.ptyn;
			this.rds.log.push({ time, field: 'PTYN', value: msg.ptyn, freq, vfoIndex });
		}
		if (msg.ct !== undefined) {
			stn.ct = msg.ct;
			stn.ctUtcOffset = msg.ctUtcOffset ?? null;
			this.rds.log.push({ time, field: 'CT', value: msg.ct, freq, vfoIndex });
		}
		if (msg.pty !== undefined) { stn.pty = msg.pty; stn.ptyLabel = msg.ptyLabel || ''; }
		if (msg.tp !== undefined) stn.tp = msg.tp;
		if (msg.ta !== undefined) stn.ta = msg.ta;
		if (msg.ecc !== undefined) { stn.ecc = msg.ecc; stn.countryName = msg.countryName || ''; }
		if (msg.lic !== undefined) { stn.lic = msg.lic; stn.languageName = msg.languageName || ''; }
		if (msg.af !== undefined) stn.af = msg.af;
		if (msg.hasTmc) stn.hasTmc = true;
		if (msg.rtPlusItem1 !== undefined) {
			stn.rtPlusItem1 = msg.rtPlusItem1 || '';
			stn.rtPlusItem1Tag = msg.rtPlusItem1Tag || 0;
			stn.rtPlusItem2 = msg.rtPlusItem2 || '';
			stn.rtPlusItem2Tag = msg.rtPlusItem2Tag || 0;
		}
		if (msg.eon !== undefined) {
			this.rds.log.push({ time, field: 'EON', value: `PI:${msg.eon.pi}${msg.eon.ps ? ' PS:' + msg.eon.ps.trim() : ''}`, freq, vfoIndex });
		}

		// Auto-scroll log
		Promise.resolve(
			this.$nextTick(() => {
				const el = this.$refs.rdsBody;
				if (el) el.scrollTop = el.scrollHeight;
			}),
		).catch((error: unknown) => console.error(error));
	},
	/** Region change: update decoder AND auto-set de-emphasis (NA→75µs, EU→50µs). */
	setRdsRegion(this: AppInstance, vfoIndex: number, region: string) {
		const vfo = this.vfos[vfoIndex];
		if (!vfo) return;
		vfo.rdsRegion = region;
		// Auto-set de-emphasis: NA/RBDS uses 75µs, EU/RDS uses 50µs
		if (region === 'na') vfo.deEmphasis = '75us';
		else if (region === 'eu') vfo.deEmphasis = '50us';
	},
	clearRds(this: AppInstance) {
		this.rds.log = [];
		this.rds.stations = {};
	},
	exportRds(this: AppInstance) {
		const lines = this.rds.log.map((e) => `[${e.time}] ${e.freq}  ${e.field}: ${e.value}`);
		const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `rds-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
		a.click();
		URL.revokeObjectURL(url);
	},
};
