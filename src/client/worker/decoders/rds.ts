/*
Copyright (c) 2026, jLynx <https://github.com/jLynx>

All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
	Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
	Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the
	documentation and/or other materials provided with the distribution.
	Neither the name of Great Scott Gadgets nor the names of its contributors may be used to endorse or promote products derived from this software
	without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

import type { RDSMessage } from './types';

// ── RDS Constants ────────────────────────────────────────────────
const RDS_BITRATE = 1187.5;
const RDS_PILOT = 19000; // stereo pilot — RDS subcarrier = 3 × pilot

// Offset words for each block position (10-bit, per IEC 62106)
const OFFSET_A  = 0x0fc;
const OFFSET_B  = 0x198;
const OFFSET_C  = 0x168;
const OFFSET_CP = 0x350;
const OFFSET_D  = 0x1b4;

// Generator polynomial for RDS checkword (x^10 + x^8 + x^7 + x^5 + x^4 + x^3 + 1)
const RDS_POLY = 0x5b9;
const SYNDROME_A  = calcSyndrome(OFFSET_A);
const SYNDROME_B  = calcSyndrome(OFFSET_B);
const SYNDROME_C  = calcSyndrome(OFFSET_C);
const SYNDROME_CP = calcSyndrome(OFFSET_CP);
const SYNDROME_D  = calcSyndrome(OFFSET_D);

function calcSyndrome(offset: number): number {
	let reg = 0;
	for (let i = 25; i >= 0; i--) {
		const bit = i >= 10 ? 0 : (offset >> i) & 1;
		const fb = ((reg >> 9) & 1) ^ bit;
		reg = (reg << 1) & 0x3ff;
		if (fb) reg ^= RDS_POLY;
	}
	return reg;
}

function computeSyndrome(block: number): number {
	let reg = 0;
	for (let i = 25; i >= 0; i--) {
		const fb = ((reg >> 9) & 1) ^ ((block >> i) & 1);
		reg = (reg << 1) & 0x3ff;
		if (fb) reg ^= RDS_POLY;
	}
	return reg;
}

// ── EU PTY labels (IEC 62106 Table 11) ──────────────────────────
const PTY_LABELS_EU = [
	'None','News','Current Affairs','Information','Sport','Education','Drama',
	'Culture','Science','Varied','Pop Music','Rock Music','Easy Listening',
	'Light Classical','Serious Classical','Other Music','Weather','Finance',
	'Children','Social Affairs','Religion','Phone In','Travel','Leisure',
	'Jazz Music','Country Music','National Music','Oldies Music','Folk Music',
	'Documentary','Alarm Test','Alarm',
];

// ── NA (RBDS) PTY labels (NRSC-4-B Table 5) ─────────────────────
const PTY_LABELS_NA = [
	'None','News','Information','Sports','Talk','Rock','Classic Rock','Adult Hits',
	'Soft Rock','Top 40','Country','Oldies','Soft','Nostalgia','Jazz','Classical',
	'R&B','Soft R&B','Language','Religious Music','Religious Talk','Personality',
	'Public','College','Spanish Talk','Spanish Music','Hip Hop','','',
	'Weather','Emergency Test','Emergency',
];

// ── Biquad Filter (Direct Form II Transposed) ────────────────────
class BiquadSection {
	private b0: number; private b1: number; private b2: number;
	private a1: number; private a2: number;
	private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;

	constructor(b0: number, b1: number, b2: number, a1: number, a2: number) {
		this.b0 = b0; this.b1 = b1; this.b2 = b2; this.a1 = a1; this.a2 = a2;
	}

	process(x: number): number {
		const y = this.b0*x + this.b1*this.x1 + this.b2*this.x2 - this.a1*this.y1 - this.a2*this.y2;
		this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
		return y;
	}

	reset(): void { this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
}

function makeBandpass(centerHz: number, Q: number, sampleRate: number): BiquadSection {
	const w0 = (2 * Math.PI * centerHz) / sampleRate;
	const sinW0 = Math.sin(w0), cosW0 = Math.cos(w0);
	const alpha = sinW0 / (2 * Q), a0 = 1 + alpha;
	return new BiquadSection(alpha/a0, 0, -alpha/a0, (-2*cosW0)/a0, (1-alpha)/a0);
}

/** 4th-order Butterworth LPF (two cascaded biquads, 24 dB/oct rolloff). */
function makeButterworthLpf4(cutoffHz: number, sampleRate: number): BiquadSection[] {
	return [0.5411961, 1.30656296].map(Q => {
		const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
		const sinW0 = Math.sin(w0), cosW0 = Math.cos(w0);
		const alpha = sinW0 / (2 * Q), a0 = 1 + alpha;
		return new BiquadSection(
			(1-cosW0)/2/a0, (1-cosW0)/a0, (1-cosW0)/2/a0, (-2*cosW0)/a0, (1-alpha)/a0,
		);
	});
}

