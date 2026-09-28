export default {
  id: 'delete-user',
  name: 'Delete user',
  description: 'Two-step delete button on user profile pages. Shows the exact API call and cross-checks the user with the saved key before it runs.',
  group: 'users',
  frame: 'top',
  routes: [/^\/users\/profiles\//],
  defaultEnabled: true,
  usesApiKey: true,
  actions: [],
  settings: [
    {
      key: 'defaultIdentifier', type: 'select', label: 'Identify users by',
      options: [
        { value: 'auto', label: 'Automatic (userId when the profile has one)' },
        { value: 'email', label: 'Email' },
        { value: 'userId', label: 'userId' },
      ],
      default: 'auto',
      help: 'Preselected in the delete popover. Automatic prefers userId, which works on every project type (the email endpoint fails on userId-based projects). Email / userId: that one when the profile shows it, otherwise the other one.',
    },
  ],
  customSettings: false,
  legacy: ['Iterable Delete User'],
};
