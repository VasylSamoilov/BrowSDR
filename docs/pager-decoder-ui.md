# Pager Decoder UI — consolidation design

Convert the single POCSAG decoder UI into a generic **Pager Decoder** that can
decode multiple paging protocols (POCSAG now; GSC and FLEX later), selectable
per VFO, with a per-protocol charset selector for protocols that own codepages.

## Why

Today POCSAG is wired as a one-off: a per-VFO `Decode POCSAG` checkbox, a
dedicated POCSAG panel, a `pocsag` state block, a single `vfo.pocsagCharset`, and
a POCSAG status strip. Adding GSC and FLEX by copy-paste would triple all of that
(three checkboxes, three panels, three state blocks, three status strips) — nearly
identical code. Consolidating once now makes GSC/FLEX cheap: each later protocol
is "add a worker decoder + register it + add its protocol-specific controls," not
"build another panel."

The charset registry is already protocol-scoped and FLEX is pre-stubbed:

```ts
// src/client/worker/decoders/charsets/index.ts
export const CHARSETS: CharsetRegistry = { pocsag: POCSAG_CHARSETS, flex: [] };
```

Keys are `protocol -> vendor -> model -> codepage`. So per-protocol charset
selection is a UI/state change, not a new data model.

## Scope of THIS pass (UI consolidation only)

- Keep POCSAG as the only *wired* decoder. No GSC/FLEX decode code here.
- No behaviour change to POCSAG decoding, status, second-guess, or export.
- Rework the panel, state, and per-VFO controls into a protocol-generic shape so
  POCSAG rides through it unchanged and GSC/FLEX slot in later.

## Protocol model

A small static descriptor drives the generic UI, so no protocol is hardcoded in
templates:

```ts
type PagerProtocol = 'pocsag' | 'gsc' | 'flex';
interface PagerProtocolDef {
  id: PagerProtocol;
  label: string;          // 'POCSAG'
  hasCharsets: boolean;   // true -> show a charset dropdown when enabled
}
```

- `pocsag`: `hasCharsets: true` (26 identities / 19 tables)
- `gsc` (later): `hasCharsets: false` — default-only, single ITU-R Rep.900-2
  Table VII alphabet, confirmed no codepage family. Never shows a selector.
- `flex` (later): `hasCharsets: true` once `CHARSETS.flex` is populated; the
  dropdown appears only when that branch is non-empty, so FLEX can ship
  default-only first and gain a selector when tables are added.

The charset dropdown is driven by the registry (`hasCharsets(protocol)` on
`CHARSETS[protocol].length > 0`), not by a hardcoded per-protocol flag, so a
protocol with an empty branch shows nothing.

## Per-VFO state model

Follow the existing per-decoder convention (one boolean VFO flag per decoder,
exactly like `vfo.rds` / `vfo.adsb` / `vfo.ais`): **do not** invent a protocol
array or map — that is foreign to this codebase.

- `vfo.pocsag: boolean` stays. `vfo.gsc: boolean` and `vfo.flex: boolean` are
  added the same way when those decoders land. A VFO can enable several at once
  (mixed-traffic band), just as it can today run RDS independently.
- Per-protocol charset as a flat sibling field: `vfo.pocsagCharset` stays; add
  `vfo.flexCharset` when FLEX gains codepages. GSC has none, so no field.
- `vfo.pocsagMode`, `vfo.pocsagSecondGuess` stay POCSAG-specific sibling fields.
  GSC/FLEX add their own option fields only if they need them.

This keeps the VFO shape consistent with every other decoder; the "pager"
abstraction lives in the **panel/state/UI grouping**, not in the VFO field model.

## App state changes

Replace the `pocsag` state block with a protocol-generic `pager` block:

```ts
pager: {
  panelOpen: boolean;
  log: PagerLogEntry[];                       // protocol-tagged, unified
  status: Array<Record<PagerProtocol, ProtocolStatus | null>>; // per VFO, per protocol
  filter: PagerProtocol | 'all';              // row filter in the panel
}
```

`PagerLogEntry` is today's `PocsagLogEntry` plus a `protocol: PagerProtocol` field.
Fields that are POCSAG-specific (`func`, `alt`, `charStatus`, `baud`) stay optional
so other protocols omit them.

## Panel changes

Rename the POCSAG panel to a **Pager Decoder** panel:

- Header: "Pager Decoder", message count, Clear, Export (unchanged behaviour).
- A protocol filter (All / POCSAG / GSC / FLEX) that hides rows by `protocol`.
- Each row shows a small **protocol badge** alongside the existing
  time/freq/VFO/address/type/text. POCSAG rows keep func + per-char colour
  segments + second-guess exactly as now.
- Empty state text generalised ("Enable a pager protocol on an NFM VFO...").

## Per-VFO controls (vfo-panel.html)

Replace the single `Decode POCSAG` checkbox + POCSAG-only rows with:

- A protocol multi-select (checkbox group) listing the pager protocols, shown on
  NFM VFOs. Wiring POCSAG today = just POCSAG in the list.
- For each *enabled* protocol with `CHARSETS[protocol].length > 0`, a charset
  dropdown fed from that protocol's registry branch (POCSAG now; FLEX later).
  Both can be visible at once when both protocols decode on the VFO.
- POCSAG's Type (auto/alpha/numeric) + second-guess rows render only when POCSAG
  is enabled (protocol-conditional, same as today but keyed off the set).
- The status strip renders one line per enabled protocol with status.

## RX defaults on enable

Today enabling POCSAG applies friendly NFM defaults (lowpass off, bandwidth
>=12500). Generalise: enabling *any* pager protocol applies the shared
NFM-paging-friendly defaults once; different protocols' defaults are compatible at
the ~12.5 kHz NFM setting, so no conflict when several are on. Keep them visible
and user-overridable; do not re-apply on disable.

## Worker / remote path

- `local-audio.ts` / `rx-stream.ts` / `remote-clients.ts` / `vfo-workers.ts` carry
  the per-protocol selection + charsets (same touchpoints POCSAG uses). For this
  pass only POCSAG is dispatched; the mux that runs multiple decoders lands with
  GSC.
- Message callback gains `protocol` so the app routes every pager message into the
  one unified log.

## Non-goals (this pass)

- No GSC or FLEX decode code.
- No parallel-decoder CPU work (mux arrives with GSC).
- No change to POCSAG decode/correction/status semantics.

## Verification

- `npm run typecheck`
- `npm run lint` (`--max-warnings 0`)
- `npm test` (existing POCSAG + remote + UI specs stay green; update POCSAG UI
  specs for the renamed panel/state only where names changed)
- `npm run build`
- POCSAG still decodes, logs, colour-codes, second-guesses, and exports exactly as
  before through the generic shell.