// ── Language Identification Code (IEC 62106 Annex J) ────────────
const LIC_NAMES: string[] = [
	'Unknown','Albanian','Breton','Catalan','Croatian','Welsh','Czech','Danish',
	'German','English','Spanish','Esperanto','Estonian','Basque','Faroese','French',
	'Frisian','Irish','Gaelic','Galician','Icelandic','Italian','Lappish','Latin',
	'Latvian','Luxembourgish','Lithuanian','Hungarian','Maltese','Dutch','Norwegian',
	'Occitan','Polish','Portuguese','Romanian','Romansh','Serbian','Slovak','Slovene',
	'Finnish','Swedish','Turkish','Flemish','Walloon',
	...Array<string>(20).fill('Unknown'),
	'Background','Unknown','Unknown','Unknown','Unknown',
	'Zulu','Vietnamese','Uzbek','Urdu','Ukrainian','Thai','Telugu','Tatar','Tamil',
	'Tajik','Swahili','Sranan Tongo','Somali','Sinhalese','Shona','Serbo-Croatian',
	'Ruthenian','Russian','Quechua','Pashto','Punjabi','Persian','Papiamento','Oriya',
	'Nepali','Ndebele','Marathi','Moldovan','Malay','Malagasy','Macedonian','Laotian',
	'Korean','Khmer','Kazakh','Kannada','Japanese','Indonesian','Hindi','Hebrew',
	'Hausa','Guarani','Gujarati','Greek','Georgian','Fulah','Dari','Chuvash','Chinese',
	'Burmese','Bulgarian','Bengali','Belarusian','Bambara','Azerbaijani','Assamese',
	'Armenian','Arabic','Amharic',
];

// ── ECC → country code matrix (IEC 62106 Annex D / NRSC-4-B Annex N) ──
// Index 0..14 = CC nibble values 1..15 (CC=0 is invalid)
const ECC_TABLE: Record<number, string[]> = {
	0xE0: ['DE','DZ','AD','IL','IT','BE','RU','PS','AL','AT','HU','MT','DE','--','EG'],
	0xE1: ['GR','CY','SM','CH','JO','FI','LU','BG','DK','GI','IQ','GB','LY','RO','FR'],
	0xE2: ['MA','CZ','PL','VA','SK','SY','TN','--','LI','IS','MC','LT','RS','ES','NO'],
	0xE3: ['ME','IE','TR','MK','--','--','--','NL','LV','LB','AZ','HR','KZ','SE','BY'],
	0xE4: ['MD','EE','KG','--','--','UA','XK','PT','SI','AM','--','GE','--','--','BA'],
	0xA0: ['US','US','US','US','US','US','US','US','US','US','US','--','US','US','--'],
	0xA1: ['--','--','--','--','--','--','--','--','--','--','CA','CA','CA','CA','GL'],
	0xF0: ['AU','AU','AU','AU','AU','AU','AU','AU','SA','AF','MM','CN','KP','BH','MY'],
	0xF1: ['KI','BT','BD','PK','FJ','OM','NR','IR','NZ','SB','BN','LK','TW','KR','HK'],
	0xF2: ['KW','QA','KH','WS','IN','MO','VN','PH','JP','SG','MV','ID','AE','NP','VU'],
};

function eccToCountry(pi: number, ecc: number): string {
	const cc = (pi >> 12) & 0xf;
	const row = ECC_TABLE[ecc];
	if (!row || cc < 1) return '--';
	return row[cc - 1] || '--';
}

// ── ODA Application IDs (IEC 62106 Table M.1) ───────────────────
const ODA_AIDS: Record<number, string> = {
	0x0093: 'Cross-referencing DAB', 0x0BCB: 'BBC Alert',
	0x0C24: 'ZIP/ZIP+',              0x1C00: 'TMC-Alert C',
	0x4BD7: 'RadioText Plus (RT+)',  0x4D2C: 'TMC',
	0x4D44: 'UECP (RDS-TMC)',        0x4E2C: 'TMC-Alert B',
	0x6552: 'RDS2 Uplink',           0x7373: 'Enhanced RadioText (eRT)',
	0xC350: 'RDS Pager',             0x3DC5: 'RDS Pager',
	0x9B53: 'DAB Cross-referencing', 0xAB84: 'Météo',
	0xCD46: 'RDS2 I-data',           0xCD47: 'RDS2 Extra',
};

