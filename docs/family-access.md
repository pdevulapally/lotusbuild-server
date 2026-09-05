# Parent-owned linked access

Backend implementation, awaiting frontend integration and an age/parent-assurance decision. All routes require a Firebase bearer token; parent/child invitation actions require verified email. Ordinary account registration does not establish age. A person controlling two verified emails can still misrepresent parental responsibility: this workflow alone is not verified parental consent.

1. Parent calls `POST /family/invitations` with `adultConfirmed: true` and `parentalResponsibilityConfirmed: true`. The response includes a short-lived one-use token and parent UID. Show it privately; do not put it in analytics or URL query strings. Only its hash is stored. A new invitation replaces the parent's previous one.
2. The child signs into their own account and calls `POST /family/accept` with `parentUid` and `token`. The link is PENDING. Self-linking, existing project owners and billing accounts are refused. The parent must check the intended child's identity before approval.
3. Parent lists `GET /family/children`, then calls `PATCH /family/children/:childUid` with `approved: true`. Parent explicitly grants each project using `PATCH /family/children/:childUid/projects/:projectId` with `enabled: true`.
4. Child reads granted metadata at `GET /family/projects/:projectId` and transcript at `GET /family/projects/:projectId/sessions/:sessionId/messages`. The transcript is bounded to the most recent 100 messages. Parent tokens, billing access, deletion, sharing controls and unrestricted session access are never delegated.
5. Child submits `POST /family/projects/:projectId/build-requests` with `prompt` and `model`. One pending/approving request is retained per child/project. Parent lists `GET /family/children/:childUid/build-requests`, reviews the request, then submits `POST /family/children/:childUid/projects/:projectId/build-requests/decision` with `requestId` and `approved`. Approval runs against the parent's entitlements and records one durable session ID so retries cannot charge a second build.
6. Parent revokes a project with `enabled: false` or the link with `approved: false`. Revoked linked accounts cannot create independent projects or billing identities. Already approved builds belong to the parent; cancel them separately through the normal session controls when needed.

Parent lists accept `limit` (1–200, default 100) and `after`, returning `nextCursor`. Frontend must paginate until null when reviewing all records. Never interpret successful invitation acceptance as approved access. Explain child-visible data and parent visibility in age-appropriate language, and provide account recovery and dispute processes before launch. Parent supervision does not remove protections for 16- and 17-year-olds.

## Public preview behavior

Projects default to `publicPreviewEnabled: false`. An owner opts in using `PATCH /projects/:projectId/public-preview` with `enabled: true` while no build is active. The agent cannot opt in. E2B creation then receives the explicit public-ingress setting. Private projects cannot use `start_preview` to expose a public URL; authenticated private browser preview integration remains outstanding.

Disabling a running public preview requests cancellation and returns 202 with `terminationPending: true`. Show that access may persist until the sandbox actually terminates. A private flag cannot recall recipient copies or prevent outbound tunnels from hostile code. Do not describe the feature as instant revocation or complete network isolation.
