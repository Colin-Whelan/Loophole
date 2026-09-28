// MAIN-world entry for app.getbee.io frames (document_start, all frames). Only built and listed in
// the manifest when some feature that runs in bee frames ships a main.js (scripts/build.mjs); no
// shipped feature does today. It runs in every app.getbee.io frame, Iterable-embedded or not: the
// handlers only answer once the isolated content/bee.js (which does check the embedding) activates
// them, and like every main.js they must be harmless by design (ARCHITECTURE §6.3).

import { startRpcHost } from './rpc-host.js';
import MAIN_HANDLERS from 'wb-virtual:main/bee';

try { startRpcHost(MAIN_HANDLERS); } catch (e) { console.error('[Loophole:page] RPC host failed to start', e); }
