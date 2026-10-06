// Usage monitor: contract limits vs usage, with alerts. Every value is owned by settings-ui.js
// (the desktop-notification switch has to ask for the permission inside its own click).

export default {
  id: 'usage-monitor',
  name: 'Usage monitor',
  description: 'Alerts when your Iterable contract limits (users, events, sends) near or pass an alert threshold, plus a usage card on Usage and billing. Checks once a day with your login, no key needed.',
  group: 'data',
  frame: 'top',
  routes: [/.*/],
  // Silent until something is past a threshold, and quiet for logins without billing access.
  defaultEnabled: true,
  usesApiKey: false,
  // Optional permission, asked for by the settings switch: "notifications" (desktop notifications).
  actions: [],
  settings: [
    { key: 'thresholds', type: 'percentList', label: 'Alert thresholds', default: [80, 95], hidden: true },
    { key: 'unwatched', type: 'metricList', label: 'Limits not watched', default: [], hidden: true },
    { key: 'banner', type: 'boolean', label: 'Banner across Iterable', default: true, hidden: true },
    {
      key: 'chipMode', type: 'select', label: 'Usage chip in the header', hidden: true, default: 'alert',
      options: [
        { value: 'alert', label: 'Only when a limit passes an alert threshold' },
        { value: 'always', label: 'Always' },
        { value: 'off', label: 'Never' },
      ],
    },
    { key: 'notify', type: 'boolean', label: 'Desktop notification', default: false, hidden: true },
  ],
  customSettings: true,
  legacy: [],
};
