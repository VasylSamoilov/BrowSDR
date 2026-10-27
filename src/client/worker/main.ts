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

import * as Comlink from 'comlink';
import { Backend } from './runtime/backend';

if (import.meta.env.DEV) {
	for (const level of ['log', 'warn', 'error'] as const) {
		const original = console[level].bind(console);
		console[level] = (...values: unknown[]) => {
			original(...values);
			self.postMessage({ type: 'sdr-debug-log', level, message: values.map(String).join(' ') });
		};
	}
}

Comlink.expose(Backend);
