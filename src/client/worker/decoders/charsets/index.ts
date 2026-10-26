/*
 * Pager charset registry -- resolves a protocol-scoped charset key to a glyph
 * table. POCSAG is populated (26 identities over 19 unique tables); FLEX is a
 * ready empty branch for a later pass.
 */

import type { CharsetEntry, CharsetKey, CharsetHandler, CharsetRegistry, CharsetTables, Codepage, PagerProtocol } from './types';
import { charsetKeyEquals } from './types';
import { POCSAG_CHARSETS, POCSAG_TABLES } from './pocsag';

export const CHARSETS: CharsetRegistry = {
	pocsag: POCSAG_CHARSETS,
	gsc: [], // GSC is default-only (single Table VII alphabet); no codepages.
	// FLEX: default 7-bit ASCII, plus a Kanji identity. FLEX carries no on-wire
	// signal that a payload is 16-bit Shift-JIS, so Kanji is a user-selected
	// charset that switches alpha decoding (16-bit chars) and rendering --
	// selectable like any other codepage, not auto-detected.
	flex: [
		{ vendor: 'generic', model: 'generic', codepage: 'ascii', codeBits: 7, label: 'Generic ASCII', tableId: 'generic-ascii' },
		{ vendor: 'generic', model: 'generic', codepage: 'kanji', codeBits: 16, label: 'Kanji (Shift-JIS)', tableId: 'generic-ascii', handler: 'kanji' },
	],
};

const TABLES: Record<PagerProtocol, CharsetTables> = {
	pocsag: POCSAG_TABLES,
	gsc: {},
	flex: {},
};

/** Per-protocol default charset key. Each protocol's 'generic/generic' identity. */
const DEFAULT_CHARSET: Record<PagerProtocol, CharsetKey> = {
	pocsag: { vendor: 'generic', model: 'generic', codepage: 'ascii' },
	gsc: { vendor: 'generic', model: 'generic', codepage: 'ascii' },
	flex: { vendor: 'generic', model: 'generic', codepage: 'ascii' },
};

/** Fallback table id per protocol, used when a key resolves to nothing. */
const DEFAULT_TABLE_ID: Record<PagerProtocol, string> = {
	pocsag: 'generic-ascii',
	gsc: 'generic-ascii',
	flex: 'generic-ascii',
};

/** True when a protocol owns at least one registered charset identity. */
export function hasCharsets(protocol: PagerProtocol): boolean {
	return (CHARSETS[protocol]?.length ?? 0) > 0;
}

/** The default charset key for a protocol. */
export function defaultCharset(protocol: PagerProtocol): CharsetKey {
	return DEFAULT_CHARSET[protocol];
}

/**
 * Resolve a protocol-scoped charset key to its glyph table, falling back to the
 * protocol's default table. Protocol-generic entry point shared by every pager
 * decoder (POCSAG now; GSC/FLEX later).
 */
export function resolveCodepage(protocol: PagerProtocol, key: CharsetKey): Codepage {
	const list = CHARSETS[protocol] ?? [];
	const entry = list.find((e) => charsetKeyEquals(e, key)) ?? list.find((e) => charsetKeyEquals(e, DEFAULT_CHARSET[protocol]));
	const id = entry?.tableId ?? DEFAULT_TABLE_ID[protocol];
	const tables = TABLES[protocol] ?? {};
	return tables[id] ?? tables[DEFAULT_TABLE_ID[protocol]];
}

/** The default POCSAG charset key (generic ASCII). */
export const POCSAG_DEFAULT_CHARSET: CharsetKey = DEFAULT_CHARSET.pocsag;

/** Resolve a POCSAG charset key to its glyph table, falling back to ASCII. */
export function pocsagCodepage(key: CharsetKey): Codepage {
	return resolveCodepage('pocsag', key);
}

/** The default FLEX charset key (generic ASCII). */
export const FLEX_DEFAULT_CHARSET: CharsetKey = DEFAULT_CHARSET.flex;

/**
 * The decode handler attached to a FLEX charset key, or undefined for a plain
 * codepage. Selecting a handler charset (e.g. Kanji) does NOT go through the
 * glyph table -- it sets a flag that switches the decoder's extraction/transform
 * logic. Returns the handler tag so the decoder can branch on it.
 */
export function flexCharsetHandler(key: CharsetKey): CharsetHandler | undefined {
	const entry = CHARSETS.flex.find((e) => charsetKeyEquals(e, key));
	return entry?.handler;
}

export type { CharsetEntry, CharsetKey, CharsetHandler, PagerProtocol };
export { POCSAG_CHARSETS, POCSAG_TABLES } from './pocsag';
