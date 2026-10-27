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

// ── BCH 1-bit error correction table ────────────────────────────
// For each offset, maps syndrome -> bit position to flip (0-25, or -1 = no 1-bit correction).
// Built once at module load. Handles the 26-bit block (16-bit data + 10-bit checkword).
function buildFecTable(offsetWord: number): Map<number, number> {
	const table = new Map<number, number>();
	for (let bit = 0; bit < 26; bit++) {
		// Flip one bit in a valid block (data=0, checkword=offset) and compute syndrome
		const block = (0 << 10) | offsetWord; // valid block with data=0
		const flipped = (block ^ (1 << (25 - bit))) & 0x3ffffff;
		const syn = calcSyndrome(flipped);
		if (syn !== 0) table.set(syn, bit);
	}
	return table;
}
const FEC_A  = buildFecTable(OFFSET_A);
const FEC_B  = buildFecTable(OFFSET_B);
const FEC_C  = buildFecTable(OFFSET_C);
const FEC_CP = buildFecTable(OFFSET_CP);
const FEC_D  = buildFecTable(OFFSET_D);
const FEC_TABLES = [FEC_A, FEC_B, FEC_C, FEC_D];

// ── RDS decoder status ───────────────────────────────────────────
export interface RdsStatus {
	synced: boolean;
	ber: number;         // bit error rate 0.0-1.0 (rolling window)
	goodBlocks: number;  // clean + corrected blocks in current group
	correctedBlocks: number; // BCH-corrected blocks this session (rolling)
	totalBlocks: number;     // total blocks processed (rolling)
	pilotLevel: number;  // 19 kHz pilot RMS power (0-1 approx)
}

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

// ── PI coverage area codes (EN 50067 Annex D.4) ─────────────────
const COVERAGE_NAMES: Record<number, string> = {
	0: 'Local', 1: 'International', 2: 'National', 3: 'Supra-regional',
	4: 'R1', 5: 'R2', 6: 'R3', 7: 'R4', 8: 'R5', 9: 'R6',
	0xA: 'R7', 0xB: 'R8', 0xC: 'R9', 0xD: 'R10', 0xE: 'R11', 0xF: 'R12',
};

