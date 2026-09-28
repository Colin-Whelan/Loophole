export default {
  id: 'dynamic-lists',
  name: 'Dynamic list membership',
  description: "Which dynamic lists a user is in, shown beside the profile's Lists tab. Uses your login, no key needed. Results are cached per user.",
  group: 'users',
  frame: 'top',
  // The profile's Lists tab only, as in the userscript (it anchors beside the list table there).
  routes: [/^\/users\/profiles\/[^/?#]+\/lists(?:[/?#]|$)/],
  defaultEnabled: true,
  usesApiKey: false,
  actions: [{ id: 'check', label: 'Check now' }],
  settings: [
    {
      key: 'autoStart', type: 'boolean', label: 'Check automatically',
      default: false,
      help: "Run a check when you open a profile's Lists tab and there's no cached result. Off by default: one check sends a query per group of 30 lists, plus more to narrow down every hit, so it can fire dozens of queries per profile.",
    },
    {
      key: 'batchSize', type: 'number', label: 'Concurrent queries', min: 1, max: 16, step: 1,
      default: 8,
      help: 'How many membership queries run at once. Lower it if Iterable starts rate limiting (HTTP 429).',
    },
    {
      key: 'showProgressBar', type: 'boolean', label: 'Show progress bar',
      default: true,
    },
    {
      key: 'cacheDays', type: 'number', label: 'Keep results for (days)', min: 1, max: 60, step: 1,
      default: 14,
      help: 'Cached results are shown instead of re-checking until they are this old. Check now always re-checks.',
    },
  ],
  customSettings: false,
  legacy: ['Iterable Dynamic Lists Checker'],
};
