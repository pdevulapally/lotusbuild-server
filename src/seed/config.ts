import { planNetworkPolicies } from '../entitlements/schema.ts';

/**
 * The configuration recovered from the deleted Postgres backend, ready to be
 * written into Firestore by `src/seed/run.ts`.
 *
 * Transcribed mechanically from `docs/recovered/postgres-seed-config.sql`
 * rather than retyped: a mistyped allowance or a reversed merge strategy is
 * not a visible bug.
 *
 * Once seeded this stops being the source of truth. Plans and limits are rows
 * meant to be edited in Firestore without a deploy, so re-running the seed
 * overwrites those edits and refuses unless explicitly told to.
 */

export const registryDocument = {
  defaultPlanKey: 'free',
  sandboxTimeMeterKey: 'sandbox.seconds',
  buildMeterKey: 'builds.started',
  inputTokenMeterKey: 'ai.tokens.input',
  outputTokenMeterKey: 'ai.tokens.output',
  storageMeterKey: 'storage.bytes',
  entitlingSubscriptionStatuses: ['TRIALING', 'ACTIVE'],
  entitlementSources: [
    { key: "plan", precedence: 0 },
  ],
  capabilities: [
    { key: "ai.run", valueKind: "boolean", mergeStrategy: "MAX", label: "AI builds" },
    { key: "ai.model.allowlist", valueKind: "stringList", mergeStrategy: "INTERSECTION", label: "Models" },
    { key: "ai.effort", valueKind: "string", mergeStrategy: "OVERRIDE", label: "AI effort" },
    { key: "platform.mobile", valueKind: "boolean", mergeStrategy: "MAX", label: "Mobile apps" },
    { key: "platform.web", valueKind: "boolean", mergeStrategy: "MAX", label: "Web apps" },
    { key: "projects.max", valueKind: "number", mergeStrategy: "MAX", label: "Projects" },
    { key: "skills.max", valueKind: "number", mergeStrategy: "MAX", label: "Skills" },
    { key: "git.persistence", valueKind: "boolean", mergeStrategy: "MAX", label: "Git repositories" },
    { key: "preview.live", valueKind: "boolean", mergeStrategy: "MAX", label: "Live preview" },
  ],
  meters: [
    { key: "ai.tokens.input", unit: "tokens", kind: "COUNTER", resetPeriod: "MONTHLY", label: "Input tokens" },
    { key: "ai.tokens.output", unit: "tokens", kind: "COUNTER", resetPeriod: "MONTHLY", label: "Output tokens" },
    { key: "sandbox.seconds", unit: "seconds", kind: "COUNTER", resetPeriod: "MONTHLY", label: "Sandbox time" },
    { key: "sandbox.concurrent.mobile", unit: "count", kind: "GAUGE", resetPeriod: "NEVER", label: "Concurrent mobile sandboxes" },
    { key: "sandbox.concurrent.web", unit: "count", kind: "GAUGE", resetPeriod: "NEVER", label: "Concurrent web sandboxes" },
    { key: "builds.started", unit: "count", kind: "COUNTER", resetPeriod: "MONTHLY", label: "Builds" },
    { key: "storage.bytes", unit: "bytes", kind: "GAUGE", resetPeriod: "NEVER", label: "Storage" },
  ],
  specialists: [
    {
      key: "architecture",
      label: "Architecture",
      purpose:
        "reviews whether a change fits the codebase - module boundaries, where configuration " +
        "belongs, dependency direction, duplicated logic and complexity that is not earning its keep",
      instructions:
        "You are an architecture reviewer for a codebase another agent is changing.\n\n" +
        "Judge whether a change fits the project as it already is. Look for logic duplicated from " +
        "somewhere that already exists, deployment-specific values written into code instead of " +
        "configuration, dependencies pointing the wrong way, module boundaries being crossed, and " +
        "abstraction that no current requirement asks for.\n\n" +
        "Prefer the smallest thing that works. An extra layer, an interface with one implementation " +
        "or a configuration knob for a value that never changes is a finding, not a virtue.\n\n" +
        "Read the surrounding code before you judge it. Cite the file you read for every finding. " +
        "Reserve a blocking verdict for a change that would genuinely damage the codebase - " +
        "corrupt persisted state, break an existing invariant, or commit the project to something " +
        "expensive to undo. Everything else is a concern.",
      parallelSafe: true,
      validation: false,
    },
    {
      key: "security",
      label: "Security",
      purpose:
        "reviews security-sensitive work - authentication, authorization, user isolation, secrets, " +
        "injection, IDOR, unsafe defaults, trust boundaries and data leaving the system",
      instructions:
        "You are a security reviewer for a codebase another agent is changing.\n\n" +
        "Look for missing or weakened authentication and authorization, one user reaching another " +
        "user's data, identifiers that can be enumerated, secrets in code or in logs, values " +
        "spliced into shell commands or queries, defaults that fail open, trust placed in input " +
        "from a sandbox or a client, and data sent somewhere it should not go.\n\n" +
        "Required state must fail closed. A missing credential, owner or limit that is quietly " +
        "substituted with a default is a finding.\n\n" +
        "Read the code before you judge it, and cite the file for every finding. Reserve a blocking " +
        "verdict for something genuinely exploitable or for a real weakening of an existing " +
        "boundary - not for defence in depth you would like to see added. Say so plainly when you " +
        "find nothing: an invented finding costs the user a fix they did not need.",
      parallelSafe: true,
      validation: false,
    },
    {
      key: "testing",
      label: "Testing",
      purpose:
        "runs the project's own validation - typecheck, tests and lint - and judges whether it " +
        "actually proves the change works, worth its cost when correctness matters and cheap to " +
        "check yourself is not enough",
      instructions:
        "You are a validation reviewer for a codebase another agent is changing.\n\n" +
        "You cannot edit the project and you cannot run arbitrary commands. You have one way to " +
        "exercise it: run_validation, which runs the project's own trusted checks by name - " +
        "\"typecheck\", \"test\" and \"lint\". Read the code first to decide which checks are worth " +
        "running and what a passing result would actually prove; a green test that never touches " +
        "the changed behaviour is not evidence.\n\n" +
        "Each validation runs the project's real code in the sandbox and then restores the " +
        "workspace, so your runs never change the project. If a run reports that validation " +
        "modified the workspace, treat that as a finding in its own right - a check that rewrites " +
        "the tree it is meant to inspect is not safe to rely on.\n\n" +
        "Cite the exact command and its result for every finding. Reserve a blocking verdict for " +
        "validation that actually fails or that proves the requested behaviour is broken or " +
        "unproven - not for a check you would have liked to see added. Say so plainly when the " +
        "project validates cleanly.",
      parallelSafe: false,
      validation: true,
    },
  ],
  sandboxProviders: [
    {
      platform: "mobile",
      provider: "e2b",
      template: "base",
      timeoutSeconds: 1800,
      memoryMb: 2048,
      cpus: 2,
      concurrencyMeterKey: "sandbox.concurrent.mobile",
      workdir: "/home/user/project",
      idleGraceSeconds: 300,
      // Expo/jest-expo, run in non-mutating modes: tsc emits nothing, jest --ci
      // fails rather than writing new snapshots, eslint reports without --fix.
      // These still execute the project's own code; the tool checkpoints and
      // restores the workspace around every run, which is the actual safety.
      validationProfiles: {
        typecheck: "npx --no-install tsc --noEmit",
        test: "npx --no-install jest --ci",
        lint: "npx --no-install eslint .",
      },
      agentInstructions: "This is an Expo (React Native) project. A blank Expo app with web support is already installed at the project root \u2014 edit it rather than scaffolding a new one, and do not run create-expo-app.\n\nWrite screens in App.js (or App.tsx) and files it imports. Use React Native components \u2014 View, Text, Pressable, FlatList, StyleSheet \u2014 never HTML elements like div or span, which do not exist here.\n\nTo show the user their app, run start_preview with:\n  command: npx expo start --web --port 8081 --host 0.0.0.0\n  port: 8081\n\nThat serves the app through react-native-web, which is what the user sees in the preview. The same server also hosts the Expo Go manifest, so one command covers both the browser preview and the QR code for a real phone \u2014 do not start a second server for it.\n\nOnly add a dependency if the app genuinely needs it: installing packages on this sandbox is slow, and every one is time the user spends watching a spinner.",
    },
    {
      platform: "web",
      provider: "e2b",
      template: "base",
      timeoutSeconds: 1800,
      memoryMb: 2048,
      cpus: 2,
      concurrencyMeterKey: "sandbox.concurrent.web",
      workdir: "/home/user/project",
      idleGraceSeconds: 300,
      // Vite/React/TS with Vitest, run in non-mutating modes: tsc emits nothing,
      // vitest run is single-shot (no watch, no snapshot writes), eslint reports
      // without --fix. The project's own code still runs; the tool checkpoints
      // and restores the workspace around every run, which is the actual safety.
      validationProfiles: {
        typecheck: "npx --no-install tsc --noEmit",
        test: "npx --no-install vitest run",
        lint: "npx --no-install eslint .",
      },
      agentInstructions: "This is a web project. Scaffold with Vite unless the user asks for something else, and prefer React with TypeScript.\n\nTo show the user their app, run start_preview with the dev server command and its port, for example:\n  command: npm run dev -- --host 0.0.0.0 --port 5173\n  port: 5173\n\nThe --host flag is required. A dev server bound only to localhost cannot be reached from outside the sandbox, so the preview will time out even though the server is running.",
    },
  ],
} as const;

