/*
 * Copyright (c) 2026 jLynx <https://github.com/jLynx>
 *
 * This file is part of BrowSDR.
 *
 * BrowSDR is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of
 * the License, or (at your option) any later version.
 *
 * BrowSDR is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public
 * License along with this program. If not, see
 * <https://www.gnu.org/licenses/>.
 */

import init, { FFT, DspProcessor, set_panic_hook, alloc_iq_buffer, free_iq_buffer } from '/wasm/dsp/browsdr_dsp.js';

// wasm module (top-level import)
let wasmInitialized = false;

export async function ensureWasmInitialized(): Promise<void> {
	if (!wasmInitialized) {
		await init();
		set_panic_hook();
		wasmInitialized = true;
	}
}

export { init, FFT, DspProcessor, set_panic_hook, alloc_iq_buffer, free_iq_buffer };
