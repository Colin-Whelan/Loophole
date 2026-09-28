export const RATE_MIN = 1;
export const RATE_MAX = 100000;

export default {
  id: 'campaign-checks',
  name: 'Campaign checks',
  description: 'Pre-launch badges for seed lists, required suppression lists and the subject line, a schedule preview that fills Iterable’s schedule dialog, and a send-rate helper.',
  group: 'campaigns',
  frame: 'top',
  routes: [/^\/campaigns\//],
  defaultEnabled: true,
  usesApiKey: false,
  actions: [],
  settings: [
    { key: 'seedListCheck', type: 'boolean', label: 'Check for a seed list', help: 'Warns when no send list name contains the keyword below.', default: true, section: 'Lists' },
    { key: 'seedListKeyword', type: 'string', label: 'Seed list keyword', placeholder: 'Seed', help: 'Matched anywhere in the list name, ignoring case.', default: 'Seed', section: 'Lists' },
    { key: 'suppressListCheck', type: 'boolean', label: 'Check suppression lists', help: 'Flags missing required lists (rules below), or a campaign with no suppression list at all.', default: true, section: 'Lists' },
    {
      key: 'campaignRules',
      type: 'objectList',
      label: 'Required suppression lists',
      help: 'A rule applies when the campaign name contains one of its keywords (or to every campaign when “All campaigns” is on). Each required list must match part of an attached suppression list’s name. Separate several with commas.',
      itemLabel: 'Rule',
      titleField: 'keywords',
      fields: [
        {
          key: 'keywords', type: 'string', label: 'Campaign name keywords', placeholder: 'survey, research',
          validate: (v, item) => (item?.isGlobal || String(v ?? '').trim() ? null : 'Add a keyword, or turn on “All campaigns”.'),
        },
        { key: 'requiredLists', type: 'string', label: 'Required suppression lists', placeholder: 'Survey opt-outs', required: true },
        { key: 'isGlobal', type: 'boolean', label: 'All campaigns', default: false },
      ],
      default: [],
      section: 'Lists',
    },
    { key: 'subjectCheck', type: 'boolean', label: 'Check the subject line', help: 'Flags line breaks, tabs and Unicode line/paragraph separators.', default: true, section: 'Lists' },
    { key: 'schedulePreview', type: 'boolean', label: 'Schedule preview', help: 'On campaigns that aren’t launched yet: pick a send time, see how far away it is, and fill it into Iterable’s Schedule dialog. You still review and confirm there.', default: true, section: 'Schedule' },
    { key: 'rateHelper', type: 'boolean', label: 'Send-rate helper', help: 'Shows your usual rate limit in the campaign’s Optimize section and fills it into Iterable’s rate-limit field when that field is on the page. You save through Iterable.', default: true, section: 'Send rate' },
    { key: 'customRateLimit', type: 'number', label: 'Messages per minute', min: RATE_MIN, max: RATE_MAX, step: 1, default: 4000, section: 'Send rate' },
  ],
  customSettings: false,
  legacy: ['Campaign Preview Enhancements'],
};
