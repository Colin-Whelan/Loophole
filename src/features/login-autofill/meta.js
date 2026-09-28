// Login autofill: fills your username on Iterable's sign-in page (auth.iterable.com) and moves on
// to the password step. Runs in the optional 'auth' frame (ARCHITECTURE §4): off by default, and
// switching it on asks for access to auth.iterable.com. Never touches the password.
import { AUTH_ORIGIN_PATTERN, LOGIN_ROUTE, MAX_DELAY } from './logic.js';

export default {
  id: 'login-autofill',
  name: 'Fill username on login',
  description: 'Fills your username on Iterable’s sign-in page and moves to the password step. Press Esc to cancel.',
  group: 'signin',
  frame: 'auth',
  permissions: { origins: [AUTH_ORIGIN_PATTERN] },
  routes: [LOGIN_ROUTE],
  defaultEnabled: false,
  usesApiKey: false,
  actions: [],
  settings: [
    {
      key: 'email', type: 'string', label: 'Username (email)', mono: true, placeholder: 'you@example.com',
      help: 'Filled into the sign-in page’s username field. Stored only in this browser’s extension storage, never synced or sent anywhere else. Leave empty to turn filling off.',
      default: '',
    },
    {
      key: 'autoContinue', type: 'boolean', label: 'Continue to the password step automatically',
      help: 'When off, the username is only filled in and you click Continue yourself.',
      default: true,
    },
    {
      key: 'delay', type: 'number', label: 'Seconds before continuing', min: 0, max: MAX_DELAY, step: 1,
      help: 'A countdown shows at the bottom right; press Esc or Cancel to stop it for this page load. 0 continues immediately, leaving no time to cancel.',
      default: 5,
    },
  ],
  customSettings: false,
  legacy: ['Login Screen - Auto Fill Username'],
};