// ── AF frequency decode (IEC 62106 §6.2.1.6) ────────────────────
// Returns frequency in units of 100 Hz (i.e. kHz * 10) for FM, kHz for LF/MF.
function decodeAfCode(code: number, region: string): number | null {
	if (code >= 1 && code <= 204) {
		if (region === 'na') return Math.round((879 + (code - 4) * 2) * 100);
		return Math.round((875 + code) * 100);
	}
	if (code >= 224 && code <= 249) return (153 + (code - 224) * 9) * 1000;
	return null;
}

// ── RT+ content type names (IEC 62106-6 Table 3) ────────────────
export const RTPLUS_TAGS: Record<number, string> = {
	1:'Title',2:'Album',3:'Track Number',4:'Artist',5:'Composition',6:'Movement',
	7:'Conductor',8:'Composer',9:'Band',10:'Comment',11:'Genre',
	12:'News',13:'News Local',14:'Stock Market',15:'Sport',16:'Lottery',
	17:'Horoscope',18:'Daily Dilemma',19:'Health',20:'Event',21:'Scene',
	22:'Cinema',23:'TV',24:'Date/Time',25:'Weather',26:'Traffic',
	27:'Alarm',28:'Advertisement',29:'URL',30:'Other',
	31:'Studio',32:'Phone',33:'Meeting Place',34:'Stationname Long',
};

// ── RDS Decoder ──────────────────────────────────────────────────

export class RDSDecoder {
	private callback: (msg: RDSMessage) => void;
	private region: string;

	// 19 kHz pilot PLL — phasor rotation (zero trig calls per sample)
	private phasorRe = 1;
	private phasorIm = 0;
	private incRe: number;
	private incIm: number;
	private pilotAlpha: number;
	private pilotBpf: BiquadSection;
	private pilotMixI = 0;
	private pilotMixQ = 0;
	private pilotMixAlpha: number;
	private phasorCount = 0;

	// 4th-order Butterworth LPF for RDS I and Q channels
	private bqI: BiquadSection[];
	private bqQ: BiquadSection[];

	// Symbol timing recovery
	private samplesPerBit: number;
	private clockPhase = 0;
	private prevBpskI = 0;
	private prevBpskQ = 0;
	private clockPowerI = 0;
	private clockPowerQ = 0;
	private clockUsesQ = false;
	private symbolIndex = 0;
	private pairEnergy = [0, 0];
	private pairParity = -1;
	private prevHalfI = 0;
	private prevHalfQ = 0;
	private prevSymI = 0;
	private prevSymQ = 0;

	// Block assembly
	private shiftReg = 0;
	private bitCount = 0;

	// Sync state machine
	private synced = false;
	private blockIndex = 0;
	private goodBlocks = 0;
	private blocks: number[] = [0, 0, 0, 0];
	private blockValid: boolean[] = [false, false, false, false];
	private blockErrors = 0;

	// ── Decoded RDS data ──────────────────────────────────────────
	private pi = 0;
	private pty = -1;
	private tp = false;
	private ta = false;
	private psChars: Array<number | null> = new Array<number | null>(8).fill(null);
	private rtChars: Array<number | null> = new Array<number | null>(64).fill(null);
	private rtAbFlag = -1;
	private rtVersion = -1;
	private lastPs = '';
	private lastRt = '';

	// Group 1A — ECC, LIC
	private ecc = -1;
	private lic = -1;

	// Group 0A — AF list
	private afList: number[] = [];
	private afCount = 0;
	private afLastCount = -1;

	// Group 3A — ODA application registration: (groupNum<<1)|version → AID
	private odaMap: Map<number, number> = new Map();

	// RT+ (ODA AID 0x4BD7)
	private rtPlusGroup = -1;
	private rtPlusText1 = '';
	private rtPlusText2 = '';
	private rtPlusTag1 = 0;
	private rtPlusTag2 = 0;

	// Group 4A — CT clock
	private lastCt = '';

	// Group 10A — PTYN
	private ptynChars: Array<number | null> = new Array<number | null>(8).fill(null);
	private lastPtyn = '';

	// Group 14A — EON
	private eonMap: Map<number, { psChars: (number | null)[]; tp: boolean; ta: boolean; af: number[] }> = new Map();

