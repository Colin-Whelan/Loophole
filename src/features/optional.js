// Optional per-feature modules for the options page: each feature folder MAY contain
// import.js (legacy importer, ARCHITECTURE §8.3) and settings-ui.js (custom settings editor).
//
// The build generates these two virtual modules by scanning src/features/*/ (see the
// `wb-features` plugin in scripts/build.mjs), so adding either file needs no registration.
// Each is `{ [featureId]: module }`.

import importers from 'wb-virtual:importers';
import settingsUis from 'wb-virtual:settings-ui';

export { importers, settingsUis };
