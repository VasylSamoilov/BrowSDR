# GSC / Golay Sequential Code — BrowSDR port plan

Port the Golay Sequential Code (GSC) paging decoder into BrowSDR, mirroring the
structure established by the POCSAG port. GSC shares POCSAG's overall shape — an
FM-demodulated audio decoder producing addressed alpha / numeric / tone messages,
run per-VFO in the in-page Web Worker — but has a different physical framing and a
single fixed character set.

## Reference sources (ground truth)

- **Decoder/encoder reference:** osmocom-analog `src/golay/golay.c` + `golay.h`
  (RX decode, address codec, Golay(23,12) + BCH(15,7) correction, Table VI/VII
  alpha/numeric). This is the authoritative implementation to translate.
- **Standard:** ITU-R Report 900-2 (GSC air interface) and Motorola *A Guide To
  The Golay Sequential Code (GSC)*, indexed at
  `/home/vas/projects/osmocom-analog/docs/gsc-index/` (page PNGs are ground truth;
  the PDFs are pure scans).
- **Charset:** osmocom-analog `src/libpagercharset/charset_golay_generic_ascii.c`
  (the one and only GSC codepage — see Charsets below).

## Charsets — default only, no codepage family

Unlike POCSAG (which carries a national/vendor codepage registry with structured
`{ vendor, model, codepage }` keys), **GSC has exactly one character set**:
ITU-R Report 900-2 Table VII, a fixed 6-bit, 64-entry, uppercase-only alphabet.
osmocom-analog ships a single `charset_golay_generic_ascii.c` and there is no
vendor/national codepage variation to support.

Properties of the GSC alphabet (Table VII):

- **Alpha:** 6-bit codes `0x00`–`0x3F`, 64 entries, uppercase only (no lowercase).
  Base mapping is arithmetic, `displayed_char = code + 0x20`, with these special
  codes overriding the arithmetic value:
  - `0x3C` = CR (carriage return), not `'<'`
  - `0x3E` = NUL fill (padding), not `'>'`
  - `0x3F` = `'_'` (0x5F, which falls outside the arithmetic 0x20–0x5D range)
- **Numeric:** 4-bit codes. `0`–`9` map to digits; the remaining nibbles are the
  control/overlay glyphs per Table VII (`0xB`=`U`, `0xC`=space, `0xD`=`-`,
  `0xE`=Null/EOM, etc.). LSB-first on the wire.
- Non-printable decoded bytes are surfaced as `<0xNN>` (the same convention used
  across the POCSAG port and the osmocom-analog Golay work), not silently dropped.

**Implication for the port:** no charset registry, no per-VFO charset selector, no
`{vendor,model,codepage}` plumbing. The GSC decoder embeds the single Table VII
alpha and numeric maps directly. This removes the entire "Charsets" surface the
POCSAG port had to build (registry, UI selector, worker/remote charset-key
threading). If a future codepage ever appears it can be added then; today it is
default-only by design, matching the standard.

## Decode-layer differences from POCSAG (the real work)

The audio front end, PLL bit recovery, per-codeword status, BER readout, and the
per-VFO decode-enable pattern all carry over conceptually. What is genuinely new is
the GSC physical layer, translated from `golay.c`:

- **Framing:** preamble + start code (`713`) / activation code (`2563`) and the
  batch structure, in place of POCSAG's `0x7CD215D8` sync + 8-frame batches.
- **Codewords:** Golay(23,12) address words and BCH(15,7) data words with their
  syndrome-lookup error correction (≤3-bit for Golay, ≤2-bit for BCH), in place of
  POCSAG's BCH(31,21).
- **Address codec:** Table VI `word1s[50]` + Word-2 construction, including the
  known high-range group 50–99 behaviour (osmocom-analog uses `word1s[]` + a W2
  offset rather than the spec's complement-of-Word-1; carry the same caveat and
  document it).
- **Generators:** the Golay/BCH generators are the LSB-first reciprocals of the
  nominal spec polynomials and are conformant under the standard's mandated
  LSB-first serialization — do not "fix" them.
- **Message type:** alpha vs numeric vs tone-only, scored by content the same way
  POCSAG does, not keyed off a function/type bit.

## File plan (mirror the POCSAG set)

Worker (decode) side:

- `src/client/worker/decoders/golay.ts` — new. Audio → messages: sync/preamble
  detection, Golay(23,12)/BCH(15,7) correction, address codec, Table VII alpha +
  numeric decode, per-codeword ok/corrected/uncorrectable status, status readout.
  Translated from osmocom-analog `golay.c`.
- `src/client/worker/decoders/types.ts` — extend with `GSCMessage` / `GSCStatus`
  types alongside the POCSAG ones.
- `src/client/worker/dsp-worker.ts` and `src/client/worker/streams/*`
  (`local-audio.ts`, `rx-stream.ts`, `remote-clients.ts`, `vfo-workers.ts`) —
  wire GSC into the per-VFO decode pipeline and the remote path, same touchpoints
  POCSAG uses. **No charset-key threading needed** (default-only).
- No `charsets/golay*.ts` — the single Table VII map lives inside `golay.ts`.

App (UI) side:

- `src/client/app/decoders/golay.ts`, `src/client/app/templates/golay.html`,
  `src/client/styles/golay.css` — message list + status strip, modeled on the
  POCSAG panel; no charset selector.
- Decode-enable toggle + status strip in `vfo.ts` / `vfo-panel.html` /
  `connection.ts` / `backend.ts`, mirroring the POCSAG wiring.

Tests:

- `test/decoders/golay.spec.js` — capture-fixture-driven, mirroring
  `test/decoders/pocsag.spec.js`.

## Known blocker / caveat

- **No decodable GSC capture fixture yet.** POCSAG had multimon-ng `.raw`
  fixtures to assert against. Without a real GSC capture, tests can only prove the
  code path with a synthetic Golay/BCH harness, not end-to-end decode. This is the
  main gap to parity with the POCSAG test suite.
- **BrowSDR is pure client-side** (Vite static + Cloudflare Worker; decode runs in
  an in-page Web Worker), so there is no backend to inject a test message — same
  constraint hit during the POCSAG work.

## Verification (match the POCSAG PR bar)

- `npm run typecheck`
- `npm run lint` (`--max-warnings 0`)
- `npm test` (new GSC spec green alongside the existing suite)
- `npm run build`
- Live over-the-air decode where a real GSC signal / capture is available.