	constructor(sampleRate: number, callback: (msg: RDSMessage) => void, region = 'eu') {
		this.callback = callback;
		this.region = region;

		const pilotFreq = (2 * Math.PI * RDS_PILOT) / sampleRate;
		this.incRe = Math.cos(pilotFreq);
		this.incIm = Math.sin(pilotFreq);
		this.pilotBpf = makeBandpass(RDS_PILOT, 30, sampleRate);
		this.pilotAlpha = (2 * Math.PI * 100) / sampleRate;
		this.pilotMixAlpha = 1 - Math.exp((-2 * Math.PI * 30) / sampleRate);
		this.samplesPerBit = sampleRate / RDS_BITRATE;
		this.bqI = makeButterworthLpf4(2400, sampleRate);
		this.bqQ = makeButterworthLpf4(2400, sampleRate);
	}

	setRegion(region: string): void {
		if (region === this.region) return;
		this.region = region;
		if (this.pty >= 0) {
			const labels = region === 'na' ? PTY_LABELS_NA : PTY_LABELS_EU;
			this.callback({ pty: this.pty, ptyLabel: labels[this.pty] || '' });
		}
	}

	process(samples: Float32Array): void {
		for (let i = 0; i < samples.length; i++) {
			const sample = samples[i];
			const pilotBpf = this.pilotBpf.process(sample);
			const pllCos = this.phasorRe;
			const pllSin = this.phasorIm;

			// Quadrature mix + narrow LPF → phase error
			this.pilotMixI += this.pilotMixAlpha * (pilotBpf * pllCos - this.pilotMixI);
			this.pilotMixQ += this.pilotMixAlpha * (pilotBpf * pllSin - this.pilotMixQ);
			const pp = this.pilotMixI * this.pilotMixI + this.pilotMixQ * this.pilotMixQ;
			if (pp > 1e-12) {
				const corr = ((this.pilotMixI * this.pilotMixQ) / pp) * this.pilotAlpha;
				this.phasorRe += this.phasorIm * corr;
				this.phasorIm -= this.phasorRe * corr;
			}

			// Advance phasor by one sample
			const newRe = this.phasorRe * this.incRe - this.phasorIm * this.incIm;
			const newIm = this.phasorRe * this.incIm + this.phasorIm * this.incRe;
			this.phasorRe = newRe;
			this.phasorIm = newIm;
			if ((++this.phasorCount & 1023) === 0) {
				const mag = 1 / Math.sqrt(this.phasorRe * this.phasorRe + this.phasorIm * this.phasorIm);
				this.phasorRe *= mag; this.phasorIm *= mag;
			}

			// Coherent 57 kHz via triple-angle formula
			const c = pllCos, s = pllSin;
			const cos3 = 4*c*c*c - 3*c;
			const sin3 = 3*s - 4*s*s*s;

			let filtI = sample * cos3;
			for (let k = 0; k < this.bqI.length; k++) filtI = this.bqI[k].process(filtI);
			let filtQ = sample * sin3;
			for (let k = 0; k < this.bqQ.length; k++) filtQ = this.bqQ[k].process(filtQ);

			// Pick the stronger quadrature for clock recovery
			this.clockPowerI += 0.001 * (filtI * filtI - this.clockPowerI);
			this.clockPowerQ += 0.001 * (filtQ * filtQ - this.clockPowerQ);
			if (this.clockPowerQ > this.clockPowerI * 2) this.clockUsesQ = true;
			else if (this.clockPowerI > this.clockPowerQ * 2) this.clockUsesQ = false;

			const timing  = this.clockUsesQ ? filtQ : filtI;
			const previous = this.clockUsesQ ? this.prevBpskQ : this.prevBpskI;
			const symbolPeriod = this.samplesPerBit / 2;
			const prevPhase = this.clockPhase;
			this.clockPhase += 1;
			if (timing > 0 !== previous > 0) {
				const error = this.clockPhase > symbolPeriod / 2 ? this.clockPhase - symbolPeriod : this.clockPhase;
				this.clockPhase -= error * 0.05;
			}
			this.prevBpskI = filtI; this.prevBpskQ = filtQ;

			if (this.clockPhase >= symbolPeriod / 2 && prevPhase < symbolPeriod / 2) {
				const symI = this.prevHalfI - filtI;
				const symQ = this.prevHalfQ - filtQ;
				const parity = this.symbolIndex & 1;
				this.pairEnergy[parity] += symI * symI + symQ * symQ;
				if ((this.symbolIndex & 127) === 127) {
					const nextParity = this.pairEnergy[0] > this.pairEnergy[1] ? 0 : 1;
					if (nextParity !== this.pairParity) {
						this.pairParity = nextParity;
						this.prevSymI = 0; this.prevSymQ = 0;
						this.synced = false; this.bitCount = 0;
						this.blockValid.fill(false);
					}
					this.pairEnergy.fill(0);
				}
				if (parity === this.pairParity) {
					const diffProd = symI * this.prevSymI + symQ * this.prevSymQ;
					this.processBit(diffProd < 0 ? 1 : 0);
					this.prevSymI = symI; this.prevSymQ = symQ;
				}
				this.prevHalfI = filtI; this.prevHalfQ = filtQ;
				this.symbolIndex++;
			}
			if (this.clockPhase >= symbolPeriod) this.clockPhase -= symbolPeriod;
		}
	}

