import type { RDSMessage } from '@/worker/decoders/types';
import type { AppInstance } from '@/app/core/receiver.types';
import type { RdsStatus } from '@/worker/decoders/rds';

const EMPTY_STATION = { ps: '', rt: '', pi: '', pty: 0, ptyLabel: '', tp: false, ta: false, freq: '',
	ptyn: '', ct: '', ctUtcOffset: 0 as number | null, ecc: -1, countryName: '', lic: -1, languageName: '',
	af: [] as number[], hasTmc: false, tmcId: -1, rtPlusItem1: '', rtPlusItem1Tag: 0, rtPlusItem1Name: '', rtPlusItem2: '', rtPlusItem2Tag: 0, rtPlusItem2Name: '', rtPlusRunning: false,
	psCharStatus: [] as number[], rtCharStatus: [] as number[],
	// Group 1A extras
	la: false, opc: 0, rpc: 0, rpcGroupDesig: 0, rpcBattSync: 0,
	pagingOpc: -1, pagingPac: -1, ewsChannel: -1, broadcasterData: -1,
	pinDay: 0, pinHour: 0, pinMinute: 0,
	// PI breakdown
	piCc: 0, piCoverage: 0, piCoverageName: '', piRef: 0, piCallsign: '' as string | null,
	// Group 0/15B MS + DI
	ms: null as boolean | null, di: -1, diStereo: false, diArtHead: false, diCompressed: false, diDynPty: false,
	// eRT (Enhanced RadioText)
	eRT: '' as string,
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

		if (msg.pi !== undefined) {
			stn.pi = msg.pi; stn.freq = freq;
			if (msg.piCc !== undefined)      stn.piCc = msg.piCc;
			if (msg.piCoverage !== undefined) stn.piCoverage = msg.piCoverage;
			if (msg.piCoverageName !== undefined) stn.piCoverageName = msg.piCoverageName;
			if (msg.piRef !== undefined)     stn.piRef = msg.piRef;
			if (msg.piCallsign !== undefined) stn.piCallsign = msg.piCallsign;
		}
		if (msg.piCallsign !== undefined && msg.pi === undefined) stn.piCallsign = msg.piCallsign;
		if (msg.ps !== undefined) {
			stn.ps = msg.ps;
			stn.psCharStatus = msg.psCharStatus ?? [];
			stn.freq = freq;
			this.rds.log.push({ time, field: 'PS', value: msg.ps, freq, vfoIndex, group: msg.srcGroup });
		}
		if (msg.rt !== undefined) {
			stn.rt = msg.rt;
			stn.rtCharStatus = msg.rtCharStatus ?? [];
			this.rds.log.push({ time, field: 'RT', value: msg.rt, freq, vfoIndex, group: msg.srcGroup, abFlag: msg.srcAbFlag });
		}
		if (msg.ptyn !== undefined) {
			stn.ptyn = msg.ptyn;
			this.rds.log.push({ time, field: 'PTYN', value: msg.ptyn, freq, vfoIndex, group: msg.srcGroup, abFlag: msg.srcAbFlag });
		}
		if (msg.ct !== undefined) {
			stn.ct = msg.ct;
			stn.ctUtcOffset = msg.ctUtcOffset ?? null;
			this.rds.log.push({ time, field: 'CT', value: msg.ct, freq, vfoIndex, group: msg.srcGroup });
		}
		if (msg.pty !== undefined) { stn.pty = msg.pty; stn.ptyLabel = msg.ptyLabel || ''; }
		if (msg.tp !== undefined) stn.tp = msg.tp;
		if (msg.ta !== undefined) stn.ta = msg.ta;
		if (msg.ecc !== undefined) { stn.ecc = msg.ecc; stn.countryName = msg.countryName || ''; if (msg.opc !== undefined) stn.opc = msg.opc; }
		if (msg.lic !== undefined) { stn.lic = msg.lic; stn.languageName = msg.languageName || ''; }
		if (msg.af !== undefined) stn.af = msg.af;
		if (msg.hasTmc) { stn.hasTmc = true; if (msg.tmcId !== undefined) stn.tmcId = msg.tmcId; }
		if (msg.la !== undefined) stn.la = msg.la;
		if (msg.rpc !== undefined) { stn.rpc = msg.rpc; stn.rpcGroupDesig = msg.rpcGroupDesig ?? 0; stn.rpcBattSync = msg.rpcBattSync ?? 0; }
		if (msg.pagingOpc !== undefined) {
			stn.pagingOpc = msg.pagingOpc;
			stn.pagingPac = msg.pagingPac ?? 0;
			this.rds.log.push({ time, field: 'PAGING-ID', value: `OPC=${msg.pagingOpc} PAC=${msg.pagingPac ?? 0}${msg.pagingPac === 0 ? ' (all areas)' : ''}`, freq, vfoIndex, group: msg.srcGroup });
		}
		if (msg.ewsChannel !== undefined) {
			stn.ewsChannel = msg.ewsChannel;
			this.rds.log.push({ time, field: 'EWS', value: `Channel ${msg.ewsChannel}`, freq, vfoIndex });
		}
		if (msg.broadcasterData !== undefined) {
			stn.broadcasterData = msg.broadcasterData;
		}
		if (msg.ms !== undefined) stn.ms = msg.ms;
		if (msg.di !== undefined) {
			stn.di = msg.di;
			stn.diStereo     = msg.diStereo     ?? false;
			stn.diArtHead    = msg.diArtHead    ?? false;
			stn.diCompressed = msg.diCompressed ?? false;
			stn.diDynPty     = msg.diDynPty     ?? false;
		}
		if (msg.pin !== undefined && msg.pinDay !== undefined) {
			stn.pinDay = msg.pinDay;
			stn.pinHour = msg.pinHour ?? 0;
			stn.pinMinute = msg.pinMinute ?? 0;
		}
		if (msg.rtPlusItem1 !== undefined) {
			stn.rtPlusItem1     = msg.rtPlusItem1 || '';
			stn.rtPlusItem1Tag  = msg.rtPlusItem1Tag || 0;
			stn.rtPlusItem1Name = msg.rtPlusItem1Name || '';
			stn.rtPlusItem2     = msg.rtPlusItem2 || '';
			stn.rtPlusItem2Tag  = msg.rtPlusItem2Tag || 0;
			stn.rtPlusItem2Name = msg.rtPlusItem2Name || '';
			if (msg.rtPlusRunning !== undefined) stn.rtPlusRunning = msg.rtPlusRunning;
			if (msg.rtPlusItem1 || msg.rtPlusItem2) {
				const t1 = msg.rtPlusItem1Name ? `[${msg.rtPlusItem1Name}] ${msg.rtPlusItem1}` : msg.rtPlusItem1 || '';
				const t2 = msg.rtPlusItem2Name ? `[${msg.rtPlusItem2Name}] ${msg.rtPlusItem2}` : msg.rtPlusItem2 || '';
				const val = [t1, t2].filter(Boolean).join('  ');
				this.rds.log.push({ time, field: 'RT+', value: val, freq, vfoIndex, group: msg.srcGroup });
			}
		}
		if (msg.eon !== undefined) {
			const eonExtra: string[] = [];
			if (msg.eon.mappedFreqs?.length) eonExtra.push(`MF:${msg.eon.mappedFreqs.length}`);
			if (msg.eon.ptyOn !== undefined) eonExtra.push(`PTY:${msg.eon.ptyOn}`);
			if (msg.eon.pinDay) eonExtra.push(`PIN:day${msg.eon.pinDay} ${String(msg.eon.pinHour).padStart(2,'0')}:${String(msg.eon.pinMinute).padStart(2,'0')}`);
			const eonVal = `PI:${msg.eon.pi}${msg.eon.ps ? ' PS:' + msg.eon.ps.trim() : ''}${eonExtra.length ? ' ' + eonExtra.join(' ') : ''}`;
			this.rds.log.push({ time, field: 'EON', value: eonVal, freq, vfoIndex, group: msg.srcGroup });
		}
		if (msg.eRT !== undefined) {
			const stn = this.rds.stations[msg.pi ?? 0] ?? (this.rds.stations[msg.pi ?? 0] = { ...EMPTY_STATION, freq, vfoIndex } as typeof EMPTY_STATION & { freq: string; vfoIndex: number });
			stn.eRT = msg.eRT;
			this.rds.log.push({ time, field: 'eRT', value: msg.eRT, freq, vfoIndex, group: msg.srcGroup });
		}
		if (msg.paging !== undefined) {
			const p = msg.paging;
			const label = p.type === 'tone' ? 'TONE' : p.type.toUpperCase();
			const val = p.type === 'tone' ? p.addrFmt : `${p.addrFmt}  ${p.data}`;
			this.rds.log.push({ time, field: `PAG-${label}`, value: val, freq, vfoIndex, group: msg.srcGroup });
			// Also push into the shared pager message center
			const stn = this.rds.stations[msg.pi ?? 0];
			const stationTag = stn?.pi ? `RDS ${stn.pi}${stn.ps.trim() ? ' ' + stn.ps.trim() : ''}` : `RDS ${freq}`;
			this.pager.log.push({
				protocol: 'rds',
				time,
				freq,
				vfoIndex,
				capcode: p.addrFmt,
				type: p.type === 'numeric-10' ? 'numeric' : p.type === 'numeric-18' ? 'numeric' : p.type,
				text: p.type === 'tone' ? '' : (p.data ?? ''),
				detectDebug: stationTag,
			});
			this.pager.panelOpen = true;
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
	_onRdsStatus(this: AppInstance, vfoIndex: number, _freqMhz: number, status: RdsStatus) {
		this.rdsStatus[vfoIndex] = status;
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
