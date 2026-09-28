export default {
  id: 'bulk-data',
  name: 'Bulk data',
  description: 'Push user profiles, list memberships and catalog items from CSV files, and export catalogs to CSV, in a drawer beside the left nav on the Lists and Catalogs pages. Rate-limited, retried, resumable.',
  group: 'data',
  frame: 'top',
  // The lists and catalogs indexes only (any query), not /lists/123 or /catalogs/table/<name>.
  routes: [/^\/lists\/?(?:[?#]|$)/, /^\/catalogs\/?(?:[?#]|$)/],
  defaultEnabled: true,
  usesApiKey: true,
  actions: [{ id: 'open', label: 'Open' }],
  settings: [
    { key: 'rateLimit', type: 'number', label: 'Requests per second', help: 'Capped at 10, Iterable’s limit for users/bulkUpdate.', min: 0.1, max: 10, step: 0.1, default: 5, section: 'Users & lists' },
    { key: 'batchSize', type: 'number', label: 'Rows per batch', help: 'Up to 1000. Lower it if batches fail with HTTP 413 (wide CSVs can pass Iterable’s 4 MB request cap).', min: 1, max: 1000, step: 1, default: 500, section: 'Users & lists' },
    { key: 'catalogRateLimit', type: 'number', label: 'Requests per second', help: 'Capped at 100, Iterable’s per-project limit for catalog item requests. Used for uploads and exports.', min: 0.1, max: 100, step: 0.1, default: 10, section: 'Catalogs' },
    { key: 'catalogBatchSize', type: 'number', label: 'Items per batch', help: 'Up to 1000, Iterable’s per-request item cap. A batch also closes early at 4 MB of documents.', min: 1, max: 1000, step: 1, default: 1000, section: 'Catalogs' },
  ],
  customSettings: false,
  legacy: ['Iterable User Push', 'Iterable Catalog Push'],
};
