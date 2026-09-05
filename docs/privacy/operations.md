# Privacy operations — pre-launch runbook

Prepared 5 September 2026. This is an internal procedure to implement and rehearse, not evidence that it is operating. The company contact is info@sritsupportservices.co.uk. Assign a responsible person and backup before opening registration.

## Requests and complaints

Monitor the contact mailbox and authenticated privacy requests every working day. The API stores `privacyRequests/{uid}/requests/{kind}`; it sends no email notification and has no case-management dashboard. Keep a restricted case journal containing the request reference, receipt date, identity checks, responsible person, deadlines, action, outcome and any justified extension. The API's current-request document is not a complete historical case journal.

Accept requests from people who cannot sign in, and requests for restriction, objection or portability through the mailbox. Verify identity proportionately; never require an excessive identity-document copy by default. For access, identify relevant systems, produce an understandable export, review third-party data and transmit it through an authenticated or suitably protected channel. No automatic access export is implemented here.

Apply the relevant rights deadline, normally one calendar month, and document any lawful extension or exception. A privacy complaint has a separate acknowledgement requirement of 30 days; investigate and communicate the outcome without undue delay. This UK complaints duty has applied since June 2026. [ICO complaints requirements](https://ico.org.uk/about-the-ico/media-centre/news-and-blogs/2026/06/new-data-protection-complaints-law-now-in-force/), [EU GDPR, Articles 12–22](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng).

## Erasure

1. Record the verified request and decide what must be erased, retained, restricted or referred to a business customer acting as controller. Review active Stripe subscriptions, refunds and disputes. Deleting Firebase Auth does not cancel a Stripe subscription.
2. Prepare a private JSON decision file with string fields `uid`, `requestReference`, `billingReviewReference`, and `retentionDecisionReference`. References must point to the real reviewed case and decisions, not invented evidence. Keep this file outside Git.
3. Inspect with `node --env-file=.env --experimental-strip-types src/privacy/run-erasure.ts decision.json`. The default is read-only.
4. On an approved case, the same command with `--apply` disables/revokes account access, requests active build cancellation, and refuses content erasure while active sessions or unresolved reservations remain. Retry after runners finish and provider-backed reconciliation establishes usage. Never clear unknown holds by guessing zero.
5. Successful live-content processing removes owned projects and their accessible object generations, linked access and the root account profile. Financial/usage subcollections and minimal request evidence remain for the reviewed purpose. The returned status is `LIVE_CONTENT_ERASED_VENDOR_CONFIRMATION_PENDING`, not complete erasure.
6. Verify Firebase backups, GCS soft-deleted copies, provider snapshots, E2B resources, AI-provider records, Stripe and any support/log copies separately. Record their applicable expiry or justified retention. Backups restored later must reapply the erasure ledger before serving traffic. Zero-byte storage barriers must not be removed while an outstanding signed upload could recreate content.
7. Tell the requester accurately what was erased, what is retained and why, and what vendor-copy expiry remains. Close the case only when that assessment is complete. Review the erasure ledger itself under an approved minimal retention rule.

The proposed retention schedule is in [retention-draft.md](retention-draft.md). The normal six-year limited-company accounting rule applies to relevant accounting records, not every prompt or project. [GOV.UK accounting records](https://www.gov.uk/running-a-limited-company/company-and-accounting-records).

## Incidents

Record awareness time, scope, affected systems, containment and preservation decisions. Revoke compromised credentials and contain access through the incident owner; preserve necessary evidence with restricted access. Assess risk to people and whether authority notification is required. Where the controller notification threshold is met, the usual limit is 72 hours from awareness; processors notify their controller without undue delay. Assess notification to individuals separately. Do not wait for a complete forensic report before assessing the deadline. [ICO breach guidance](https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach/personal-data-breaches-a-guide/).

Before launch, rehearse a stolen token, exposed preview, unknown AI usage, failed object deletion and restored-backup erasure scenario. Record actual results, contact ownership and corrective actions. No incident exercise has been performed against a live LotusBuild environment in this work.

## Legal and vendor decisions still needed

Confirm company disclosures; lawful bases and processor/controller roles; customer DPA schedules; vendor contracts, subprocessors, locations and transfers; retention approval; children's risk assessment and age/parent assurance; EU representative applicability; ICO fee assessment; public-sharing Online Safety Act/DSA scope and reporting procedures; AI Act role and applicable obligations; and consumer terms/cancellation information before offering paid consumer service. The lack of customers does not exempt personal data already processed during development. These are open assessments, not findings that every listed law necessarily applies or has been breached.
