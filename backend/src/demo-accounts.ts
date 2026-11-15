/** Public test credentials, deliberately kept on the backend and separate from SQL users. */
export const DEMO_ACCOUNTS = [
  { email: 'alex@juyo.local', name: 'Alex Morgan', password: 'juyo-demo' },
  { email: 'sarah@juyo.local', name: 'Sarah Laurent', password: 'juyo-demo' },
  { email: 'marco@juyo.local', name: 'Marco Silva', password: 'juyo-demo' },
] as const;