	private processBit(bit: number): void {
		this.shiftReg = ((this.shiftReg << 1) | bit) & 0x3ffffff;
		this.bitCount++;

		if (!this.synced) {
			if (this.bitCount >= 26) {
				const syn = computeSyndrome(this.shiftReg);
				const index = [SYNDROME_A, SYNDROME_B, SYNDROME_C, SYNDROME_D].indexOf(syn);
				const position = syn === SYNDROME_CP ? 2 : index;
				if (position !== -1) {
					this.synced = true;
					this.goodBlocks = 1;
					this.blockErrors = 0;
					this.blockValid.fill(false);
					this.blocks[position] = (this.shiftReg >> 10) & 0xffff;
					this.blockValid[position] = true;
					this.blockIndex = (position + 1) & 3;
					this.bitCount = 0;
				}
			}
			return;
		}

		if (this.bitCount < 26) return;
		this.bitCount = 0;
		if (this.blockIndex === 0) { this.goodBlocks = 0; this.blockValid.fill(false); }

		const syn = computeSyndrome(this.shiftReg);
		const expectedSyn = [SYNDROME_A, SYNDROME_B, SYNDROME_C, SYNDROME_D][this.blockIndex];
		const isValid = syn === expectedSyn || (this.blockIndex === 2 && syn === SYNDROME_CP);

		if (isValid) {
			this.blocks[this.blockIndex] = (this.shiftReg >> 10) & 0xffff;
			this.blockValid[this.blockIndex] = true;
			this.goodBlocks++;
			this.blockErrors = 0;
		} else {
			this.blockValid[this.blockIndex] = false;
			if (++this.blockErrors >= 8) {
				this.synced = false; this.goodBlocks = 0; this.blockErrors = 0;
				return;
			}
		}

		this.blockIndex = (this.blockIndex + 1) & 3;
		if (this.blockIndex === 0 && this.goodBlocks >= 2) this.decodeGroup();
		if (this.blockIndex === 0) { this.goodBlocks = 0; this.blockValid.fill(false); }
	}

	private acceptChar(pos: number, char: number, chars: Array<number | null>): void {
		if ((char === 0x0d && chars === this.rtChars) || (char >= 0x20 && char < 0x7f)) chars[pos] = char;
	}

	private decodeGroup(): void {
		const bv = this.blockValid;

		// PI — reset all state on station change
		if (bv[0]) {
			const pi = this.blocks[0];
			if (pi !== this.pi && pi !== 0) {
				this.psChars.fill(null); this.rtChars.fill(null); this.ptynChars.fill(null);
				this.lastPs = ''; this.lastRt = ''; this.lastPtyn = ''; this.lastCt = '';
				this.rtAbFlag = -1; this.rtVersion = -1;
				this.ecc = -1; this.lic = -1;
				this.afList = []; this.afCount = 0; this.afLastCount = -1;
				this.odaMap.clear(); this.eonMap.clear();
				this.rtPlusGroup = -1; this.rtPlusText1 = ''; this.rtPlusText2 = '';
				this.pi = pi;
				this.callback({ pi: pi.toString(16).toUpperCase().padStart(4, '0') });
			}
		}

		if (!bv[1]) return;
		const blockB    = this.blocks[1];
		const groupType = (blockB >> 12) & 0xf;
		const version   = (blockB >> 11) & 1;   // 0=A, 1=B
		const tp        = ((blockB >> 10) & 1) === 1;
		const pty       = (blockB >> 5) & 0x1f;

		if (tp !== this.tp) { this.tp = tp; this.callback({ tp }); }
		if (pty !== this.pty) {
			this.pty = pty;
			const labels = this.region === 'na' ? PTY_LABELS_NA : PTY_LABELS_EU;
			this.callback({ pty, ptyLabel: labels[pty] || '' });
		}

		switch (groupType) {
			case 0:  this.decodeGroup0(version, blockB, bv); break;
			case 1:  if (version === 0) this.decodeGroup1A(blockB, bv); break;
			case 2:  this.decodeGroup2(version, blockB, bv); break;
			case 3:  if (version === 0) this.decodeGroup3A(blockB, bv); break;
			case 4:  if (version === 0) this.decodeGroup4A(bv); break;
			case 10: if (version === 0) this.decodeGroup10A(blockB, bv); break;
			case 14: if (version === 0) this.decodeGroup14A(blockB, bv); break;
			default: this.decodeOdaGroup(groupType, version, blockB, bv); break;
		}
	}

