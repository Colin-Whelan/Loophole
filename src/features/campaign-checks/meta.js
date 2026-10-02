export const RATE_MIN = 1;
export const RATE_MAX = 100000;

export default {
  id: 'campaign-checks',
  name: 'Campaign checks',
  description: 'An approval view (details, checks and the email side by side, copyable as a card, text or screenshot), pre-launch badges for seed lists, suppression lists and the subject line, a schedule preview that fills Iterable’s schedule dialog, and a send-rate helper.',
  group: 'campaigns',
  frame: 'top',
  routes: [/^\/campaigns\//],
  defaultEnabled: true,
  usesApiKey: false,
  actions: [
    { id: 'approval', label: 'Approval view', routes: [/^\/campaigns\/\d+/] },
    // Handled by the popup itself: it captures the tab (the toolbar click grants activeTab) and
    // writes the clipboard. Shown only on a campaign's own page.
    { id: 'approval-screenshot', label: 'Copy approval screenshot', popup: 'capture', routes: [/^\/campaigns\/\d+/] },
  ],
  settings: [
    { key: 'seedListCheck', type: 'boolean', label: 'Check for a seed list', help: 'Warns when no send list name contains the keyword below.', default: true, section: 'Lists' },
    { key: 'seedListKeyword', type: 'string', label: 'Seed list keyword', placeholder: 'Seed', help: 'Matched anywhere in the list name, ignoring case.', default: 'Seed', section: 'Lists' },
    { key: 'suppressListCheck', type: 'boolean', label: 'Check suppression lists', help: 'Always shows a state next to Iterable’s suppression field and in the approval card: lists attached and rules met, none attached, or a required list missing (the chip’s tooltip says which rule asked for it).', default: true, section: 'Lists' },
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
    { key: 'alwaysRequireSuppression', type: 'string', label: 'Always require these suppression lists', placeholder: 'Global Unsubscribes', help: 'Every campaign must have these (comma-separated; matched anywhere in an attached list’s name, ignoring case). Keyword rules below add campaign-specific ones.', default: '', section: 'Lists' },
    { key: 'warnNoSuppression', type: 'boolean', label: 'Warn when a campaign has no suppression list', help: 'Shown even when no rule applies. Turn off if your project never uses them.', default: true, section: 'Lists' },
    { key: 'audienceCheck', type: 'boolean', label: 'Check the audience size', help: 'Flags a campaign whose estimated recipients are zero (error) or under the number below (warning), next to Iterable’s Recipients field and in the approval card.', default: true, section: 'Lists' },
    { key: 'audienceMin', type: 'number', label: 'Warn when fewer recipients than', min: 0, step: 1, default: 100, help: 'Set to 0 to only flag an empty audience.', section: 'Lists' },
    { key: 'subjectCheck', type: 'boolean', label: 'Check the subject line', help: 'Flags line breaks, tabs and Unicode line/paragraph separators.', default: true, section: 'Lists' },
    { key: 'approvalView', type: 'boolean', label: 'Approval view', help: 'An “Approval view” button in the campaign header opens one screen with the details, checks and the start of the actual email, ready to copy as a card image, text or a screenshot.', default: true, section: 'Approval' },
    { key: 'approvalShortcut', type: 'shortcut', label: 'Open the approval view', help: 'Optional keyboard shortcut on campaign pages.', default: '', section: 'Approval' },
    { key: 'openApprovalAutomatically', type: 'boolean', label: 'Open it automatically', help: 'Once per visit, on campaigns that aren’t launched yet.', default: false, section: 'Approval' },
    { key: 'showCardOnPage', type: 'boolean', label: 'Approval card on the page', help: 'The same details card at the top of the campaign summary, with Copy card / Copy text buttons.', default: false, section: 'Approval' },
    { key: 'compactLayout', type: 'boolean', label: 'Compact campaign page', help: 'Moves Sending information and the schedule to the top of the summary and tightens spacing (CSS only, using Iterable’s data-test hooks). If Iterable changes its page, you just get the normal layout.', default: false, section: 'Approval' },
    { key: 'remoteImagesDefault', type: 'boolean', label: 'Load remote images in the preview', help: 'On: the approval view’s email preview shows the email’s images (their hosts see the request, tracking pixels fire). Off: nothing is fetched until you switch it on in the view. Either way scripts never run and links never navigate.', default: true, section: 'Approval' },
    { key: 'schedulePreview', type: 'boolean', label: 'Schedule preview', help: 'On campaigns that aren’t launched yet: pick a send time, see how far away it is, and fill it into Iterable’s Schedule dialog. You still review and confirm there.', default: true, section: 'Schedule' },
    { key: 'rateHelper', type: 'boolean', label: 'Send-rate helper', help: 'Shows your usual rate limit in the campaign’s Optimize section and fills it into Iterable’s rate-limit field when that field is on the page. You save through Iterable.', default: true, section: 'Send rate' },
    { key: 'customRateLimit', type: 'number', label: 'Messages per minute', min: RATE_MIN, max: RATE_MAX, step: 1, default: 4000, section: 'Send rate' },
  ],
  customSettings: false,
  legacy: ['Campaign Preview Enhancements'],
};
