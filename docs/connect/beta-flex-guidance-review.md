# Beta Flex registration guide — 10 October 2026

## Evidence and gaps

Reviewed the supplied Amazon “DA Onboarding Process_Detailed Guide (2)” (57 pages), DropX “DropX_DA_ID_Creation_Multilingual_Guide” (108 pages; repeated language editions), and the live isolated DropX One candidate journey.

| Area | Evidence | Product decision |
| --- | --- | --- |
| Email creation | DropX English pp. 1–7 | Keep existing automated beta alias; do not ask candidates to create another Gmail account. |
| Invitation → Flex | Amazon pp. 12–16; live app stopped at a generic download instruction | Keep invitation, copy email/link and OTP panel; add a prominent Continue in Amazon Flex action opening the embedded guide. |
| Flex registration | Amazon pp. 17–27 | Individual screens for privacy, About You, permanent licence front/back and profile photo. Preserve exact English app labels for finding controls. |
| BGC prerequisites | Amazon pp. 8–11, 20–32 | Explain candidate actions versus station Associate Settings and Amazon/vendor review; do not interpret waiting as insufficiency. Existing received IDfy actions stay separate. |
| UAN | DropX English p. 16 screenshot | Explicitly e-Shram UAN, not EPFO/PF UAN. Yes/No must be truthful. The guides do not document the No branch, so direct candidates to Amazon's actual instructions or their TL. |
| Account setup | Amazon pp. 33–34 | Explain provisioning and the consequences of Agree and Remove before removing previous delivery accounts. |
| Training | Amazon pp. 35–39 | Separate required LM Learning from initial station buddy training. TL supplies assigned course/login; never assume Flex credentials also work there. |
| Completion evidence | Amazon pp. 41–53; current beta API | Guide navigation never changes status. Current isolated API receives invitation/IDfy emails, not full live Flex/UAN/training task evidence. State that limitation instead of displaying inferred UAN completion. |

The DropX PDF captions occasionally describe email steps while screenshots show Flex, BGC or UAN. The embedded guide follows the visible screen labels plus Amazon's task sequence. It omits outdated shared-password examples and does not redistribute PDF screenshots containing personal documents or credentials. No fixed review SLA is promised.

## Shipped scope

Presentation changes in DropX One only. Exact selected email-pilot account plus isolated response required. No migrations, backend writes, Workforce/payout/mapping edits, worker changes, or expansion of access. Existing registration and invitation prerequisites remain enforced.

English remains the default. The existing station-state mapping offers Malayalam, Telugu, Tamil, Kannada, Hindi or Odia. Guide instructions, navigation, invitation handoff, OTP waiting/resend/errors and copy controls have all seven versions. Entered names, identifiers and Amazon screen labels are not translated. Unsupported state continues in English.

Desktop has a compact step rail; mobile uses a step selector and large next/back buttons. Only one guide screen is visible. Troubleshooting is expandable. Language switching retains the selected guide step. Contextual entry points also appear under background verification, account setup/UAN and the final training/delivery milestone.

## Validation

- Existing prebuild suite and canonical/beta isolation checks pass.
- Added deny-by-default guide gating and complete translation/OTP-state coverage tests.
- Type check and production build required before release.
- Local browser checked all nine steps, language switching and all seven languages at 390px with no horizontal overflow; desktop layout inspected.
- Temporary local fixture is removed before commit. No Amazon registration, terms acceptance, password change or other external account mutation was performed for UI testing.

## Illustrated guide follow-up

Fifteen examples now cover all nine guide steps. Thirteen come from the DropX guide's English section; the two old-account screens come from Amazon p. 34. A compact single-screen viewer replaces the main text list, with numbered field pointers in all seven languages. Original fuller instructions remain in expandable help. Multiple screens have previous/next controls; tap the preview to enlarge. Language changes preserve the selected screen; changing guide steps resets the screen index. Opening a screen never changes registration status.

The original PDF images include real personal information, document photos and a shared password. `scripts/build-beta-flex-examples.py` removes those pixels using native PDF redaction, inserts field placeholders, and exports flattened PNGs. Only these reviewed PNGs and a provenance manifest are committed; no source PDF or unredacted extracted image is published. Screens are examples, not representations of the current candidate's status. Native Amazon labels stay in English, accompanied by localized instructions. Consent, Yes/No history and UAN answers must be personal and truthful; no example answer should be copied.

All fifteen sanitized images were visually inspected. Tests require complete localized captions, a screen for every guide step, known PNG-only assets without embedded metadata, and redaction entries for screens that held personal information. Existing beta gates are unchanged; no route, database, registration, worker, payroll or mapping logic is modified.
