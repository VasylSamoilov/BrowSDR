/** Internal types for the FLEX frame-content decoder. */

/** Capcode class by address-word range (frame.h flex_classify_addr_word). */
export type CapClass = 'short' | 'long' | 'infoSvc' | 'network' | 'temporary' | 'operMsg' | 'reserved' | 'unknown';

/**
 * One slot of the message-dedup / word-combine cache. Stores the packed raw
 * words (hdr + body) and their lost-status so a retransmission can be compared
 * word-by-word: an exact match is suppressed (tagged), and a retransmission
 * whose words are cleaner is merged in and re-decoded. Mirrors multimon-ng
 * Flex_DedupEntry.
 */
export interface DedupEntry {
	active: boolean;
	capcode: number;
	type: number; // vector type (V field)
	msgNum: number; // N field (-1 when the type has none)
	wordCount: number; // hdr + body words stored
	words: Uint32Array; // packed [hdr, body0, body1, ...]
	lost: Uint8Array; // parallel: 1 = word was lost/uncorrectable, 0 = good
	frameSeen: number; // absolute frame (cycle*128+frame) of last update
}

/** The 32-slot round-robin dedup store, held per polarity in the decoder. */
export interface DedupStore {
	entries: DedupEntry[];
	nextSlot: number;
}

/** Outcome of a dedup check: new (decode normally), exact duplicate (tag and
 * still emit), or improved retransmission (merged words, re-decode + tag). */
export type DedupResult = { kind: 'new' } | { kind: 'dup' } | { kind: 'improved'; words: Uint32Array; lost: Uint8Array };

/** The (possibly merged) word/status arrays to decode from after a dedup run,
 * plus a dedup tag when the message matched the cache. */
export interface DedupOutcome {
	words: Uint32Array;
	status: Int8Array;
	tag?: 'dup' | 'dup+';
}

/** Alpha-style fragment header fields a HEX / secure-binary body carries. */
export interface HexHeader {
	frag: string;
	msgNum: number;
	hdrF: number;
	mailDrop: boolean;
	retrieval: boolean;
}

/** RX-reconstructed state of one temporary-address (group) slot. */
export type GroupSlotState = 'idle' | 'registered' | 'delivering';

/** Per-slot group-messaging state (one of 16 temp-address slots). */
export interface GroupSlot {
	state: GroupSlotState;
	/** Target frame (0-127) the group message is scheduled for, or -1. */
	targetFrame: number;
	/** Member capcodes seen assigned to this slot (bounded). */
	members: number[];
	/** Absolute frame when the slot last changed, for aging back to idle. */
	lastFrameAbs: number;
}

/** A group-messaging event observed in a frame, folded into slot state. */
export type GroupEvent =
	| { kind: 'assign'; slot: number; targetFrame: number; capcode: number }
	| { kind: 'deliver'; slot: number };

/** One in-flight fragment-reassembly slot (keyed by capcode + message number). */
export interface ReasmSlot {
	capcode: number;
	/** Vector type (V field) -- part of the key so a fragment stream of one
	 * type does not collide with a different type reusing the same N. */
	type: number;
	msgNum: number;
	text: string;
	/** Accumulated per-character status across fragments (parallel to text). */
	charStatus: number[];
	/** Number of fragments received into this slot so far. */
	fragCount: number;
	/** Next expected F value (mod-3 after the initial): 0,1,2,0,1,2... */
	expectedF: number;
	/** True once an F-sequence gap was detected (a fragment went missing). */
	fMismatch: boolean;
	/** Stable identity for in-place UI updates: `pol:capcode:msgNum`. */
	reasmKey: string;
	lastFrameAbs: number;
	/** Received 7-bit signature from the initial fragment (-1 until seen). */
	rxSig: number;
	/** Running 7-bit signature sum accumulated across fragments. */
	sigSum: number;
	/** False once any fragment had a lost word (signature cannot be trusted). */
	sigValid: boolean;
}

/**
 * Network/temporal info accumulated from Block Information Words across frames.
 * BIWs are sparse (DATE/TIME mainly at Frame 0), so each field persists at its
 * last-seen value; null means never received this session.
 */
export interface FlexNetInfo {
	localId: number | null;
	coverageZone: number | null;
	countryCode: number | null;
	/** SSID2 traffic-management flags (4-bit), or null. */
	tmf: number | null;
	date: string | null;
	time: string | null;
	tzOffsetMin: number | null;
	/** Daylight-saving active (SysInfo L0=0 => DST), or null when no TZ seen. */
	dst: boolean | null;
	/** Confirmed clock components for a precise per-frame timestamp (ARIB
	 * 3.7.2). Null until the TIME vote promotes. `standardMode` selects whether
	 * the current frame's 1.875 s offset is added (standard) or the time already
	 * reflects the frame (direct). `extSec` is null until TZ is confirmed; year/
	 * month/day are null until DATE is confirmed. */
	clock: {
		year: number | null;
		month: number | null;
		day: number | null;
		hour: number;
		min: number;
		coarseSec: number;
		extSec: number | null;
		standardMode: boolean;
	} | null;
}

/**
 * Consistency-voting state for the FLEX over-the-air clock (multimon-ng
 * Flex_OTA_Time). BIW date/time/timezone readings are noisy (a corrupt BCH
 * word yields a random but plausible value), so a reading is only promoted
 * after FLEX_VOTE_THRESHOLD of the last FLEX_VOTE_RING readings agree. Held
 * per polarity in the decoder.
 */
export interface FlexTimeVote {
	// Time vote: FIW-cross-checked + forward-ticking streak.
	timeCount: number;
	timeHour: number;
	timeMin: number;
	timeSec: number;
	// Time-mode detection (ARIB 3.7.2; port of multimon-ng tmode). STANDARD
	// (tmode 0, default): TIME is the cycle's Frame-0 time, constant across the
	// cycle, so the current frame's offset (frame*1.875 s) is added to get the
	// per-frame instant. DIRECT (tmode 1): TIME already reflects the current
	// frame -- observed on some real networks -- so no offset is added. Decided
	// by comparing TIME readings >=5 frames apart within one cycle: identical ->
	// standard vote, differing -> direct vote; 3 votes flip the mode.
	tmode: number;
	tmodeVotesStd: number;
	tmodeVotesDir: number;
	tmodeAnchorValid: boolean;
	tmodeAnchorCycle: number;
	tmodeAnchorFrame: number;
	tmodeAnchorMin: number;
	tmodeAnchorSec: number;
	// Confirmed extended-seconds (S5-S3, each 0.9375 s) from the TZ SysInfo word;
	// -1 until a TZ reading is confirmed. Refines the coarse 7.5 s second field.
	extSec: number;
	// Date vote: history ring of calendar-valid readings.
	dateRing: Array<{ year: number; month: number; day: number }>;
	dateIdx: number;
	// Timezone vote: history ring; zone+DST+esec must match to agree.
	tzRing: Array<{ zone: number; dst: boolean; esec: number }>;
	tzIdx: number;
	// Monotonic absolute frame at which each component was last confirmed, or
	// -1 if never confirmed. Used to expire a stale component (see expireFlexTime).
	// Monotonic (not mod-1920) so a stale age cannot alias a fresh one across a
	// cycle wrap -- the fault in the multimon-ng reference's expire.
	confirmedDate: number;
	confirmedTime: number;
	confirmedTz: number;
	// Monotonic frame counter state: accumulated cycle-space offset and the
	// previous mod-1920 position, to measure staleness without wrap aliasing.
	monoBase: number;
	lastAbs: number;
}
