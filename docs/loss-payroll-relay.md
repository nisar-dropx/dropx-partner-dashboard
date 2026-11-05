# Loss payroll relay

OpsPulse and People must have the same server-only `LOSS_PAYROLL_RELAY_SECRET` in production. Set a random secret of at least 32 bytes in both deployment environments before releasing this change. Never expose it through a public environment variable. Database service keys may differ and should not be changed for this integration.

The signed company-scoped POST uses a purpose-bound HMAC and a 60-second timestamp window. People refreshes only eligible open payrolls and checks source, payroll and bank versions before committing. A missing or rejected response stays pending in OpsPulse; it is not reported as applied. The existing database-key fallback remains only for installations without a dedicated relay credential.

Validation: test with different database keys and the same relay secret; reject altered bodies, expired signatures and the database key when a dedicated secret is configured. After deployment, verify the production endpoint returns refreshed/unchanged counts and reconcile recovery keys and amounts against payroll items.
