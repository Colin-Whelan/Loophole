// Every feature's metadata, in display order. Safe to import anywhere: metas have no side effects.
// Adding a feature: import its meta here. That's the only registration: the build maps each
// meta to src/features/<meta.id>/index.js and bundles it into the content entry for its
// meta.frame (wb-virtual:impls/top|bee, scripts/build.mjs); import.js and settings-ui.js are
// picked up by folder (features/optional.js).

import deleteUser from './delete-user/meta.js';
import bulkData from './bulk-data/meta.js';
import quickSearch from './quick-search/meta.js';
import linkParams from './link-params/meta.js';
import localeBanner from './locale-banner/meta.js';
import eventCopy from './event-copy/meta.js';
import exportSelect from './export-select/meta.js';
import workflowParams from './workflow-params/meta.js';
import dynamicLists from './dynamic-lists/meta.js';
import quicklinks from './quicklinks/meta.js';
import userLookup from './user-lookup/meta.js';
import emailScanner from './email-scanner/meta.js';
import fieldExplorer from './field-explorer/meta.js';
import profileEditor from './profile-editor/meta.js';
import snippets from './snippets/meta.js';
import imageLibrary from './image-library/meta.js';
import creativePreviews from './creative-previews/meta.js';
import livePreview from './live-preview/meta.js';
import beeUndo from './bee-undo/meta.js';
import campaignChecks from './campaign-checks/meta.js';
import loginAutofill from './login-autofill/meta.js';

export const FEATURES = Object.freeze([
  quickSearch,
  linkParams,
  imageLibrary,
  snippets,
  creativePreviews,
  livePreview,
  beeUndo,
  localeBanner,
  workflowParams,
  campaignChecks,
  emailScanner,
  deleteUser,
  profileEditor,
  dynamicLists,
  eventCopy,
  bulkData,
  exportSelect,
  fieldExplorer,
  quicklinks,
  userLookup,
  loginAutofill,
]);

/** Group ids in display order, with the label shown on the options page. */
export const GROUPS = Object.freeze([
  { id: 'templates', label: 'Templates' },
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'users', label: 'Users' },
  { id: 'data', label: 'Data' },
  { id: 'navigation', label: 'Navigation' },
  { id: 'signin', label: 'Sign-in' },
]);

const byId = new Map(FEATURES.map((m) => [m.id, m]));

export function getMeta(id) {
  return byId.get(id) || null;
}

/** Has a settings page (auto form with at least one visible field, and/or a custom editor). */
export function hasSettings(meta) {
  return !!(meta.customSettings || (meta.settings || []).some((f) => !f.hidden));
}

/** Features grouped for display: [{ id, label, features: [meta] }], empty groups dropped. */
export function groupedFeatures() {
  const known = new Set(GROUPS.map((g) => g.id));
  const groups = GROUPS.map((g) => ({ ...g, features: FEATURES.filter((m) => m.group === g.id) }));
  const other = FEATURES.filter((m) => !known.has(m.group));
  if (other.length) groups.push({ id: 'other', label: 'Other', features: other });
  return groups.filter((g) => g.features.length);
}