export const planDocuments = [
  {
    key: "free",
    sandboxNetwork: planNetworkPolicies.free,
    name: "Free",
    status: "ACTIVE",
    rank: 0,
    entitlements: [
      { capabilityKey: "ai.run", value: {"kind": "boolean", "value": true} },
      // Haiku only. The free tier is the one place usage is unbounded by
      // revenue, and an Opus turn costs five times the input and five times the
      // output of a Haiku one — a maxed-out free account on Opus is $2.25 that
      // nobody pays. Model access is the upgrade lever, not a giveaway.
      { capabilityKey: "ai.model.allowlist", value: {"kind": "stringList", "value": ["claude-haiku-4-5"]} },
      { capabilityKey: "ai.effort", value: {"kind": "string", "value": "low"} },
      { capabilityKey: "platform.web", value: {"kind": "boolean", "value": true} },
      { capabilityKey: "platform.mobile", value: {"kind": "boolean", "value": false} },
      { capabilityKey: "projects.max", value: {"kind": "number", "value": 3} },
      { capabilityKey: "skills.max", value: {"kind": "number", "value": 10} },
      { capabilityKey: "git.persistence", value: {"kind": "boolean", "value": false} },
      { capabilityKey: "preview.live", value: {"kind": "boolean", "value": true} },
    ],
    meterLimits: [
      { meterKey: "ai.tokens.output", includedAllowance: 30000, hardLimit: 30000, overageEnabled: false },
      { meterKey: "sandbox.seconds", includedAllowance: 3600, hardLimit: 3600, overageEnabled: false },
      { meterKey: "sandbox.concurrent.mobile", includedAllowance: 0, hardLimit: 0, overageEnabled: false },
      { meterKey: "sandbox.concurrent.web", includedAllowance: 1, hardLimit: 1, overageEnabled: false },
      { meterKey: "builds.started", includedAllowance: 10, hardLimit: 10, overageEnabled: false },
      { meterKey: "storage.bytes", includedAllowance: 104857600, hardLimit: 104857600, overageEnabled: false },
      { meterKey: "ai.tokens.input", includedAllowance: 300000, hardLimit: 300000, overageEnabled: false },
    ],
    rateLimits: [
      { routeClass: "read", maxRequests: 120, windowSeconds: 60 },
      { routeClass: "write", maxRequests: 20, windowSeconds: 60 },
      { routeClass: "build", maxRequests: 3, windowSeconds: 60 },
      { routeClass: "stream", maxRequests: 20, windowSeconds: 60 },
    ],
  },
  {
    key: "pro",
    sandboxNetwork: planNetworkPolicies.pro,
    name: "Pro",
    // £24.00. Stripe publishes this on demand; nothing is pasted from a dashboard.
    price: { amountMinor: 2400, currency: "gbp", interval: "month" },
    status: "ACTIVE",
    rank: 1,
    entitlements: [
      { capabilityKey: "ai.run", value: {"kind": "boolean", "value": true} },
      { capabilityKey: "ai.model.allowlist", value: {"kind": "stringList", "value": ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"]} },
      { capabilityKey: "ai.effort", value: {"kind": "string", "value": "high"} },
      { capabilityKey: "platform.web", value: {"kind": "boolean", "value": true} },
      { capabilityKey: "platform.mobile", value: {"kind": "boolean", "value": true} },
      { capabilityKey: "projects.max", value: {"kind": "number", "value": 25} },
      { capabilityKey: "skills.max", value: {"kind": "number", "value": 50} },
      { capabilityKey: "git.persistence", value: {"kind": "boolean", "value": true} },
      { capabilityKey: "preview.live", value: {"kind": "boolean", "value": true} },
    ],
    meterLimits: [
      { meterKey: "ai.tokens.input", includedAllowance: 1200000, hardLimit: 2000000, overageEnabled: true },
      { meterKey: "ai.tokens.output", includedAllowance: 200000, hardLimit: 400000, overageEnabled: true },
      { meterKey: "sandbox.seconds", includedAllowance: 36000, hardLimit: 72000, overageEnabled: true },
      { meterKey: "sandbox.concurrent.mobile", includedAllowance: 1, hardLimit: 1, overageEnabled: false },
      { meterKey: "sandbox.concurrent.web", includedAllowance: 3, hardLimit: 3, overageEnabled: false },
      { meterKey: "builds.started", includedAllowance: 200, hardLimit: 400, overageEnabled: true },
      { meterKey: "storage.bytes", includedAllowance: 5368709120, hardLimit: 5368709120, overageEnabled: false },
    ],
    rateLimits: [
      { routeClass: "read", maxRequests: 300, windowSeconds: 60 },
      { routeClass: "write", maxRequests: 60, windowSeconds: 60 },
      { routeClass: "build", maxRequests: 10, windowSeconds: 60 },
      { routeClass: "stream", maxRequests: 60, windowSeconds: 60 },
    ],
  },
  {
    key: "business",
    // Operator-approved exact domains belong here. Empty deliberately denies
    // outbound internet until the business policy has been configured.
    sandboxNetwork: planNetworkPolicies.business,
    name: "Business",
    // £72.00.
    price: { amountMinor: 7200, currency: "gbp", interval: "month" },
    status: "ACTIVE",
    rank: 2,
    entitlements: [
      { capabilityKey: "ai.effort", value: {"kind": "string", "value": "xhigh"} },
      { capabilityKey: "platform.web", value: {"kind": "boolean", "value": true} },
      { capabilityKey: "platform.mobile", value: {"kind": "boolean", "value": true} },
      { capabilityKey: "projects.max", value: {"kind": "number", "value": 100} },
      { capabilityKey: "skills.max", value: {"kind": "number", "value": 200} },
      { capabilityKey: "git.persistence", value: {"kind": "boolean", "value": true} },
      { capabilityKey: "preview.live", value: {"kind": "boolean", "value": true} },
      { capabilityKey: "ai.run", value: {"kind": "boolean", "value": true} },
      { capabilityKey: "ai.model.allowlist", value: {"kind": "stringList", "value": ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"]} },
    ],
    meterLimits: [
      { meterKey: "ai.tokens.input", includedAllowance: 3000000, hardLimit: 6000000, overageEnabled: true },
      { meterKey: "ai.tokens.output", includedAllowance: 500000, hardLimit: 1000000, overageEnabled: true },
      { meterKey: "sandbox.seconds", includedAllowance: 108000, hardLimit: 216000, overageEnabled: true },
      { meterKey: "sandbox.concurrent.mobile", includedAllowance: 2, hardLimit: 2, overageEnabled: false },
      { meterKey: "sandbox.concurrent.web", includedAllowance: 10, hardLimit: 10, overageEnabled: false },
      { meterKey: "builds.started", includedAllowance: 1000, hardLimit: 2000, overageEnabled: true },
      { meterKey: "storage.bytes", includedAllowance: 26843545600, hardLimit: 26843545600, overageEnabled: false },
    ],
    rateLimits: [
      { routeClass: "read", maxRequests: 600, windowSeconds: 60 },
      { routeClass: "write", maxRequests: 120, windowSeconds: 60 },
      { routeClass: "build", maxRequests: 30, windowSeconds: 60 },
      { routeClass: "stream", maxRequests: 120, windowSeconds: 60 },
    ],
  },
] as const;

