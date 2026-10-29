# Current isolated beta workspace lifecycle

Rollout: company `43866344-b550-4e8a-9a2d-9d23f3d8a997`, candidate `4732e7e3-df91-4c8b-8ea4-0ed77f382313` only. Other beta and canonical accounts retain their existing behaviour.

| Evidence | Beta navigation | Remaining work |
| --- | --- | --- |
| No verified Amazon activation | Work setup, registration, private inbox | Continue the next onboarding task |
| Identity-matched Amazon ACTIVE with a valid observation time | Home, Work, payment readiness, profile, inbox; setup remains history | Review registration and biometric mapping separately |
| Retained ACTIVE during an upstream provider delay | Keep the beta workspace; show the last confirmation | Retry sync; do not invent a new confirmation time |
| Identity mismatch, missing observation or access-read failure | Setup only | Resolve source/access evidence |
| INACTIVE, OFFBOARDED, offboarded verification case, exit request | Setup/status only | Authorised station/admin follow-up |
| Archived or no longer owned by the signed-in mobile | Remove account access | Authorised restoration/review |

The server keeps `activationOnly: true` on isolated candidates. `betaWorkspaceActive` grants the dedicated beta read views, never canonical attendance edits, leave, roster, advances, payroll or approvals. All reads resolve the signed-in candidate; the browser cannot supply another enrolment or mailbox. Preview cannot open private beta records.

Activation is not registration approval, training evidence, paid attendance or a payment mapping. No candidate is merged into another Workforce/People profile merely because the phone number matches. Real payments require an explicitly reviewed canonical identity and effective rate mapping; the beta payment screen states that these are pending, rather than showing fabricated zero earnings.

The shell refreshes beta access every 30 seconds while visible and on focus. Data views refresh every minute/on focus, and offer retry. Work queries one selected calendar month, with bounded biometric rows since candidate creation; received raw punches remain distinct from approved attendance. A missing OUT is not synthesized.

Before broader rollout: implement and test an audited canonical handover using explicit identity selection and effective ID/pay mappings. Do not remove the isolated server gate as a shortcut.
