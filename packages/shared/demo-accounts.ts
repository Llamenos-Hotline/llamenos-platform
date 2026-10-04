/**
 * Demo account metadata — shared between worker (seeding) and client (login page).
 *
 * Carries no key material. The accounts' signing keys are generated per process
 * on a development server (apps/worker/lib/demo-identities.ts) and exist nowhere
 * else.
 */
export interface DemoAccount {
  name: string
  roleIds: string[]
  /**
   * Stable handle for the account in the login picker. A legacy secp256k1
   * x-only key, not the account's Ed25519 signing key.
   */
  pubkey: string
  phone: string
  description: string
  spokenLanguages: string[]
}

export const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    name: 'Demo Admin',
    roleIds: ['role-super-admin'],
    pubkey: '9bfc4116dc9d579cc0f88d58af7bef098f8bc31a16e053deb1de4525b79fe9da',
    phone: '+15551000001',
    description: 'Full access: manage volunteers, settings, shifts',
    spokenLanguages: ['en', 'es'],
  },
  {
    name: 'Maria Santos',
    roleIds: ['role-volunteer'],
    pubkey: '31fd9a5f6f04d11a08e85f9ab2c8cfd3b1ea4ccf5a798c55e323ff924bc59f90',
    phone: '+15551000002',
    description: 'Active volunteer, answer calls, write encrypted notes',
    spokenLanguages: ['en', 'es', 'pt'],
  },
  {
    name: 'James Chen',
    roleIds: ['role-volunteer'],
    pubkey: '783f763464dfbdb4a5853f5a27a53a68827dfa7bf8b95418b253cc55f3e4b947',
    phone: '+15551000003',
    description: 'Active volunteer, currently on shift',
    spokenLanguages: ['en', 'zh'],
  },
  {
    name: 'Fatima Al-Rashid',
    roleIds: ['role-volunteer'],
    pubkey: '4ea8b293d9aaf2c06ab4902b7b8b0d515f00cf4f37728c268b70a7e0c1f20533',
    phone: '+15551000004',
    description: 'Inactive volunteer (deactivated)',
    spokenLanguages: ['en', 'ar'],
  },
  {
    name: 'Community Reporter',
    roleIds: ['role-reporter'],
    pubkey: '8bd8335c35a2966fd58ee7a7a7508a8b5c4844b0103c946ddfe1cd4381259e06',
    phone: '+15551000005',
    description: 'Submit community reports, track status',
    spokenLanguages: ['en'],
  },
]