	// ── Group 0: PS name + TA + AF ───────────────────────────────
	private decodeGroup0(version: number, blockB: number, bv: boolean[]): void {
		const ta = (blockB & 0x10) !== 0;
		if (ta !== this.ta) { this.ta = ta; this.callback({ ta }); }

		// AF Method A in block C (version 0 only)
		if (version === 0 && bv[2]) {
			const c = this.blocks[2];
			this.processAfPair((c >> 8) & 0xff, c & 0xff);
		}

		// PS name in block D
		if (bv[3]) {
			const seg = blockB & 0x03;
			const d = this.blocks[3];
			this.acceptChar(seg * 2,     (d >> 8) & 0xff, this.psChars);
			this.acceptChar(seg * 2 + 1, d & 0xff,        this.psChars);
			const ps = this.buildPS();
			if (ps && ps !== this.lastPs) { this.lastPs = ps; this.callback({ ps }); }
		}
	}

	private processAfPair(a: number, b: number): void {
		// AF count code (225-249 = N frequencies follow)
		if (a >= 225 && a <= 249) {
			const count = a - 224;
			if (count !== this.afLastCount) { this.afLastCount = count; this.afCount = count; this.afList = []; }
		} else {
			const fa = decodeAfCode(a, this.region);
			const fb = decodeAfCode(b, this.region);
			if (fa !== null && !this.afList.includes(fa)) this.afList.push(fa);
			if (fb !== null && !this.afList.includes(fb)) this.afList.push(fb);
			if (this.afList.length > 0 && (this.afCount <= 0 || this.afList.length >= this.afCount))
				this.callback({ af: [...this.afList] });
		}
	}

	// ── Group 1A: ECC, LIC, TMC flag, PIN ───────────────────────
	private decodeGroup1A(blockB: number, bv: boolean[]): void {
		void blockB;
		// PIN (Programme Item Number) in block D
		if (bv[3]) {
			const pin = this.blocks[3];
			if (pin !== 0) {
				this.callback({
					pin,
					pinDay:    (pin >> 11) & 0x1f,
					pinHour:   (pin >> 6)  & 0x1f,
					pinMinute:  pin        & 0x3f,
				});
			}
		}
		if (!bv[2]) return;
		const c = this.blocks[2];
		const variant = (c >> 12) & 0x7;
		switch (variant) {
			case 0: { // ECC
				const ecc = c & 0xff;
				if (ecc !== this.ecc) {
					this.ecc = ecc;
					this.callback({ ecc, countryName: eccToCountry(this.pi, ecc) });
				}
				break;
			}
			case 1: // TMC service identification
				this.callback({ hasTmc: true });
				break;
			case 3: { // LIC
				const lic = c & 0xff;
				if (lic !== this.lic) {
					this.lic = lic;
					this.callback({ lic, languageName: LIC_NAMES[lic] || 'Unknown' });
				}
				break;
			}
		}
	}

	// ── Group 2: RadioText ───────────────────────────────────────
	private decodeGroup2(version: number, blockB: number, bv: boolean[]): void {
		const abFlag = (blockB >> 4) & 1;
		if (abFlag !== this.rtAbFlag || version !== this.rtVersion) { this.rtChars.fill(null); this.lastRt = ''; }
		this.rtAbFlag = abFlag; this.rtVersion = version;
		const seg = blockB & 0x0f;
		if (version === 0) {
			if (bv[2]) { const c = this.blocks[2]; this.acceptChar(seg*4,   (c>>8)&0xff, this.rtChars); this.acceptChar(seg*4+1, c&0xff, this.rtChars); }
			if (bv[3]) { const d = this.blocks[3]; this.acceptChar(seg*4+2, (d>>8)&0xff, this.rtChars); this.acceptChar(seg*4+3, d&0xff, this.rtChars); }
		} else if (bv[3]) {
			const d = this.blocks[3];
			this.acceptChar(seg*2,   (d>>8)&0xff, this.rtChars);
			this.acceptChar(seg*2+1, d&0xff,      this.rtChars);
		}
		const rt = this.buildRT();
		if (rt && rt.length >= 4 && rt !== this.lastRt) { this.lastRt = rt; this.callback({ rt }); }
	}

