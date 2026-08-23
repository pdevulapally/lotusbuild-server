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
  sandboxProviders: [
    {
      platform: "mobile",
      provider: "vps",
      template: "lotusbuild-expo:2",
      timeoutSeconds: 1800,
      memoryMb: 1536,
      cpus: 1,
      concurrencyMeterKey: "sandbox.concurrent.mobile",
      workdir: "/workspace",
      idleGraceSeconds: 300,
      agentInstructions: "This is an Expo (React Native) project. A blank Expo app with web support is already installed at the project root \u2014 edit it rather than scaffolding a new one, and do not run create-expo-app.\n\nWrite screens in App.js (or App.tsx) and files it imports. Use React Native components \u2014 View, Text, Pressable, FlatList, StyleSheet \u2014 never HTML elements like div or span, which do not exist here.\n\nTo show the user their app, run start_preview with:\n  command: npx expo start --web --port 8081 --host lan\n  port: 8081\n\nThat serves the app through react-native-web, which is what the user sees in the preview. The same server also hosts the Expo Go manifest, so one command covers both the browser preview and the QR code for a real phone \u2014 do not start a second server for it.\n\nOnly add a dependency if the app genuinely needs it: installing packages on this sandbox is slow, and every one is time the user spends watching a spinner.",
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
      agentInstructions: "This is a web project. Scaffold with Vite unless the user asks for something else, and prefer React with TypeScript.\n\nTo show the user their app, run start_preview with the dev server command and its port, for example:\n  command: npm run dev -- --host 0.0.0.0 --port 5173\n  port: 5173\n\nThe --host flag is required. A dev server bound only to localhost cannot be reached from outside the sandbox, so the preview will time out even though the server is running.",
    },
  ],
} as const;

export const planDocuments = [
  {
    key: "free",
    name: "Free",
    status: "ACTIVE",
    rank: 0,
    entitlements: [
      { capabilityKey: "ai.run", value: {"kind": "boolean", "value": true} },
      { capabilityKey: "ai.model.allowlist", value: {"kind": "stringList", "value": ["claude-opus-5"]} },
      { capabilityKey: "ai.effort", value: {"kind": "string", "value": "low"} },
      { capabilityKey: "platform.web", value: {"kind": "boolean", "value": true} },
      { capabilityKey: "platform.mobile", value: {"kind": "boolean", "value": false} },
      { capabilityKey: "projects.max", value: {"kind": "number", "value": 3} },
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
    name: "Pro",
    status: "ACTIVE",
    rank: 1,
    entitlements: [
      { capabilityKey: "ai.run", value: {"kind": "boolean", "value": true} },
      { capabilityKey: "ai.model.allowlist", value: {"kind": "stringList", "value": ["claude-opus-5"]} },
      { capabilityKey: "ai.effort", value: {"kind": "string", "value": "high"} },
      { capabilityKey: "platform.web", value: {"kind": "boolean", "value": true} },
      { capabilityKey: "platform.mobile", value: {"kind": "boolean", "value": true} },
      { capabilityKey: "projects.max", value: {"kind": "number", "value": 25} },
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
    name: "Business",
    status: "ACTIVE",
    rank: 2,
    entitlements: [
      { capabilityKey: "ai.effort", value: {"kind": "string", "value": "xhigh"} },
      { capabilityKey: "platform.web", value: {"kind": "boolean", "value": true} },
      { capabilityKey: "platform.mobile", value: {"kind": "boolean", "value": true} },
      { capabilityKey: "projects.max", value: {"kind": "number", "value": 100} },
      { capabilityKey: "git.persistence", value: {"kind": "boolean", "value": true} },
      { capabilityKey: "preview.live", value: {"kind": "boolean", "value": true} },
      { capabilityKey: "ai.run", value: {"kind": "boolean", "value": true} },
      { capabilityKey: "ai.model.allowlist", value: {"kind": "stringList", "value": ["claude-opus-5"]} },
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