// ── RBDS callsign decode (NRSC-4-B Annex D) ─────────────────────
// Standard 4-letter: PI 0x1000-0x54A7 -> K+3 letters, 0x54A8-0x994F -> W+3 letters
// 3-letter exceptions: 0x9950-0x9EFF (abbreviated legacy callsigns)
function rbdsCallsign(pi: number): string | null {
	// Nibble-zero adjustments per NRSC-4-B D.7
	if ((pi & 0xFFF0) === 0xAFA0 && (pi & 0xF) < 0xA) pi = (pi << 12) & 0xFFFF;
	else if ((pi & 0xFF00) === 0xAF00) pi = (pi << 8) & 0xFFFF;
	else if ((pi & 0xF000) === 0xA000) pi = (((pi & 0x0F00) << 4) | (pi & 0x00FF)) & 0xFFFF;

	if (pi >= 0x1000 && pi <= 0x994F) {
		let prefix: string, val: number;
		if (pi <= 0x54A7) { prefix = 'K'; val = pi - 0x1000; }
		else              { prefix = 'W'; val = pi - 0x54A8; }
		return prefix +
			String.fromCharCode(65 + Math.trunc(val / 676) % 26) +
			String.fromCharCode(65 + Math.trunc(val / 26) % 26) +
			String.fromCharCode(65 + val % 26);
	}
	return null;
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
// Returns frequency in units of kHz*10 (i.e. 100 Hz) for FM.
// LF/MF frequencies use decodeLfMfCode() instead.
// Codes 224-249 = count codes; 250 = LF/MF follows; 205 = filler -- all handled in processAfPair.
function decodeAfCode(code: number, region: string): number | null {
	if (code >= 1 && code <= 204) {
		if (region === 'na') return Math.round((879 + (code - 4) * 2) * 100);
		return Math.round((875 + code) * 100);
	}
	return null;
}

// Decode a LF/MF code directly (code 1-135).
// Region affects MF: RDS (EU) uses 9 kHz grid from 531 kHz; RBDS (NA) uses 10 kHz from 540 kHz.
// Returns frequency in kHz (not kHz*10 like FM).
function decodeLfMfCode(code: number, region = 'eu'): number | null {
	if (code >= 1 && code <= 15)   return 153 + (code - 1) * 9;               // LF: same for both regions
	if (code >= 16 && code <= 135) return region === 'na'
		? 540 + (code - 16) * 10   // RBDS: 540-1700 kHz, 10 kHz grid
		: 531 + (code - 16) * 9;   // RDS: 531-1602 kHz, 9 kHz grid
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

// ── IEC 62106 Annex E — RDS character set (EU only; RBDS uses ASCII) ─────────
// Maps code points 0x00-0xFF to Unicode strings. The lower 128 mostly match
// ASCII with a few exceptions (0x24=¤, 0x5E=―, 0x60=║, 0x7E=¯, 0x7F=DEL→space).
// The upper 128 are European accented/special characters.
// Source: osmocom-analog src/radio/rds_tables.c rds_charmap[].
const RDS_CHARSET: string[] = [
	// 0x00-0x0F control (map to space except LF/CR)
	' ',' ',' ',' ',' ',' ',' ',' ',' ',' ','\n',' ',' ','\r',' ',' ',
	// 0x10-0x1F
	' ',' ',' ',' ',' ',' ',' ',' ',' ',' ',' ',' ',' ',' ',' ',' ',
	// 0x20-0x2F  (0x24 = ¤ currency sign, not $)
	' ','!','"','#','¤','%','&',"'",'(',')','+','+',',','-','.','/',
	// 0x30-0x3F
	'0','1','2','3','4','5','6','7','8','9',':',';','<','=','>','?',
	// 0x40-0x4F
	'@','A','B','C','D','E','F','G','H','I','J','K','L','M','N','O',
	// 0x50-0x5F  (0x5E = ― horizontal bar, 0x5F = _)
	'P','Q','R','S','T','U','V','W','X','Y','Z','[','\\',']','―','_',
	// 0x60-0x6F  (0x60 = ║ double vertical bar)
	'║','a','b','c','d','e','f','g','h','i','j','k','l','m','n','o',
	// 0x70-0x7F  (0x7E = ¯ macron, 0x7F = space)
	'p','q','r','s','t','u','v','w','x','y','z','{','|','}','¯',' ',
	// 0x80-0x8F
	'á','à','é','è','í','ì','ó','ò','ú','ù','Ñ','Ç','Ş','ß','¡','Ĳ',
	// 0x90-0x9F
	'â','ä','ê','ë','î','ï','ô','ö','û','ü','ñ','ç','ş','ğ','ı','ĳ',
	// 0xA0-0xAF
	'ª','α','©','‰','Ğ','ě','ň','ő','π','€','£','$','←','↑','→','↓',
	// 0xB0-0xBF
	'º','¹','²','³','±','İ','ń','ű','µ','¿','÷','°','¼','½','¾','§',
	// 0xC0-0xCF
	'Á','À','É','È','Í','Ì','Ó','Ò','Ú','Ù','Ř','Č','Š','Ž','Đ','Ŀ',
	// 0xD0-0xDF
	'Â','Ä','Ê','Ë','Î','Ï','Ô','Ö','Û','Ü','ř','č','š','ž','đ','ŀ',
	// 0xE0-0xEF
	'Ã','Å','Æ','Œ','Ŷ','Ý','Õ','Ø','Þ','Ŋ','Ŕ','Ć','Ś','Ź','Ŧ','ð',
	// 0xF0-0xFF
	'ã','å','æ','œ','ŵ','ý','õ','ø','þ','ŋ','ŕ','ć','ś','ź','ŧ',' ',
];

/** Decode one RDS byte to a string using the region's charset.
 *  EU uses IEC 62106 Annex E; RBDS/NA uses plain ASCII. */
function rdsChar(code: number, region: string): string {
	if (region === 'na') return code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : ' ';
	return RDS_CHARSET[code] ?? ' ';
}



// ── RT+ content type names (IEC 62106-6 Table A.1) ──────────────
const RTPLUS_TYPES: (string | null)[] = [
	null,                    // 0: dummy_class (no tag)
	'Title', 'Album', 'Track#', 'Artist', 'Composition', 'Movement',
	'Conductor', 'Composer', 'Band', 'Comment', 'Genre',           // 1-11
	'News', 'Local News', 'Stock Market', 'Sport', 'Lottery',
	'Horoscope', 'Daily Div.', 'Health', 'Event', 'Scene',
	'Cinema', 'TV', 'Date/Time', 'Weather', 'Traffic',
	'Alarm', 'Ad', 'URL', 'Other Info',                           // 12-30
	'Station (short)', 'Station (long)',                          // 31-32
	'Prog. Now', 'Prog. Next', 'Prog. Part', 'Host',
	'Editorial', 'Frequency', 'Homepage', 'Subchannel',           // 33-40
	'Hotline', 'Studio Phone', 'Other Phone',                     // 41-43
	'SMS Studio', 'SMS Other',                                    // 44-45
	'Email Hotline', 'Email Studio', 'Email Other',               // 46-48
	'MMS', 'Chat', 'Chat Centre', 'Vote Q', 'Vote Centre',        // 49-53
	null, null, null, null, null,                                  // 54-58: reserved
	'Place', 'Appointment', 'Identifier', 'Purchase', 'Get Data', // 59-63
];

export class RDSDecoder {
	private callback: (msg: RDSMessage) => void;
	private region: string;
	// Current group label injected into every callback as srcGroup
	private currentGroup = '';

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
	private pairParity = 0;  // start decoding immediately; self-corrects
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
	private blockCorrected: boolean[] = [false, false, false, false]; // true = passed via BCH correction
	private blockErrors = 0;
	private nbUnsync = 0;  // consecutive groups with no valid blocks

	// BER tracking -- rolling window over last 100 blocks
	private readonly BER_WINDOW = 100;
	private berHistory: Uint8Array = new Uint8Array(100).fill(1); // 1=bad, 0=good/corrected
	private berHead = 0;
	private berSum = 100;  // count of bad blocks in window (starts fully bad)
	private berCorrectedBlocks = 0; // session corrected block count
	private berTotalBlocks = 0;     // session total block count

	// Pilot power tracking (19 kHz, proxy for RDS signal quality)
	private pilotPower = 0;

	// ── Decoded RDS data ──────────────────────────────────────────
	private pi = 0;
	private pty = -1;
	private tp = false;
	private ta = false;
	private psChars: Array<string | null> = new Array<string | null>(8).fill(null);
	private psStatus: number[] = new Array<number>(8).fill(0);
	private rtChars: Array<string | null> = new Array<string | null>(64).fill(null);
	private rtStatus: number[] = new Array<number>(64).fill(0);
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
	// Group 0/15B — MS and DI
	private ms = -1;          // last emitted M/S (-1=unknown)
	private diWord = -1;      // assembled 4-bit DI codeword (-1=incomplete)
	private diBits = new Int8Array(4).fill(-1); // d3..d0 indexed by seg (0-3)

	// Group 3A — ODA application registration: (groupNum<<1)|version → AID
	private odaMap: Map<number, number> = new Map();
	// Group 3A message bits: key → block C value (app-specific config, e.g. RT+ CB/SCB/template)
	private odaMsg: Map<number, number> = new Map();

	// RT+ (ODA AID 0x4BD7)
	private rtPlusGroup = -1;
	private rtPlusText1 = '';
	private rtPlusText2 = '';
	private rtPlusTag1 = 0;
	private rtPlusTag2 = 0;
	private rtPlusToggle = -1;   // last seen toggle bit (-1=unknown)
	private rtPlusRunning = -1;  // last seen item_running bit

	// eRT+ (ODA AID 0x4BD8): RT+ operating on eRT text -- fully separate from RT+
	private eRTPlusGroup = -1;
	private eRTPlusCb = 0;        // cb bit from 3A: 0=RT source, 1=eRT source
	private eRTPlusText1 = '';
	private eRTPlusText2 = '';
	private eRTPlusTag1 = 0;
	private eRTPlusTag2 = 0;
	private eRTPlusToggle = -1;
	private eRTPlusRunning = -1;

	// TMC (ODA AIDs 0x4D2C / 0xCD46 / 0xCD47)
	private tmcGroup = -1;
	// Multi-group TMC reassembly: continuity index -> partial parts
	private tmcContinuity = 0;
	private tmcParts: Array<{ y: number; z: number } | null> = [null, null, null, null, null];

	// eRT -- Enhanced RadioText (ODA AID 0x6552, IEC 62106-6)
	// Wire format: identical to Group 2A (4-bit segment, A/B flag, 4 bytes/group)
	// but carries up to 128 bytes of raw UTF-8 text, CR-terminated.
	private eRTGroup = -1;
	private eRTBytes: Uint8Array = new Uint8Array(128);
	private eRTFilled: boolean[] = new Array<boolean>(128).fill(false);
	private eRTQuality: number[] = new Array<number>(128).fill(0);
	private eRTAbFlag = -1;
	private lastERT = '';

	// Group 4A — CT clock
	private lastCt = '';

	// Group 10A — PTYN
	private ptynChars: Array<string | null> = new Array<string | null>(8).fill(null);
	private ptynStatus: number[] = new Array<number>(8).fill(0);
	private lastPtyn = '';
	private ptynAbFlag = -1;

	// Group 14A — EON
	private eonMap: Map<number, {
		psChars: (string | null)[];
		tp: boolean; ta: boolean;
		af: number[];
		mappedFreqs: Array<{ tuned: number; other: number }>;
		ptyOn: number;
		pinDay: number; pinHour: number; pinMinute: number;
		// Variant 12: Linkage Set Number and flags
		lsn: number; lsIls: boolean; lsEg: boolean; lsLa: boolean;
		lastKey: string;
	}> = new Map();

	constructor(sampleRate: number, callback: (msg: RDSMessage) => void, region = 'eu') {
		// Wrap callback to auto-inject srcGroup from the current group being decoded
		this.callback = (msg: RDSMessage) => callback({ srcGroup: this.currentGroup || undefined, ...msg });
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
		if (this.pi) {
			this.callback({ piCallsign: region === 'na' ? rbdsCallsign(this.pi) : null });
		}
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
			// Track pilot power (slow IIR for status reporting)
			this.pilotPower += 0.0001 * (pp - this.pilotPower);
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
				if ((this.symbolIndex & 799) === 0) {
					const nextParity = this.pairEnergy[0] > this.pairEnergy[1] ? 0 : 1;
					if (nextParity !== this.pairParity) {
						this.pairParity = nextParity;
						this.prevSymI = 0; this.prevSymQ = 0;
						// Switch parity silently -- do NOT lose sync
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

		this.berTotalBlocks++;

		if (isValid) {
			this.blocks[this.blockIndex] = (this.shiftReg >> 10) & 0xffff;
			this.blockValid[this.blockIndex] = true;
			this.blockCorrected[this.blockIndex] = false; // clean
			this.goodBlocks++;
			this.blockErrors = 0;
			// BER: good block
			this.berSum -= this.berHistory[this.berHead];
			this.berHistory[this.berHead] = 0;
			this.berHead = (this.berHead + 1) % this.BER_WINDOW;
		} else {
			// Attempt BCH 1-bit correction
			const fecTable = this.blockIndex === 2 && syn !== expectedSyn
				? (FEC_TABLES[this.blockIndex].get(syn) !== undefined ? FEC_TABLES[this.blockIndex] : FEC_CP)
				: FEC_TABLES[this.blockIndex];
			const errBit = fecTable.get(syn);
			if (errBit !== undefined) {
				// Correctable 1-bit error
				const corrected = (this.shiftReg ^ (1 << (25 - errBit))) & 0x3ffffff;
				this.blocks[this.blockIndex] = (corrected >> 10) & 0xffff;
				this.blockValid[this.blockIndex] = true;
				this.blockCorrected[this.blockIndex] = true;
				this.goodBlocks++;
				this.blockErrors = 0;
				this.berCorrectedBlocks++;
				// BER: corrected block counts as partial error
				this.berSum -= this.berHistory[this.berHead];
				this.berHistory[this.berHead] = 0; // still counts as received
				this.berHead = (this.berHead + 1) % this.BER_WINDOW;
			} else {
				this.blockValid[this.blockIndex] = false;
				// BER: bad block
				this.berSum -= this.berHistory[this.berHead];
				this.berHistory[this.berHead] = 1;
				this.berHead = (this.berHead + 1) % this.BER_WINDOW;
				this.berSum++;
				if (++this.blockErrors >= 16) {
					// Only lose sync after many consecutive bad blocks
					this.synced = false; this.goodBlocks = 0; this.blockErrors = 0;
					return;
				}
			}
		}

		this.blockIndex = (this.blockIndex + 1) & 3;
		if (this.blockIndex === 0 && this.goodBlocks >= 2) this.decodeGroup();
		if (this.blockIndex === 0) {
			if (this.goodBlocks === 0) {
				if (++this.nbUnsync >= 4) {
					this.synced = false; this.nbUnsync = 0;
				}
			} else {
				this.nbUnsync = 0;
			}
			this.goodBlocks = 0; this.blockValid.fill(false); this.blockErrors = 0;
		}
	}

	// quality: 0=clean block, 1=BCH-corrected, 2=uncorrectable/lost
	private acceptChar(pos: number, code: number, chars: Array<string | null>, status: number[], quality: number): void {
		if (code === 0x0d && chars === this.rtChars) { chars[pos] = '\r'; return; }
		if (code === 0x00) return;
		// Only overwrite if new data is better quality (lower = better).
		// On first receive (null) always accept. On retransmission keep best char.
		if (chars[pos] !== null && quality > status[pos]) return;
		chars[pos] = rdsChar(code, this.region);
		status[pos] = quality;
	}

	private decodeGroup(): void {
		const bv = this.blockValid;

		// PI — reset all state on station change
		if (bv[0]) {
			const pi = this.blocks[0];
			if (pi !== this.pi && pi !== 0) {
				this.psChars.fill(null); this.psStatus.fill(0);
				this.rtChars.fill(null); this.rtStatus.fill(0);
				this.ptynChars.fill(null); this.ptynStatus.fill(0);
				this.lastPs = ''; this.lastRt = ''; this.lastPtyn = ''; this.lastCt = '';
				this.rtAbFlag = -1; this.rtVersion = -1;
				this.ecc = -1; this.lic = -1;
				this.afList = []; this.afCount = 0; this.afLastCount = -1;
				this.odaMap.clear(); this.eonMap.clear(); this.odaMsg.clear();
				this.rtPlusGroup = -1; this.rtPlusText1 = ''; this.rtPlusText2 = '';
				this.pi = pi;
				const piCc       = (pi >> 12) & 0xf;
				const piCoverage = (pi >> 8) & 0xf;
				const piRef      = pi & 0xff;
				const isRbds     = this.region === 'na';
				this.callback({
					pi: pi.toString(16).toUpperCase().padStart(4, '0'),
					piCc, piCoverage,
					piCoverageName: COVERAGE_NAMES[piCoverage] ?? '--',
					piRef,
					piCallsign: isRbds ? rbdsCallsign(pi) : null,
				});
			}
		}

		if (!bv[1]) return;
		const blockB    = this.blocks[1];
		const groupType = (blockB >> 12) & 0xf;
		const version   = (blockB >> 11) & 1;   // 0=A, 1=B
		const tp        = ((blockB >> 10) & 1) === 1;
		const pty       = (blockB >> 5) & 0x1f;

		// Track current group label for callback metadata
		this.currentGroup = `${groupType}${version === 0 ? 'A' : 'B'}`;

		if (tp !== this.tp) { this.tp = tp; this.callback({ tp, srcGroup: this.currentGroup }); }
		if (pty !== this.pty) {
			this.pty = pty;
			const labels = this.region === 'na' ? PTY_LABELS_NA : PTY_LABELS_EU;
			this.callback({ pty, ptyLabel: labels[pty] || '', srcGroup: this.currentGroup });
		}

		switch (groupType) {
			case 0:  this.decodeGroup0(version, blockB, bv); break;
			case 1:  if (version === 0) this.decodeGroup1A(blockB, bv); else this.decodeGroup1B(blockB, bv); break;
			case 2:  this.decodeGroup2(version, blockB, bv); break;
			case 3:  if (version === 0) this.decodeGroup3A(blockB, bv); break;
			case 4:  if (version === 0) this.decodeGroup4A(bv); break;
			case 7:  if (version === 0 && this.rpc > 0) this.decodeGroup7A(blockB, bv); break;
			case 10: if (version === 0) this.decodeGroup10A(blockB, bv); break;
			case 14: if (version === 0) this.decodeGroup14A(blockB, bv); else this.decodeGroup14B(blockB, bv); break;
			case 15: if (version === 1) this.decodeGroup15B(blockB); break;
			default: this.decodeOdaGroup(groupType, version, blockB, bv); break;
		}
	}

	/** 0=clean, 1=BCH-corrected, 2=invalid/lost. */
	private blockQuality(idx: number): number {
		if (!this.blockValid[idx]) return 2;
		return this.blockCorrected[idx] ? 1 : 0;
	}

	// ── Group 0: PS name + TA + MS + DI ─────────────────────────
	private decodeGroup0(version: number, blockB: number, bv: boolean[]): void {
		const ta = (blockB & 0x10) !== 0;
		if (ta !== this.ta) { this.ta = ta; this.callback({ ta }); }

		// M/S (Music/Speech) switch: block B bit 3
		const ms = (blockB & 0x08) !== 0;
		if (ms !== (this.ms === 1)) {
			this.ms = ms ? 1 : 0;
			this.callback({ ms });
		}

		// DI bit: block B bit 2; segment address from bits [1:0]
		// 4 groups assemble d3(seg0) d2(seg1) d1(seg2) d0(seg3) -- MSB first
		// seg=C1C0: 00->d3, 01->d2, 10->d1, 11->d0
		const seg  = blockB & 0x03;
		const diBit = (blockB >> 2) & 1;
		// d3 is transmitted in seg=0, d2 in seg=1, d1 in seg=2, d0 in seg=3
		this.diBits[3 - seg] = diBit;
		if (!this.diBits.includes(-1)) {
			const di = (this.diBits[3] << 3) | (this.diBits[2] << 2) | (this.diBits[1] << 1) | this.diBits[0];
			if (di !== this.diWord) {
				this.diWord = di;
				this.callback({
					di,
					diStereo:     (di & 1) !== 0,
					diArtHead:    (di & 2) !== 0,
					diCompressed: (di & 4) !== 0,
					diDynPty:     (di & 8) !== 0,
				});
			}
		}

		// AF Method A in block C (version 0 only)
		if (version === 0 && bv[2]) {
			const c = this.blocks[2];
			this.processAfPair((c >> 8) & 0xff, c & 0xff);
		}

		// PS name in block D
		if (bv[3]) {
			const d = this.blocks[3];
			const q = this.blockQuality(3);
			this.acceptChar(seg * 2,     (d >> 8) & 0xff, this.psChars, this.psStatus, q);
			this.acceptChar(seg * 2 + 1, d & 0xff,        this.psChars, this.psStatus, q);
			const ps = this.buildPS();
			if (ps && ps !== this.lastPs) { this.lastPs = ps; this.callback({ ps, psCharStatus: [...this.psStatus] }); }
		}
	}

	// ── Group 15B: Fast basic tuning (TA + MS + DI, no PS/AF) ───
	private decodeGroup15B(blockB: number): void {
		const ta = (blockB & 0x10) !== 0;
		if (ta !== this.ta) { this.ta = ta; this.callback({ ta }); }
		const ms = (blockB & 0x08) !== 0;
		if (ms !== (this.ms === 1)) {
			this.ms = ms ? 1 : 0;
			this.callback({ ms });
		}
		const seg   = blockB & 0x03;
		const diBit = (blockB >> 2) & 1;
		this.diBits[3 - seg] = diBit;
		if (!this.diBits.includes(-1)) {
			const di = (this.diBits[3] << 3) | (this.diBits[2] << 2) | (this.diBits[1] << 1) | this.diBits[0];
			if (di !== this.diWord) {
				this.diWord = di;
				this.callback({ di, diStereo: (di & 1) !== 0, diArtHead: (di & 2) !== 0, diCompressed: (di & 4) !== 0, diDynPty: (di & 8) !== 0 });
			}
		}
	}

	private afLfMfNext = false; // true when previous code was 250 (LF/MF follows)
	private afMethodB  = false; // true when transmitting in Method B (tuning freq pairs)

	private processAfPair(a: number, b: number): void {
		// Code 205 = filler, 224 = no AF, 225-249 = N AFs follow (Method A count)
		// Code 250 = LF/MF frequency follows (next code is LF/MF, not FM)
		// Codes 1-204 = FM frequency; 1-135 = LF/MF (when preceded by 250)

		// Handle LF/MF carry-over from previous pair
		if (this.afLfMfNext) {
			const fa = decodeLfMfCode(a, this.region);  // returns kHz directly
			if (fa !== null && !this.afList.includes(fa)) this.afList.push(fa);
			this.afLfMfNext = false;
			// b is the next normal code
			a = b; b = 0;
		}

		// Process first code
		if (a === 205) {
			// Filler -- no action
		} else if (a === 224) {
			// No AF available
			if (this.afList.length !== 0) { this.afList = []; this.callback({ af: [] }); }
		} else if (a >= 225 && a <= 249) {
			// Method A: count code -- N frequencies follow
			const count = a - 224;
			if (count !== this.afLastCount) { this.afLastCount = count; this.afCount = count; this.afList = []; this.afMethodB = false; }
		} else if (a === 250) {
			// LF/MF follows in next code
			this.afLfMfNext = true;
		} else if (a >= 1 && a <= 204) {
			if (this.afMethodB) {
				// Method B: a=tuning freq (TN), b=alternative freq (ON) -- store b only
				const fb = decodeAfCode(b, this.region);
				if (fb !== null && !this.afList.includes(fb)) {
					this.afList.push(fb);
					this.callback({ af: [...this.afList], afMethod: 'B' });
				}
				return; // already consumed b
			}
			// Method A: plain frequency
			const fa = decodeAfCode(a, this.region);
			if (fa !== null && !this.afList.includes(fa)) this.afList.push(fa);
		}

		// Process second code (only when not already consumed above)
		if (!this.afLfMfNext && b !== 0) {
			if (b === 205) {
				// Filler
			} else if (b === 250) {
				this.afLfMfNext = true;
			} else if (b >= 1 && b <= 204) {
				const fb = decodeAfCode(b, this.region);
				if (fb !== null && !this.afList.includes(fb)) this.afList.push(fb);
			}
		}

		// Detect Method B: if a valid FM frequency appears as first code while count=0
		// (no preceding count code), infer Method B. Per standard: "no explicit signalling"
		if (!this.afMethodB && a >= 1 && a <= 204 && this.afCount <= 0) {
			this.afMethodB = true;
		}

		if (this.afList.length > 0 && (this.afCount <= 0 || this.afList.length >= this.afCount))
			this.callback({ af: [...this.afList], afMethod: this.afMethodB ? 'B' : 'A' });
	}
	// ── Group 1A: ECC, LIC, TMC flag, PIN ───────────────────────
	// 1A paging state (suppress duplicate callbacks)
	private rpc = -1;
	private la = false;
	private opc0 = -1;         // OPC from variant 0 (ECC block)
	private pagingOpc = -1;
	private pagingPac = -1;
	private ewsChannel = -1;
	private broadcasterData = -1;
	private lastTmcId = -1;
	private lastPin = -1;

	private decodeGroup1A(blockB: number, bv: boolean[]): void {
		// Block B bits [4:0]: Radio Paging Codes (EN 50067 Annex M, M.2.1.1.2)
		//   bits [4:2]: transmitter network group designation (0=no paging)
		//   bits [1:0]: battery-saving interval sync
		const rpc = blockB & 0x1f;
		if (rpc !== this.rpc) {
			this.rpc = rpc;
			this.callback({
				rpc,
				rpcGroupDesig: (rpc >> 2) & 0x7,
				rpcBattSync:    rpc & 0x3,
			});
		}

		// Block D: Programme Item Number (day[15:11] hour[10:6] minute[5:0])
		// Broadcast once per second -- suppress if unchanged.
		// pinDay=0 means no valid PIN (spec page 24 note 3).
		if (bv[3]) {
			const pin = this.blocks[3];
			if (pin !== this.lastPin) {
				this.lastPin = pin;
				const pinDay = (pin >> 11) & 0x1f;
				this.callback({ pin, pinDay, pinHour: (pin >> 6) & 0x1f, pinMinute: pin & 0x3f });
			}
		}

		if (!bv[2]) return;
		const c = this.blocks[2];

		// Block C bit [15]: Linkage Actuator (LA) -- present on ALL variants
		const la = ((c >> 15) & 1) !== 0;
		if (la !== this.la) {
			this.la = la;
			this.callback({ la });
		}

		// Block C bits [14:12]: variant code; bits [11:0]: payload
		const variant = (c >> 12) & 0x7;
		const payload = c & 0x0fff;

		switch (variant) {
			case 0: {
				// ECC (Extended Country Code): bits [7:0]
				// OPC (Operator Code for enhanced paging): bits [11:8]
				// Note 2 in standard: "normally zero except when used for OPC in Radio Paging"
				const ecc = payload & 0xff;
				const opc = (payload >> 8) & 0xf;
				const eccChanged = ecc !== this.ecc;
				const opcChanged = opc !== this.opc0;
				if (eccChanged || opcChanged) {
					if (eccChanged) this.ecc = ecc;
					if (opcChanged) this.opc0 = opc;
					this.callback({ ecc, opc, countryName: eccToCountry(this.pi, ecc) });
				}
				break;
			}
			case 1: {
				// TMC identification: 12-bit TMC service ID
				const tmcId = payload;
				if (tmcId !== this.lastTmcId) {
					this.lastTmcId = tmcId;
					this.callback({ hasTmc: true, tmcId });
				}
				break;
			}
			case 2: {
				// Paging identification (EN 50067 M.3.2.4.2)
				//   bits [11:8]: OPC (Operator Code, 0=no enhanced paging)
				//   bits [7:6]:  reserved (zero)
				//   bits [5:0]:  PAC (Paging Area Code, 0=all areas)
				const opc = (payload >> 8) & 0xf;
				const pac = payload & 0x3f;
				if (opc !== this.pagingOpc || pac !== this.pagingPac) {
					this.pagingOpc = opc;
					this.pagingPac = pac;
					this.callback({ pagingOpc: opc, pagingPac: pac });
				}
				break;
			}
			case 3: {
				// Language Identification Code: bits [7:0]
				const lic = payload & 0xff;
				if (lic !== this.lic) {
					this.lic = lic;
					this.callback({ lic, languageName: LIC_NAMES[lic] || 'Unknown' });
				}
				break;
			}
			case 4:
			case 5:
				// Not assigned (IEC 62106 Table 9, variants 4-5)
				break;
			case 6: {
				// Broadcaster use: 12-bit broadcaster-defined data
				const bd = payload;
				if (bd !== this.broadcasterData) {
					this.broadcasterData = bd;
					this.callback({ broadcasterData: bd });
				}
				break;
			}
			case 7: {
				// EWS (Emergency Warning System) channel ID: 12-bit
				const ews = payload;
				if (ews !== this.ewsChannel) {
					this.ewsChannel = ews;
					this.callback({ ewsChannel: ews });
				}
				break;
			}
		}
	}

	private decodeGroup1B(blockB: number, bv: boolean[]): void {
		// Block B bits [4:0]: spare bits (reserved for future use, should be 0)
		// Block D: PIN -- same layout as 1A, suppress if unchanged
		void blockB;
		if (bv[3]) {
			const pin = this.blocks[3];
			if (pin !== this.lastPin) {
				this.lastPin = pin;
				const pinDay = (pin >> 11) & 0x1f;
				this.callback({ pin, pinDay, pinHour: (pin >> 6) & 0x1f, pinMinute: pin & 0x3f });
			}
		}
	}

	// ── Group 2: RadioText ───────────────────────────────────────
	private decodeGroup2(version: number, blockB: number, bv: boolean[]): void {
		const abFlag = (blockB >> 4) & 1;
		if (abFlag !== this.rtAbFlag || version !== this.rtVersion) {
			this.rtChars.fill(null); this.rtStatus.fill(0); this.lastRt = '';
			// RT A/B flip invalidates RT+ tag positions (they reference old RT)
			this.clearRtPlus();
		}
		this.rtAbFlag = abFlag; this.rtVersion = version;
		const seg = blockB & 0x0f;
		if (version === 0) {
			if (bv[2]) { const c = this.blocks[2]; const q = this.blockQuality(2); this.acceptChar(seg*4,   (c>>8)&0xff, this.rtChars, this.rtStatus, q); this.acceptChar(seg*4+1, c&0xff, this.rtChars, this.rtStatus, q); }
			if (bv[3]) { const d = this.blocks[3]; const q = this.blockQuality(3); this.acceptChar(seg*4+2, (d>>8)&0xff, this.rtChars, this.rtStatus, q); this.acceptChar(seg*4+3, d&0xff, this.rtChars, this.rtStatus, q); }
		} else if (bv[3]) {
			const d = this.blocks[3]; const q = this.blockQuality(3);
			this.acceptChar(seg*2,   (d>>8)&0xff, this.rtChars, this.rtStatus, q);
			this.acceptChar(seg*2+1, d&0xff,      this.rtChars, this.rtStatus, q);
		}
		const rt = this.buildRT();
		if (rt && rt.length >= 4 && rt !== this.lastRt) { this.lastRt = rt; this.callback({ rt, rtCharStatus: this.buildStatus(this.rtChars, this.rtStatus), srcAbFlag: abFlag }); }
	}

	// ── Group 3A: ODA application identification ─────────────────
	private decodeGroup3A(blockB: number, bv: boolean[]): void {
		if (!bv[3]) return;
		const odaGroupNum = (blockB >> 1) & 0xf;
		const odaVersion  =  blockB & 1;
		const aid = this.blocks[3];
		// Block C = 16-bit message bits (app-specific config, e.g. RT+ CB/SCB/template)
		const msg = bv[2] ? this.blocks[2] : 0;
		const key = (odaGroupNum << 1) | odaVersion;
		// Only emit when this group's AID or message bits change
		if (this.odaMap.get(key) === aid && this.odaMsg.get(key) === msg) return;
		this.odaMap.set(key, aid);
		this.odaMsg.set(key, msg);
		if (aid === 0x4BD7) this.rtPlusGroup = key;
		if (aid === 0x4BD8) { this.eRTPlusGroup = key; this.eRTPlusCb = (msg >> 12) & 1; } // eRT+
		if (aid === 0x6552) this.eRTGroup = key;  // Enhanced RadioText
		// TMC AIDs: 0x4D2C (standard), 0xCD46/0xCD47 (TMC-Alert)
		if (aid === 0x4D2C || aid === 0xCD46 || aid === 0xCD47) this.tmcGroup = key;
		this.callback({ odaAid: aid, odaGroup: odaGroupNum, odaVersion, odaMsg: msg });
	}

	// ── Group 4A: Clock Time (CT) ────────────────────────────────
	private decodeGroup4A(bv: boolean[]): void {
		if (!bv[1] || !bv[2] || !bv[3]) return;
		const b = this.blocks[1], c = this.blocks[2], d = this.blocks[3];
		// Modified Julian Day from blocks B+C
		const mjd = ((b & 0x3) << 15) | (c >> 1);
		const hours   = ((c & 1) << 4) | (d >> 12);
		const minutes = (d >> 6) & 0x3f;
		const offsetHalf = d & 0x1f;                         // magnitude in bits [4:0], units of 0.5h
		const utcOffset  = (d & 0x20) ? -offsetHalf : offsetHalf; // bit 5: 0=+East, 1=-West
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
		// A/B flag in bit 4: toggle clears PTYN buffer (new PTYN starting)
		const abFlag = (blockB >> 4) & 1;
		if (abFlag !== this.ptynAbFlag) {
			this.ptynAbFlag = abFlag;
			this.ptynChars.fill(null); this.ptynStatus.fill(0); this.lastPtyn = '';
		}
		const seg = blockB & 1;
		if (bv[2]) { const c = this.blocks[2]; const q = this.blockQuality(2); this.acceptChar(seg*4,   (c>>8)&0xff, this.ptynChars, this.ptynStatus, q); this.acceptChar(seg*4+1, c&0xff, this.ptynChars, this.ptynStatus, q); }
		if (bv[3]) { const d = this.blocks[3]; const q = this.blockQuality(3); this.acceptChar(seg*4+2, (d>>8)&0xff, this.ptynChars, this.ptynStatus, q); this.acceptChar(seg*4+3, d&0xff, this.ptynChars, this.ptynStatus, q); }
		if (!this.ptynChars.includes(null)) {
			const ptyn = (this.ptynChars as string[]).join('').trimEnd();
			if (ptyn && ptyn !== this.lastPtyn) { this.lastPtyn = ptyn; this.callback({ ptyn, ptynCharStatus: [...this.ptynStatus], srcAbFlag: this.ptynAbFlag }); }
		}
	}

	// ── Group 14A: Enhanced Other Networks (EON) ─────────────────
	// Figure 37: variants 0-3=PS, 4=AF(A), 5-8=mapped FM, 9=mapped AM,
	//            10-11=unallocated, 12=linkage, 13=PTY(ON)+TA, 14=PIN(ON), 15=broadcaster
	private decodeGroup14A(blockB: number, bv: boolean[]): void {
		if (!bv[3]) return;
		const eonPi = this.blocks[3];
		if (!eonPi) return;
		if (!this.eonMap.has(eonPi))
			this.eonMap.set(eonPi, {
				psChars: new Array<string | null>(8).fill(null),
				tp: false, ta: false,
				af: [], mappedFreqs: [],
				ptyOn: -1,
				pinDay: 0, pinHour: 0, pinMinute: 0,
				lsn: -1, lsIls: false, lsEg: false, lsLa: false,
				lastKey: '',
			});
		const eon = this.eonMap.get(eonPi)!;
		const variant = blockB & 0xf;
		eon.tp = ((blockB >> 4) & 1) === 1;

		if (variant <= 3 && bv[2]) {
			// Variants 0-3: PS chars (2 chars each, 8 total)
			const c = this.blocks[2];
			eon.psChars[variant * 2]     = rdsChar((c >> 8) & 0xff, this.region);
			eon.psChars[variant * 2 + 1] = rdsChar(c & 0xff, this.region);
		} else if (variant === 4 && bv[2]) {
			// Variant 4: AF Method A -- two AF codes in block C
			const c = this.blocks[2];
			const fa = decodeAfCode((c >> 8) & 0xff, this.region);
			const fb = decodeAfCode(c & 0xff, this.region);
			if (fa !== null && !eon.af.includes(fa)) eon.af.push(fa);
			if (fb !== null && !eon.af.includes(fb)) eon.af.push(fb);
		} else if (variant >= 5 && variant <= 8 && bv[2]) {
			// Variants 5-8: Mapped FM frequency pairs (Figure 37 / §3.2.1.6.6)
			// Block C = tuning freq (TN), block C... wait:
			// Per Figure 37: Information block = "Tuning freq. (TN) | Mapped FM freq. N (ON)"
			// So: block C high byte = TN freq code, block C low byte = ON freq code
			const c = this.blocks[2];
			const tuned = decodeAfCode((c >> 8) & 0xff, this.region);
			const other = decodeAfCode(c & 0xff, this.region);
			if (tuned !== null && other !== null) {
				const exists = eon.mappedFreqs.some(p => p.tuned === tuned && p.other === other);
				if (!exists) eon.mappedFreqs.push({ tuned, other });
			}
		} else if (variant === 9 && bv[2]) {
			// Variant 9: Mapped AM (LF/MF) frequency
			// Block C high byte = tuning FM freq (TN), block C low byte = LF/MF code (ON)
			const c = this.blocks[2];
			const tuned = decodeAfCode((c >> 8) & 0xff, this.region);
			const other = decodeLfMfCode(c & 0xff, this.region);
			if (tuned !== null && other !== null) {
				const exists = eon.mappedFreqs.some(p => p.tuned === tuned && p.other === other);
				if (!exists) eon.mappedFreqs.push({ tuned, other });
			}
		} else if (variant === 12 && bv[2]) {
			// Variant 12: Linkage information -- LSN and flags (§3.2.1.8.3)
			// block C: bit 15=LA, bit 14=EG, bit 12=ILS, bits[11:0]=LSN
			// Linkage Set Number and flags -- store on eon entry
			const lc = this.blocks[2];
			eon.lsn   = lc & 0x0fff;  // bits [11:0]: Linkage Set Number
			eon.lsIls = ((lc >> 12) & 1) === 1; // bit 12: International Linkage Set flag
			eon.lsEg  = ((lc >> 14) & 1) === 1; // bit 14: Extended Generic flag
			eon.lsLa  = ((lc >> 15) & 1) === 1; // bit 15: Linkage Actuator
		} else if (variant === 13 && bv[2]) {
			// Variant 13: PTY(ON) + TA flag
			// Per Figure 37: Information block has PTY(ON) and TA
			// Block C bit 0 = TA(ON), block C bits [15:11] = PTY(ON)
			eon.ta = (this.blocks[2] & 1) === 1;
			eon.ptyOn = (this.blocks[2] >> 11) & 0x1f;
		} else if (variant === 14 && bv[2]) {
			// Variant 14: PIN(ON) -- scheduled broadcast time of the other network
			// Same encoding as Group 1B block D: day[15:11] hour[10:6] minute[5:0]
			const pin = this.blocks[2];
			eon.pinDay    = (pin >> 11) & 0x1f;
			eon.pinHour   = (pin >> 6) & 0x1f;
			eon.pinMinute = pin & 0x3f;
		}
		// Variants 10, 11, 15: unallocated / broadcaster -- no action

		const ps = eon.psChars.every(ch => ch !== null)
			? (eon.psChars as string[]).join('')
			: undefined;
		const key = `${eonPi}:${ps}:${eon.tp}:${eon.ta}:${eon.af.join(',')}:${eon.mappedFreqs.length}:${eon.ptyOn}:${eon.pinDay}:${eon.lsn}`;
		if (eon.lastKey === key) return;
		eon.lastKey = key;
		this.callback({
			eon: {
				pi: eonPi.toString(16).toUpperCase().padStart(4, '0'),
				ps, tp: eon.tp, ta: eon.ta,
				af:          eon.af.length          ? [...eon.af]          : undefined,
				mappedFreqs: eon.mappedFreqs.length  ? [...eon.mappedFreqs] : undefined,
				ptyOn:       eon.ptyOn >= 0          ? eon.ptyOn            : undefined,
				pinDay:      eon.pinDay > 0          ? eon.pinDay           : undefined,
				pinHour:     eon.pinDay > 0          ? eon.pinHour          : undefined,
				pinMinute:   eon.pinDay > 0          ? eon.pinMinute        : undefined,
				lsn:         eon.lsn >= 0            ? eon.lsn              : undefined,
				lsIls:       eon.lsn >= 0 && eon.lsIls ? true              : undefined,
				lsEg:        eon.lsn >= 0 && eon.lsEg  ? true              : undefined,
				lsLa:        eon.lsn >= 0 && eon.lsLa  ? true              : undefined,
			}
		});
	}

	// ── Group 14B: EON TA quick-update ──────────────────────────
	// Figure 38: TP(TN) in block B bit 4, TA(ON) in block B bit 3, PI(ON) in block D
	private decodeGroup14B(blockB: number, bv: boolean[]): void {
		if (!bv[3]) return;
		const eonPi = this.blocks[3];
		if (!eonPi) return;
		if (!this.eonMap.has(eonPi))
			this.eonMap.set(eonPi, {
				psChars: new Array<string | null>(8).fill(null),
				tp: false, ta: false,
				af: [], mappedFreqs: [],
				ptyOn: -1,
				pinDay: 0, pinHour: 0, pinMinute: 0,
				lsn: -1, lsIls: false, lsEg: false, lsLa: false,
				lastKey: '',
			});
		const eon = this.eonMap.get(eonPi)!;
		eon.tp = ((blockB >> 4) & 1) === 1;
		eon.ta = ((blockB >> 3) & 1) === 1;
		const key = `${eonPi}::${eon.tp}:${eon.ta}:`;
		if (eon.lastKey === key) return;
		eon.lastKey = key;
		this.callback({
			eon: {
				pi: eonPi.toString(16).toUpperCase().padStart(4, '0'),
				tp: eon.tp, ta: eon.ta,
			}
		});
	}
	// ── Group 7A: Radio Paging (EN 50067 Annex M) ────────────────
	// Gate: only active when rpcGroupDesig>0 (1A bits[4:2]!=0) AND CT received.
	// Per 3.2.6.2.2: all three of 4A(CT), 1A(RPC), 7A must be present.
	private pagAbFlag = -1;
	private pagAssembling = false;
	private pagAddress = 0;
	private pagAddrFmt = '';
	private pagMsgType = '';   // 'tone'|'num10'|'num18'|'intl15'|'alpha'|'vnum'|'functions'
	private pagMsg = '';
	private pagExpectedPsac = -1;
	private pagCountryCode = ''; // X1X2X3 for INTL15 and functions messages

	/** Unpack 6-digit pager address from block C + block D high byte */
	private pagUnpackAddr(c: number, dHi: number): number {
		return ((c >> 12) & 0xf) * 100000 + ((c >> 8) & 0xf) * 10000 +
		       ((c >> 4) & 0xf) * 1000   + (c & 0xf) * 100 +
		       ((dHi >> 4) & 0xf) * 10   + (dHi & 0xf);
	}

	/** Decode BCD nibbles to digit string (0xA = space) */
	private pagBcd(nibbles: number[]): string {
		return nibbles.map(n => n <= 9 ? String(n) : ' ').join('');
	}

	/** Decode hex nibbles to string (0x0-0x9='0'-'9', 0xA-0xF='A'-'F') per Annex M */
	private pagHex(nibbles: number[]): string {
		return nibbles.map(n => n.toString(16).toUpperCase()).join('');
	}

	private decodeGroup7A(blockB: number, bv: boolean[]): void {
		if (!bv[2] || !bv[3]) return;
		const abFlag = (blockB >> 4) & 1;
		const psac   =  blockB & 0xf;
		const c = this.blocks[2];
		const d = this.blocks[3];

		// A/B flag change resets in-progress reassembly
		if (this.pagAssembling && abFlag !== this.pagAbFlag) {
			this.pagAssembling = false;
			this.pagMsg = '';
		}
		this.pagAbFlag = abFlag;

		// Address groups carry Y1Y2-Z1Z2Z3Z4 in blocks C+D[15:8].
		// Data groups carry message digits/chars in blocks C and D -- do NOT
		// unpack an address from them. Store addrFmt when we see the address group
		// and use this.pagAddrFmt in the data group callbacks.
		const isAddrGroup = (psac === 0x0 || psac === 0x1 || psac === 0x2 ||
		                     psac === 0x4 || psac === 0x7 || psac === 0x8);

		let addr = 0;
		if (isAddrGroup) {
			addr = this.pagUnpackAddr(c, (d >> 8) & 0xff);
			this.pagAddrFmt = `${String(Math.trunc(addr / 10000)).padStart(2, '0')}-${String(addr % 10000).padStart(4, '0')}`;
		}

		switch (psac) {
			case 0x0: { // Tone-only: single group, complete (PSAC=0000)
				this.callback({ paging: { address: addr, type: 'tone', data: '', addrFmt: this.pagAddrFmt } });
				break;
			}
			case 0x1: { // Functions address group (PSAC=0001) per Table M.6 / Figure M.7
				// Group 1: addr Y1Y2Z1Z2Z3Z4 in C+D[15:8], country digits X1X2 in D[7:0]
				this.pagAddress = addr;
				this.pagCountryCode = this.pagBcd([(d >> 4) & 0xf, d & 0xf]); // X1X2
				this.pagMsg = '';
				this.pagMsgType = 'functions';
				this.pagAssembling = true;
				this.pagExpectedPsac = 0x3; // functions data group is PSAC=0011
				break;
			}
			case 0x2: { // 10-digit numeric: address group (PSAC=0010)
				const n2 = [((d >> 4) & 0xf), d & 0xf];
				this.pagAddress = addr;
				this.pagMsg = this.pagBcd(n2);
				this.pagMsgType = 'num10';
				this.pagAssembling = true;
				this.pagExpectedPsac = 0x3;
				break;
			}
			case 0x3: { // Data group for num10 (PSAC=0011) OR functions (PSAC=0011)
				if (!this.pagAssembling) break;
				if (this.pagMsgType === 'num10') {
					// 10-digit numeric data: 8 BCD nibbles from C and D
					const nibs = [(c>>12)&0xf,(c>>8)&0xf,(c>>4)&0xf,c&0xf,(d>>12)&0xf,(d>>8)&0xf,(d>>4)&0xf,d&0xf];
					this.pagMsg += this.pagBcd(nibs);
					this.pagAssembling = false;
					this.callback({ paging: { address: this.pagAddress, type: 'num10', data: this.pagMsg.trim(), addrFmt: this.pagAddrFmt } });
				} else if (this.pagMsgType === 'functions') {
					// Functions message: X3 + F1-F7 (8 hex nibbles in C+D per Table M.6)
					// C[15:12]=X3, C[11:0]+D = F1-F7 packed as nibbles
					const x3 = this.pagHex([(c >> 12) & 0xf]);
					const fNibs = [(c>>8)&0xf,(c>>4)&0xf,c&0xf,(d>>12)&0xf,(d>>8)&0xf,(d>>4)&0xf,(d>>4)&0xf,d&0xf];
					// F1-F7 = 7 hex nibbles from C[11:0](3 nibs) + D[15:0](4 nibs)
					const f1_3 = [(c>>8)&0xf,(c>>4)&0xf,c&0xf];
					const f4_7 = [(d>>12)&0xf,(d>>8)&0xf,(d>>4)&0xf,d&0xf];
					this.pagMsg = x3 + this.pagHex([...f1_3, ...f4_7]);
					void fNibs;
					this.pagCountryCode += x3;
					this.pagAssembling = false;
					// data = "CC:X1X2X3 F:F1F2F3F4F5F6F7"
					const fnData = `CC:${this.pagCountryCode} F:${this.pagHex([...f1_3, ...f4_7])}`;
					this.callback({ paging: { address: this.pagAddress, type: 'functions', data: fnData, addrFmt: this.pagAddrFmt } });
				}
				break;
			}
			case 0x4: { // 18-digit numeric: address group (PSAC=0100)
				const n2 = [((d >> 4) & 0xf), d & 0xf];
				this.pagAddress = addr;
				this.pagMsg = this.pagBcd(n2);
				this.pagMsgType = 'num18';
				this.pagAssembling = true;
				this.pagExpectedPsac = 0x5;
				break;
			}
			case 0x5:
			case 0x6: { // Data groups for num18 (PSAC=0101/0110) OR intl15 (PSAC=0101/0110)
				if (!this.pagAssembling) break;
				if (psac !== this.pagExpectedPsac) break;
				if (this.pagMsgType === 'num18') {
					// 18-digit numeric data: 8 BCD nibbles from C and D
					const nibs = [(c>>12)&0xf,(c>>8)&0xf,(c>>4)&0xf,c&0xf,(d>>12)&0xf,(d>>8)&0xf,(d>>4)&0xf,d&0xf];
					this.pagMsg += this.pagBcd(nibs);
					if (psac === 0x6) {
						this.pagAssembling = false;
						this.callback({ paging: { address: this.pagAddress, type: 'num18', data: this.pagMsg.trim(), addrFmt: this.pagAddrFmt } });
					} else {
						this.pagExpectedPsac = 0x6;
					}
				} else if (this.pagMsgType === 'intl15') {
					// INTL15 Table M.5:
					// PSAC=0101 (group 2): C[15:12]=X3, C[11:0]+D = A1-A7 (7 BCD digits)
					// PSAC=0110 (group 3): C+D = A8-A15 (8 BCD digits)
					if (psac === 0x5) {
						const x3 = this.pagBcd([(c >> 12) & 0xf]);
						this.pagCountryCode += x3;
						// A1-A7: C[11:0] = 3 nibbles, D[15:0] = 4 nibbles
						const a1_3 = [(c>>8)&0xf,(c>>4)&0xf,c&0xf];
						const a4_7 = [(d>>12)&0xf,(d>>8)&0xf,(d>>4)&0xf,d&0xf];
						this.pagMsg = this.pagBcd([...a1_3, ...a4_7]);
						this.pagExpectedPsac = 0x6;
					} else { // psac === 0x6
						// A8-A15: 8 BCD nibbles from C+D
						const nibs = [(c>>12)&0xf,(c>>8)&0xf,(c>>4)&0xf,c&0xf,(d>>12)&0xf,(d>>8)&0xf,(d>>4)&0xf,d&0xf];
						this.pagMsg += this.pagBcd(nibs);
						this.pagAssembling = false;
						const intlData = `CC:${this.pagCountryCode} ${this.pagMsg.trim()}`;
						this.callback({ paging: { address: this.pagAddress, type: 'intl15', data: intlData, addrFmt: this.pagAddrFmt } });
					}
				}
				break;
			}
			case 0x7: { // INTL15: international 15-digit address group (PSAC=0111) per Table M.5/Fig M.6
				// Group 1: addr Y1Y2Z1Z2Z3Z4 in C+D[15:8], country digits X1X2 in D[7:0]
				this.pagAddress = addr;
				this.pagCountryCode = this.pagBcd([(d >> 4) & 0xf, d & 0xf]); // X1X2
				this.pagMsg = '';
				this.pagMsgType = 'intl15';
				this.pagAssembling = true;
				this.pagExpectedPsac = 0x5; // data group 2 is PSAC=0101
				break;
			}
			case 0x8: { // Address group (PSAC=1000) -- alpha or VNUM depending on MT in ctrl byte
				// Control byte X1X2 is block D bits [7:0] (M.3.5.3)
				// MT bits [7:6]: 00=alpha, 01=variable-length numeric (VNUM), 11=functions
				const ctrl = d & 0xff;
				const mt   = (ctrl >> 6) & 0x3;
				this.pagAddress = addr;
				this.pagMsg = '';
				this.pagMsgType = (mt === 1) ? 'vnum' : (mt === 3) ? 'functions' : 'alpha';
				this.pagAssembling = true;
				this.pagExpectedPsac = 0x9;
				break;
			}
			case 0xf: { // End-of-message group (PSAC=1111) -- alpha or VNUM final segment
				if (!this.pagAssembling) break;
				if (this.pagMsgType === 'alpha') {
					// 4 ASCII chars from blocks C and D
					const chars = [(c>>8)&0xff, c&0xff, (d>>8)&0xff, d&0xff];
					this.pagMsg += chars.map(b => b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '').join('');
					this.pagMsg = this.pagMsg.trimEnd();
					this.pagAssembling = false;
					this.callback({ paging: { address: this.pagAddress, type: 'alpha', data: this.pagMsg, addrFmt: this.pagAddrFmt } });
				} else if (this.pagMsgType === 'vnum') {
					// VNUM: last 8 BCD nibbles
					const nibs = [(c>>12)&0xf,(c>>8)&0xf,(c>>4)&0xf,c&0xf,(d>>12)&0xf,(d>>8)&0xf,(d>>4)&0xf,d&0xf];
					this.pagMsg += this.pagBcd(nibs);
					this.pagMsg = this.pagMsg.trim();
					this.pagAssembling = false;
					this.callback({ paging: { address: this.pagAddress, type: 'vnum', data: this.pagMsg, addrFmt: this.pagAddrFmt } });
				}
				break;
			}
			default: {
				// PSAC 9-14: alpha or VNUM data groups (4 bytes/8 BCD digits each)
				if (psac >= 0x9 && psac <= 0xe && this.pagAssembling) {
					if (this.pagMsgType === 'alpha') {
						// Alpha: 4 ASCII chars from blocks C and D
						const chars = [(c>>8)&0xff, c&0xff, (d>>8)&0xff, d&0xff];
						this.pagMsg += chars.map(b => b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '').join('');
						this.pagExpectedPsac = psac + 1;
					} else if (this.pagMsgType === 'vnum') {
						// VNUM: 8 BCD nibbles from blocks C and D
						const nibs = [(c>>12)&0xf,(c>>8)&0xf,(c>>4)&0xf,c&0xf,(d>>12)&0xf,(d>>8)&0xf,(d>>4)&0xf,d&0xf];
						this.pagMsg += this.pagBcd(nibs);
						this.pagExpectedPsac = psac + 1;
					}
				}
				break;
			}
		}
	}

	private decodeOdaGroup(groupNum: number, version: number, blockB: number, bv: boolean[]): void {
		const key = (groupNum << 1) | version;
		const aid = this.odaMap.get(key);
		// Forward raw ODA payload for any consumer (TMC decoder, pager, etc.)
		if (aid !== undefined && bv[2] && bv[3])
			this.callback({ odaData: { group: groupNum, version, b: blockB & 0x1f, c: this.blocks[2], d: this.blocks[3] } });
		// RT+ decode when this is the group registered for it
		if (key === this.rtPlusGroup && bv[1] && bv[2] && bv[3])
			this.decodeRtPlus(blockB, this.blocks[2], this.blocks[3]);
		if (key === this.eRTPlusGroup && bv[1] && bv[2] && bv[3])
			this.decodeERtPlus(blockB, this.blocks[2], this.blocks[3]);
		if (key === this.eRTGroup && bv[1])
			this.decodeERT(blockB, bv);
		if (key === this.tmcGroup && bv[1])
			this.decodeTMC(blockB, bv);
	}

	// ── eRT: Enhanced RadioText (ODA AID 0x6552, IEC 62106-6) ────
	// Wire format: identical to Group 2A (4-bit segment address in block B bits[3:0],
	// A/B toggle in block B bit 4, 4 bytes per group in blocks C+D).
	// Carries up to 128 bytes of raw UTF-8, CR (0x0D) terminated.
	//
	// Approach cloned from redsea RDSString:
	//  - sequential_length_: only bytes received in-order from pos 0 count.
	//  - isComplete(): sequential fill has reached the CR terminator or pos 128.
	//  - sanitizeUtf8(): incomplete/invalid multibyte sequences replaced with '?'.
	//  - Per-codepoint quality: worst quality byte in the codepoint's byte span.
	private decodeERT(blockB: number, bv: boolean[]): void {
		const abFlag = (blockB >> 4) & 1;
		if (abFlag !== this.eRTAbFlag) {
			this.eRTAbFlag = abFlag;
			this.eRTBytes.fill(0);
			this.eRTFilled.fill(false);
			this.eRTQuality.fill(0);
			this.lastERT = '';
		}
		const seg = blockB & 0x0f;
		const base = seg * 4;
		if (base + 3 >= 128) return;

		const writeByte = (pos: number, val: number, q: number) => {
			if (!this.eRTFilled[pos]) {
				// First receive -- store value and quality
				this.eRTBytes[pos] = val;
				this.eRTFilled[pos] = true;
				this.eRTQuality[pos] = q;
			} else if (q < this.eRTQuality[pos]) {
				// Better quality on re-receive: update value and quality
				this.eRTBytes[pos] = val;
				this.eRTQuality[pos] = q;
			}
			// Worse or equal quality: keep existing value
		};
		if (bv[2]) {
			const c = this.blocks[2]; const q = this.blockQuality(2);
			writeByte(base,     (c >> 8) & 0xff, q);
			writeByte(base + 1, c & 0xff,         q);
		} else {
			// Block C lost: fill with space (0x20) at quality=2 so sequential fill can advance
			writeByte(base,     0x20, 2);
			writeByte(base + 1, 0x20, 2);
		}
		if (bv[3]) {
			const d = this.blocks[3]; const q = this.blockQuality(3);
			writeByte(base + 2, (d >> 8) & 0xff, q);
			writeByte(base + 3, d & 0xff,         q);
		} else {
			// Block D lost: fill with space at quality=2
			writeByte(base + 2, 0x20, 2);
			writeByte(base + 3, 0x20, 2);
		}

		// Sequential length: count filled bytes from pos 0 (redsea sequential_length_)
		let seqLen = 0;
		while (seqLen < 128 && this.eRTFilled[seqLen]) {
			if (this.eRTBytes[seqLen] === 0x0d) { seqLen++; break; } // CR terminator
			seqLen++;
		}
		if (seqLen === 0) return;

		// isComplete: CR found, or all 128 bytes received
		const hasCr = this.eRTBytes[seqLen - 1] === 0x0d;
		const isComplete = hasCr || seqLen >= 128;
		// For partial: build from what we have so far; for complete: trim CR
		const rawLen = hasCr ? seqLen - 1 : seqLen;

		// Walk bytes, validate UTF-8 sequences (redsea sanitizeUtf8 logic),
		// assemble per-codepoint quality (worst byte quality in the codepoint).
		const chars: string[] = [];
		const cpQuality: number[] = [];
		let i = 0;
		while (i < rawLen) {
			const b0 = this.eRTBytes[i];
			let seqBytes: number;
			if      ((b0 & 0x80) === 0x00) seqBytes = 1;
			else if ((b0 & 0xe0) === 0xc0) seqBytes = 2;
			else if ((b0 & 0xf0) === 0xe0) seqBytes = 3;
			else if ((b0 & 0xf8) === 0xf0) seqBytes = 4;
			else { chars.push('?'); cpQuality.push(this.eRTQuality[i]); i++; continue; }

			if (i + seqBytes > rawLen) {
				// Incomplete sequence at end of buffer
				chars.push('?'); cpQuality.push(2); i++; continue;
			}
			let valid = true;
			for (let j = 1; j < seqBytes; j++) {
				if ((this.eRTBytes[i + j] & 0xc0) !== 0x80) { valid = false; break; }
			}
			if (!valid) {
				chars.push('?'); cpQuality.push(this.eRTQuality[i]); i++; continue;
			}
			// Valid codepoint: quality = worst of its constituent bytes
			let worstQ = this.eRTQuality[i];
			for (let j = 1; j < seqBytes; j++) if (this.eRTQuality[i + j] > worstQ) worstQ = this.eRTQuality[i + j];
			const cp = new TextDecoder('utf-8', { fatal: false }).decode(this.eRTBytes.slice(i, i + seqBytes));
			chars.push(cp);
			cpQuality.push(worstQ);
			i += seqBytes;
		}
		while (chars.length > 0 && chars[chars.length - 1] === ' ') { chars.pop(); cpQuality.pop(); }

		const text = chars.join('');
		if (text.length < 1) return;
		if (isComplete) {
			// Complete message: emit as eRT (last-complete semantics like redsea)
			if (text !== this.lastERT) {
				this.lastERT = text;
				this.callback({ eRT: text, eRTCharStatus: cpQuality });
			}
		} else {
			// Partial: emit in-progress text so the UI shows something while receiving
			this.callback({ eRTPartial: text, eRTCharStatus: cpQuality });
		}
	}

	// ── TMC: RDS-TMC (ODA AIDs 0x4D2C / 0xCD46 / 0xCD47) ────────
	// Based on ISO 14819-1 §9.6 (single-group) and §9.7 (multi-group).
	// x = block B bits [4:0], y = block C, z = block D.
	// t = x[4]: 1=tuning info, 0=user message.
	// f = x[3]: 1=single-group user message, 0=multi-group.
	private decodeTMC(blockB: number, bv: boolean[]): void {
		if (!bv[2] || !bv[3]) return;
		const x = blockB & 0x1f;
		const y = this.blocks[2];
		const z = this.blocks[3];
		const t = (x >> 4) & 1;  // tuning info bit
		if (t) return;            // tuning info -- system management, no message to emit
		const f = (x >> 3) & 1;  // single/multi flag

		if (f) {
			// Single-group user message (ISO 14819-1 §9.6.1)
			// x[2:0] = duration code, y[15] = diversion, y[14] = direction,
			// y[13:11] = extent, y[10:0] = event code, z = location code
			const duration  = x & 0x7;
			const diversion = (y >> 15) & 1;
			const direction = (y >> 14) & 1;
			const extent    = (y >> 11) & 0x7;
			const event     = y & 0x7ff;
			const location  = z;
			this.callback({
				tmcMessage: {
					event, location,
					direction: direction ? 'negative' : 'positive',
					extent, duration, diversion: diversion === 1,
					multi: false,
				}
			});
		} else {
			// Multi-group user message (ISO 14819-1 §9.7)
			// x[2:0] = continuity index
			const continuityIndex = x & 0x7;
			if (continuityIndex !== this.tmcContinuity) {
				// New message: reset parts
				this.tmcContinuity = continuityIndex;
				this.tmcParts = [null, null, null, null, null];
			}
			const isFirst = (y >> 15) & 1;
			const sg      = (y >> 14) & 1;  // second group indicator
			let groupNum: number;
			let isLast: boolean;
			if (isFirst) {
				groupNum = 0;
				isLast = false;
			} else if (sg) {
				const gsi = (y >> 12) & 0x3;
				groupNum = 1;
				isLast = gsi === 0;
			} else {
				const gsi = (y >> 12) & 0x3;
				groupNum = 4 - gsi;
				isLast = gsi === 0;
			}
			this.tmcParts[groupNum] = { y, z };
			if (isLast && this.tmcParts[0]) {
				// Decode from first group: direction y0[14], extent y0[13:11], event y0[10:0], location z0
				const p0 = this.tmcParts[0];
				const direction = (p0.y >> 14) & 1;
				const extent    = (p0.y >> 11) & 0x7;
				const event     = p0.y & 0x7ff;
				const location  = p0.z;
				// Duration from subsequent parts (label 0 in freeform fields, 3 bits)
				// Without a full freeform decoder, default to 0
				const duration = 0;
				this.callback({
					tmcMessage: {
						event, location,
						direction: direction ? 'negative' : 'positive',
						extent, duration, diversion: false,
						multi: true,
					}
				});
				this.tmcParts = [null, null, null, null, null];
			}
		}
	}

	// ── RT+ tag extraction (IEC 62106-6 A.5.3) ──────────────────
	// Called when RT A/B flag changes to invalidate tag positions
	private clearRtPlus(): void {
		if (this.rtPlusText1 || this.rtPlusText2) {
			this.rtPlusText1 = ''; this.rtPlusText2 = '';
			this.callback({ rtPlusItem1: undefined, rtPlusItem2: undefined });
		}
	}

	private decodeRtPlus(b: number, c: number, d: number): void {
		// Block B: bit 4 = item_toggle, bit 3 = item_running, bits [2:0] = tag1 CT high
		const toggle  = (b >> 4) & 1;
		const running = (b >> 3) & 1;

		// Toggle change = new item (IEC 62106-6 A.5.3 note 3)
		const newItem = this.rtPlusToggle !== -1 && toggle !== this.rtPlusToggle;
		this.rtPlusToggle = toggle;

		// Running change tracking (independent from tags, A.5.3 note 2)
		const runningChanged = this.rtPlusRunning !== -1 && running !== this.rtPlusRunning;
		this.rtPlusRunning = running;

		// Tag1: content_type = b[2:0]<<3 | c[15:13], start = c[12:7], length-1 = c[6:1]
		const tag1Type  = ((b & 0x7) << 3) | (c >> 13);
		const tag1Start = (c >> 7) & 0x3f;
		const tag1Len   = ((c >> 1) & 0x3f) + 1;  // stored as length-1

		// Tag2: content_type = c[0]<<5 | d[15:11], start = d[10:5], length-1 = d[4:0]
		const tag2Type  = ((c & 1) << 5) | (d >> 11);
		const tag2Start = (d >> 5) & 0x3f;
		const tag2Len   = (d & 0x1f) + 1;  // stored as length-1

		const rt = this.lastRt;
		const extract = (s: number, l: number) =>
			s < rt.length ? rt.slice(s, Math.min(s + l, rt.length)).trimEnd() : '';

		// type=0 (dummy_class) means no tag; only extract when item is running
		const t1 = tag1Type > 0 && running ? extract(tag1Start, tag1Len) : '';
		const t2 = tag2Type > 0 && running ? extract(tag2Start, tag2Len) : '';

		const tag1Name = RTPLUS_TYPES[tag1Type] ?? `CT${tag1Type}`;
		const tag2Name = RTPLUS_TYPES[tag2Type] ?? `CT${tag2Type}`;

		const changed = t1 !== this.rtPlusText1 || t2 !== this.rtPlusText2
			|| tag1Type !== this.rtPlusTag1 || tag2Type !== this.rtPlusTag2
			|| newItem || runningChanged;

		if (changed) {
			if (newItem) {
				// New item: clear stale tags
				this.rtPlusText1 = ''; this.rtPlusText2 = '';
				this.rtPlusTag1 = 0; this.rtPlusTag2 = 0;
			}
			this.rtPlusText1 = t1; this.rtPlusText2 = t2;
			this.rtPlusTag1 = tag1Type; this.rtPlusTag2 = tag2Type;
			this.callback({
				rtPlusRunning: running === 1,
				rtPlusToggle: toggle,
				rtPlusItem1: t1 || undefined,
				rtPlusItem1Tag: tag1Type || undefined,
				rtPlusItem1Name: tag1Type > 0 ? tag1Name : undefined,
				rtPlusItem2: t2 || undefined,
				rtPlusItem2Tag: tag2Type || undefined,
				rtPlusItem2Name: tag2Type > 0 ? tag2Name : undefined,
			});
		}
	}

	// ── eRT+: RT+ tag extraction over eRT text (ODA AID 0x4BD8) ──
	// Identical wire format to RT+ (IEC 62106-6 A.5.3) but fully independent state.
	// cb bit from 3A config selects the text source: 0=RT, 1=eRT.
	private decodeERtPlus(b: number, c: number, d: number): void {
		const toggle  = (b >> 4) & 1;
		const running = (b >> 3) & 1;

		const newItem = this.eRTPlusToggle !== -1 && toggle !== this.eRTPlusToggle;
		const runningChanged = this.eRTPlusRunning !== -1 && running !== this.eRTPlusRunning;
		this.eRTPlusToggle = toggle;
		this.eRTPlusRunning = running;

		const tag1Type  = ((b & 0x7) << 3) | (c >> 13);
		const tag1Start = (c >> 7) & 0x3f;
		const tag1Len   = ((c >> 1) & 0x3f) + 1;
		const tag2Type  = ((c & 1) << 5) | (d >> 11);
		const tag2Start = (d >> 5) & 0x3f;
		const tag2Len   = (d & 0x1f) + 1;

		// cb=1 → extract from eRT; cb=0 → extract from RT
		const src = this.eRTPlusCb === 1 ? this.lastERT : this.lastRt;
		const extract = (s: number, l: number) =>
			s < src.length ? src.slice(s, Math.min(s + l, src.length)).trimEnd() : '';

		const t1 = tag1Type > 0 && running ? extract(tag1Start, tag1Len) : '';
		const t2 = tag2Type > 0 && running ? extract(tag2Start, tag2Len) : '';

		const tag1Name = RTPLUS_TYPES[tag1Type] ?? `CT${tag1Type}`;
		const tag2Name = RTPLUS_TYPES[tag2Type] ?? `CT${tag2Type}`;

		const changed = t1 !== this.eRTPlusText1 || t2 !== this.eRTPlusText2
			|| tag1Type !== this.eRTPlusTag1 || tag2Type !== this.eRTPlusTag2
			|| newItem || runningChanged;

		if (changed) {
			if (newItem) { this.eRTPlusText1 = ''; this.eRTPlusText2 = ''; this.eRTPlusTag1 = 0; this.eRTPlusTag2 = 0; }
			this.eRTPlusText1 = t1; this.eRTPlusText2 = t2;
			this.eRTPlusTag1 = tag1Type; this.eRTPlusTag2 = tag2Type;
			this.callback({
				eRTPlusRunning: running === 1,
				eRTPlusToggle: toggle,
				eRTPlusItem1: t1 || undefined,
				eRTPlusItem1Tag: tag1Type || undefined,
				eRTPlusItem1Name: tag1Type > 0 ? tag1Name : undefined,
				eRTPlusItem2: t2 || undefined,
				eRTPlusItem2Tag: tag2Type || undefined,
				eRTPlusItem2Name: tag2Type > 0 ? tag2Name : undefined,
			});
		}
	}

	private buildPS(): string | null {
		if (this.psChars.some(c => c === null)) return null;
		return (this.psChars as string[]).join('');
	}

	private buildRT(): string | null {
		let s = '';
		for (const char of this.rtChars) {
			if (char === null || char === '\r') break;
			s += char;
		}
		return s.trimEnd() || null;
	}

	/** Build char status array for the received prefix of an RT/PS. */
	private buildStatus(chars: Array<string | null>, status: number[]): number[] {
		const result: number[] = [];
		for (let i = 0; i < chars.length; i++) {
			if (chars[i] === null || chars[i] === '\r') break;
			result.push(status[i]);
		}
		return result;
	}

	reset(): void {
		this.synced = false; this.blockIndex = 0; this.goodBlocks = 0;
		this.blockErrors = 0; this.nbUnsync = 0; this.blockValid.fill(false); this.blockCorrected.fill(false);
		this.bitCount = 0; this.shiftReg = 0;
		this.pi = 0; this.pty = -1; this.tp = false; this.ta = false;
		this.psChars.fill(null); this.psStatus.fill(0);
		this.rtChars.fill(null); this.rtStatus.fill(0);
		this.ptynChars.fill(null); this.ptynStatus.fill(0);
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
		// Reset BER and pilot but keep them across reset (station re-tune)
		this.berHistory.fill(1); this.berHead = 0; this.berSum = this.BER_WINDOW;
		this.berCorrectedBlocks = 0; this.berTotalBlocks = 0;
		this.pilotPower = 0;
		for (const bq of this.bqI) bq.reset();
		for (const bq of this.bqQ) bq.reset();
	}

	getStatus(): RdsStatus {
		return {
			synced: this.synced,
			ber: this.berTotalBlocks === 0 ? 1 : this.berSum / this.BER_WINDOW,
			goodBlocks: this.goodBlocks,
			correctedBlocks: this.berCorrectedBlocks,
			totalBlocks: this.berTotalBlocks,
			pilotLevel: Math.sqrt(this.pilotPower),
		};
	}
}