	// ── Group 3A: ODA application identification ─────────────────
	private decodeGroup3A(blockB: number, bv: boolean[]): void {
		if (!bv[3]) return;
		const odaGroupNum = (blockB >> 1) & 0xf;
		const odaVersion  =  blockB & 1;
		const aid = this.blocks[3];
		const key = (odaGroupNum << 1) | odaVersion;
		this.odaMap.set(key, aid);
		if (aid === 0x4BD7) this.rtPlusGroup = key;
		const appName = ODA_AIDS[aid] ?? `ODA 0x${aid.toString(16).toUpperCase()}`;
		this.callback({ odaAid: aid, odaGroup: odaGroupNum, odaVersion });
		void appName;
	}

	// ── Group 4A: Clock Time (CT) ────────────────────────────────
	private decodeGroup4A(bv: boolean[]): void {
		if (!bv[1] || !bv[2] || !bv[3]) return;
		const b = this.blocks[1], c = this.blocks[2], d = this.blocks[3];
		// Modified Julian Day from blocks B+C
		const mjd = ((b & 0x3) << 15) | (c >> 1);
		const hours   = ((c & 1) << 4) | (d >> 12);
		const minutes = (d >> 6) & 0x3f;
		const offsetHalf = (d >> 1) & 0x1f;
		const utcOffset  = (d & 1) ? -offsetHalf : offsetHalf;
		// MJD to Gregorian calendar (IEC 62106 Annex G)
		const yp = Math.trunc((mjd - 15078.2) / 365.25);
		const mp = Math.trunc((mjd - 14956.1 - Math.trunc(yp * 365.25)) / 30.6001);
		const day   = mjd - 14956 - Math.trunc(yp * 365.25) - Math.trunc(mp * 30.6001);
		const k     = (mp === 14 || mp === 15) ? 1 : 0;
		const year  = yp + k + 1900;
		const month = mp - 1 - k * 12;
		const p2 = (n: number) => String(n).padStart(2, '0');
		const ct = `${year}-${p2(month)}-${p2(day)} ${p2(hours)}:${p2(minutes)}`;
		if (ct !== this.lastCt) { this.lastCt = ct; this.callback({ ct, ctUtcOffset: utcOffset }); }
	}

	// ── Group 10A: Programme Type Name (PTYN) ────────────────────
	private decodeGroup10A(blockB: number, bv: boolean[]): void {
		const seg = blockB & 1;
		if (bv[2]) { const c = this.blocks[2]; this.acceptChar(seg*4,   (c>>8)&0xff, this.ptynChars); this.acceptChar(seg*4+1, c&0xff, this.ptynChars); }
		if (bv[3]) { const d = this.blocks[3]; this.acceptChar(seg*4+2, (d>>8)&0xff, this.ptynChars); this.acceptChar(seg*4+3, d&0xff, this.ptynChars); }
		if (!this.ptynChars.includes(null)) {
			const ptyn = String.fromCharCode(...(this.ptynChars as number[])).trimEnd();
			if (ptyn && ptyn !== this.lastPtyn) { this.lastPtyn = ptyn; this.callback({ ptyn }); }
		}
	}

	// ── Group 14A: Enhanced Other Networks (EON) ─────────────────
	private decodeGroup14A(blockB: number, bv: boolean[]): void {
		if (!bv[3]) return;
		const eonPi = this.blocks[3];
		if (!eonPi) return;
		if (!this.eonMap.has(eonPi))
			this.eonMap.set(eonPi, { psChars: new Array<number | null>(8).fill(null), tp: false, ta: false, af: [] });
		const eon = this.eonMap.get(eonPi)!;
		const variant = blockB & 0xf;
		eon.tp = ((blockB >> 4) & 1) === 1;
		if (variant <= 3 && bv[2]) {
			const c = this.blocks[2];
			eon.psChars[variant * 2]     = (c >> 8) & 0xff;
			eon.psChars[variant * 2 + 1] = c & 0xff;
		} else if (variant === 4 && bv[2]) {
			const c = this.blocks[2];
			const fa = decodeAfCode((c >> 8) & 0xff, this.region);
			const fb = decodeAfCode(c & 0xff, this.region);
			if (fa !== null && !eon.af.includes(fa)) eon.af.push(fa);
			if (fb !== null && !eon.af.includes(fb)) eon.af.push(fb);
		} else if (variant === 13) {
			eon.ta = ((blockB >> 3) & 1) === 1;
		}
		const ps = eon.psChars.every(ch => ch !== null)
			? String.fromCharCode(...(eon.psChars as number[]))
			: undefined;
		this.callback({
			eon: {
				pi: eonPi.toString(16).toUpperCase().padStart(4, '0'),
				ps, tp: eon.tp, ta: eon.ta,
				af: eon.af.length ? [...eon.af] : undefined,
			}
		});
	}

