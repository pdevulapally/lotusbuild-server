# Retention schedule — proposed, not activated

Prepared 5 September 2026 for SR IT support services. The owner requested recommendations; approval of the proposed operational periods is still pending.

There is no universal GDPR rule requiring all application data to be kept for six years. Periods must be justified by purpose and reviewed. [ICO storage limitation guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-protection-principles/a-guide-to-the-data-protection-principles/storage-limitation/).

| Record | Proposed rule | Implementation/evidence needed |
| --- | --- | --- |
| Active account projects and transcripts | Keep while the customer uses the service, subject to deletion requests | Owner-authorized project deletion and full account request workflow |
| Inactive free accounts | Review after 12 months; give 30 days' notice before proposed deletion | Define activity; notification delivery and exceptions; no automatic policy enabled |
| Deleted-account live content | Operational target: remove within 7 days after applicable verification and decision; restrict access promptly | End-to-end deletion across Firebase, object storage, Redis and sandbox provider |
| Backups, versions and soft-deleted content | Proposed expiry within 30 days; place deleted data beyond normal use meanwhile | Verify each provider; deletion must be reapplied after recovery |
| Redis session events | Use the configured event TTL and count cap; erase known session keys on project deletion | Confirm the production values and Redis persistence/backup behavior |
| Replaced or abandoned snapshots | Collect from the durable upload ledger; release quota only after successful retirement | Cleanup indexes, worker operation, failed-job monitoring and provider version policy |
| Zero-byte upload replay barriers | Keep while necessary to prevent an outstanding create-only upload from recreating content | They contain no project content; remove identifying job metadata; review safe expiry with provider evidence |
| Usage reconciliation evidence | Keep until accounting is resolved, then retain only the justified billing/security subset | Define final period; do not discard unknown charges or retain prompts as billing evidence |
| Privacy complaints, rights requests and incident records | Retain a minimal record for a documented accountability/claims period | Operator/legal review must set that period; restrict access |
| Required company accounting records | Normally 6 years from the end of the company financial year concerned, with applicable longer-retention exceptions | Accountant confirms covered records and exceptions; isolate from ordinary project content |

The accounting rule concerns company accounting records, not a general justification to retain customers' source code, chats or entire accounts. [GOV.UK company and accounting records](https://www.gov.uk/running-a-limited-company/company-and-accounting-records).

Legal holds must identify the specific data, reason, decision-maker and review date. Explain applicable exceptions to the requester. A failed cleanup stays pending and must not be reported as completed. After restoring a backup, reapply the deletion ledger before restoring customer access.

Approval must record the selected periods, the business purpose for each, the responsible operator and evidence that the providers can meet them. This document does not authorize bulk deletion, change provider retention or schedule automatic account expiry.
