import { DEFAULT_GA_CAMPAIGN, DEFAULT_LINK_PARAMS, DEFAULT_SHORTCUT } from './config.js';

export default {
  id: 'workflow-params',
  name: 'Workflow link parameters',
  description: 'Fills Google Analytics and link parameters in journey and template Details panels.',
  group: 'campaigns',
  frame: 'top',
  routes: [/^\/workflows\/[^/]+\/edit/, /^\/templates\/editor/],
  defaultEnabled: true,
  usesApiKey: false,
  actions: [{ id: 'apply', label: 'Apply link parameters' }],
  settings: [
    { key: 'enableGA', type: 'boolean', label: 'Google Analytics',
      help: 'Tick "Google analytics" and fill the campaign value. Off: untick it.', default: true },
    { key: 'gaCampaign', type: 'string', mono: true, label: 'GA campaign value (utm_campaign)',
      placeholder: DEFAULT_GA_CAMPAIGN, default: DEFAULT_GA_CAMPAIGN },
    { key: 'enableLinkParams', type: 'boolean', label: 'Link parameters',
      help: 'Tick "Link parameters" and fill the rows below. Off: untick it.', default: true },
    { key: 'linkParams', type: 'keyValueList', label: 'Parameters to add',
      help: 'Common ones: utm_source (e.g. iterable), utm_medium (email, sms or push; match the channel), utm_content, utm_term. '
        + 'Leave out any that Iterable’s Google Analytics option already adds. Rows whose key already exists are updated, '
        + 'not duplicated. Handlebars such as {{now format="yyyyMMdd"}} works.',
      default: DEFAULT_LINK_PARAMS.map((p) => ({ ...p })) },
    { key: 'shortcut', type: 'shortcut', label: 'Keyboard shortcut',
      help: 'Applies the parameters while a Links section is open. Clear it to turn the shortcut off.',
      default: DEFAULT_SHORTCUT },
  ],
  customSettings: false,
  legacy: ['Iterable Workflow - Add Google Tracking Params'],
};