	// ── ODA data groups (5-9, 11-13) + RT+ ──────────────────────
	private decodeOdaGroup(groupNum: number, version: number, blockB: number, bv: boolean[]): void {
		const key = (groupNum << 1) | version;
		const aid = this.odaMap.get(key);
		// Forward raw ODA payload for any consumer (TMC decoder, pager, etc.)
		if (aid !== undefined && bv[2] && bv[3])
			this.callback({ odaData: { group: groupNum, version, b: blockB & 0x1f, c: this.blocks[2], d: this.blocks[3] } });
		// RT+ decode when this is the group registered for it
		if (key === this.rtPlusGroup && bv[1] && bv[2] && bv[3])
			this.decodeRtPlus(blockB, this.blocks[2], this.blocks[3]);
	}

	// ── RT+ tag extraction (IEC 62106-6) ────────────────────────
	private decodeRtPlus(b: number, c: number, d: number): void {
		const running  = (b >> 3) & 1;
		const tag1Type  = ((b & 0x7) << 3) | (c >> 13);
		const tag1Start = (c >> 7) & 0x3f;
		const tag1Len   = (c >> 1) & 0x3f;
		const tag2Type  = ((c & 1) << 5) | (d >> 11);
		const tag2Start = (d >> 5) & 0x3f;
		const tag2Len   =  d       & 0x1f;
		const rt = this.lastRt;
		const extract = (s: number, l: number) => s < rt.length ? rt.slice(s, Math.min(s + l + 1, rt.length)).trim() : '';
		const t1 = tag1Type > 0 && running ? extract(tag1Start, tag1Len) : '';
		const t2 = tag2Type > 0 && running ? extract(tag2Start, tag2Len) : '';
		if ((t1 && t1 !== this.rtPlusText1) || (t2 && t2 !== this.rtPlusText2)) {
			this.rtPlusText1 = t1; this.rtPlusText2 = t2;
			this.rtPlusTag1 = tag1Type; this.rtPlusTag2 = tag2Type;
			this.callback({
				rtPlusItem1: t1 || undefined, rtPlusItem1Tag: tag1Type || undefined,
				rtPlusItem2: t2 || undefined, rtPlusItem2Tag: tag2Type || undefined,
			});
		}
	}

	private buildPS(): string | null {
		if (this.psChars.some(c => c === null)) return null;
		return String.fromCharCode(...(this.psChars as number[]));
	}

	private buildRT(): string | null {
		let s = '';
		for (const char of this.rtChars) {
			if (char === null || char === 0x0d) break;
			s += String.fromCharCode(char);
		}
		return s.trimEnd() || null;
	}

	reset(): void {
		this.synced = false; this.blockIndex = 0; this.goodBlocks = 0;
		this.blockErrors = 0; this.blockValid.fill(false);
		this.bitCount = 0; this.shiftReg = 0;
		this.pi = 0; this.pty = -1; this.tp = false; this.ta = false;
		this.psChars.fill(null); this.rtChars.fill(null); this.ptynChars.fill(null);
		this.rtAbFlag = -1; this.rtVersion = -1;
		this.lastPs = ''; this.lastRt = ''; this.lastCt = ''; this.lastPtyn = '';
		this.ecc = -1; this.lic = -1;
		this.afList = []; this.afCount = 0; this.afLastCount = -1;
		this.odaMap.clear(); this.eonMap.clear();
		this.rtPlusGroup = -1; this.rtPlusText1 = ''; this.rtPlusText2 = '';
		this.phasorRe = 1; this.phasorIm = 0; this.phasorCount = 0;
		this.pilotMixI = 0; this.pilotMixQ = 0; this.pilotBpf.reset();
		this.clockPhase = 0; this.prevBpskI = 0; this.prevBpskQ = 0;
		this.clockPowerI = 0; this.clockPowerQ = 0; this.clockUsesQ = false;
		this.symbolIndex = 0; this.pairEnergy.fill(0); this.pairParity = -1;
		this.prevHalfI = 0; this.prevHalfQ = 0; this.prevSymI = 0; this.prevSymQ = 0;
		for (const bq of this.bqI) bq.reset();
		for (const bq of this.bqQ) bq.reset();
	}
}
