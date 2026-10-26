/**
 * FLEX over-the-air clock consistency voting (ARIB STD-43A 3.7.2; faithful
 * port of multimon-ng flextime_vote_*). A single BIW date/time/timezone word
 * that passes BCH can still be wrong -- a corrupted word yields a random but
 * in-range value. So readings are not trusted on first sight: each component
 * is promoted only after FLEX_VOTE_THRESHOLD of the last FLEX_VOTE_RING
 * readings agree.
 *
 *   - Time: validated against the FIW-derived minute (independent ground
 *     truth from cycle/frame), then must tick forward (midnight wrap allowed),
 *     then confirmed after THRESHOLD consecutive valid readings.
 *   - Date: must be a valid calendar date, then THRESHOLD of the ring must
 *     agree (same day or an adjacent-day rollover). Year carries the 32-year
 *     rollover correction (the 5-bit field wraps after 2025).
 *   - Timezone: zone + DST + extended-seconds identical across THRESHOLD ring
 *     entries, with the esec cross-checked against the FIW frame position.
 *
 * Standard note: the time-related SysInfo sub-types are A3A2A1A0 = 0100 and
 * 0101 (page 37, Table 3.7.2). multimon-ng tests 4 || 8, which is a bug in the
 * reference; the standard (and this port) uses 4 || 5.
 */

import type { FlexNetInfo, FlexTimeVote } from './frame.types';

const VOTE_THRESHOLD = 3;
const VOTE_RING = 8;
const TIME_CROSS_SPAN = 3; // BIW minute must fall in the cycle's [cycle*4 .. +3] window
const ESEC_TOLERANCE = 1; // extended-seconds vs FIW-derived window

const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Build empty flextime vote state. */
export function makeFlexTimeVote(): FlexTimeVote {
	return { timeCount: 0, timeHour: 0, timeMin: 0, timeSec: 0, dateRing: [], dateIdx: 0, tzRing: [], tzIdx: 0 };
}

function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

function isLeap(y: number): boolean {
	return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
	return m === 2 && isLeap(y) ? 29 : DAYS_IN_MONTH[m];
}

/** Valid calendar date (rejects Feb 30, Apr 31, ...). */
export function dateValid(year: number, month: number, day: number): boolean {
	if (month < 1 || month > 12 || day < 1) return false;
	return day <= daysInMonth(year, month);
}

/** The calendar day after (y,m,d), handling month/year rollover. */
function nextDay(y: number, m: number, d: number): [number, number, number] {
	if (d < daysInMonth(y, m)) return [y, m, d + 1];
	if (m < 12) return [y, m + 1, 1];
	return [y + 1, 1, 1];
}

/** Two dates agree if identical or adjacent calendar days (midnight rollover). */
function datesAgree(y1: number, m1: number, d1: number, y2: number, m2: number, d2: number): boolean {
	if (y1 === y2 && m1 === m2 && d1 === d2) return true;
	const [ay, am, ad] = nextDay(y1, m1, d1);
	if (ay === y2 && am === m2 && ad === d2) return true;
	const [by, bm, bd] = nextDay(y2, m2, d2);
	return by === y1 && bm === m1 && bd === d1;
}

/** Apply the 5-bit year field's 32-year rollover: the field (1994..2025) wraps
 * to 0 in 2026, so add 32 while the decoded year is >16 years behind now. */
export function correctYearRollover(year: number): number {
	const curYear = new Date().getUTCFullYear();
	let y = year;
	while (y + 16 < curYear) y += 32;
	return y;
}

/** Cross-validate a BIW minute against the FIW-derived cycle window: the BIW
 * minute must fall in [cycle*4 .. cycle*4+3] mod 60 (covers standard + direct
 * time conventions). */
function fiwMinuteOk(biwMin: number, cycle: number): boolean {
	const base = (cycle * 4) % 60;
	let diff = biwMin - base;
	if (diff < -30) diff += 60;
	if (diff > 30) diff -= 60;
	return diff >= 0 && diff <= TIME_CROSS_SPAN;
}

function hhmmToMin(h: number, m: number): number {
	return h * 60 + m;
}

/**
 * Vote a TIME reading. Returns true when promoted (confirmed) -- the caller
 * then writes the confirmed time into FlexNetInfo. Rejects readings failing
 * the FIW cross-check (resets the streak); resets on a non-wrap backward jump.
 */
export function voteTime(v: FlexTimeVote, net: FlexNetInfo, hour: number, min: number, sec: number, cycle: number): boolean {
	if (!fiwMinuteOk(min, cycle)) {
		v.timeCount = 0;
		return false;
	}
	if (v.timeCount > 0) {
		let delta = hhmmToMin(hour, min) - hhmmToMin(v.timeHour, v.timeMin);
		if (delta < -720) delta += 1440; // midnight wrap counts as forward
		if (delta < 0) v.timeCount = 0; // backward -> reset, start a fresh streak
	}
	v.timeHour = hour;
	v.timeMin = min;
	v.timeSec = sec;
	v.timeCount++;
	if (v.timeCount >= VOTE_THRESHOLD) {
		const coarse = Math.round(sec * 7.5);
		net.time = `${pad2(hour)}:${pad2(min)}:${pad2(coarse)}`;
		return true;
	}
	return false;
}

/**
 * Vote a DATE reading (year already rollover-corrected). Returns true when
 * promoted. Pushes every calendar-valid reading into the ring, then promotes
 * when THRESHOLD ring entries agree (same or adjacent day).
 */
export function voteDate(v: FlexTimeVote, net: FlexNetInfo, year: number, month: number, day: number): boolean {
	if (!dateValid(year, month, day)) return false;
	const entry = { year, month, day };
	if (v.dateRing.length < VOTE_RING) v.dateRing.push(entry);
	else v.dateRing[v.dateIdx] = entry;
	v.dateIdx = (v.dateIdx + 1) % VOTE_RING;

	let agree = 0;
	for (const e of v.dateRing) if (datesAgree(year, month, day, e.year, e.month, e.day)) agree++;
	if (agree >= VOTE_THRESHOLD) {
		net.date = `${year}-${pad2(month)}-${pad2(day)}`;
		return true;
	}
	return false;
}

/**
 * Vote a TIMEZONE reading. `esec` is gated against the FIW-derived window
 * before entering the ring; zone + DST + esec must match THRESHOLD entries to
 * promote. Returns true when promoted. `tzOffsetMin` is the looked-up offset.
 */
export function voteTz(
	v: FlexTimeVote,
	net: FlexNetInfo,
	zone: number,
	dst: boolean,
	esec: number,
	tzOffsetMin: number,
	cycle: number,
	frame: number,
): boolean {
	const expectedExt = (((cycle * 128 + frame) % 32) / 4) | 0;
	let diff = esec - expectedExt;
	if (diff > 4) diff -= 8;
	if (diff < -4) diff += 8;
	if (Math.abs(diff) > ESEC_TOLERANCE) return false; // corrupt esec, don't pollute the ring

	const entry = { zone, dst, esec };
	if (v.tzRing.length < VOTE_RING) v.tzRing.push(entry);
	else v.tzRing[v.tzIdx] = entry;
	v.tzIdx = (v.tzIdx + 1) % VOTE_RING;

	let agree = 0;
	for (const e of v.tzRing) if (e.zone === zone && e.dst === dst && e.esec === esec) agree++;
	if (agree >= VOTE_THRESHOLD) {
		net.tzOffsetMin = tzOffsetMin;
		net.dst = dst;
		return true;
	}
	return false;
}
