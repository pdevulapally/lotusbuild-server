/**
 * Static catalogue of connectable services. Nothing here talks to a provider;
 * adapters (later slices) implement the behaviour for each key. A connector
 * listed as `configured: false` renders as "configuration required" until its
 * app credentials exist on the server.
 */
export const connectorKeys = ['netlify', 'vercel', 'slack', 'aws', 'mcp'] as const;
export type ConnectorKey = (typeof connectorKeys)[number];

/** How a user grants LotusBuild access. OAuth grants access; tools are a separate concern. */
export type ConnectorAuthKind = 'oauth2' | 'slack-install' | 'aws-role' | 'mcp-remote';

export const connectionStatuses = [
  'connecting', 'active', 'expired', 'revoked', 'insufficient_permissions', 'provider_unavailable', 'configuration_required',
] as const;
export type ConnectionStatus = (typeof connectionStatuses)[number];

export interface ConnectorCapability {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  /** Actions that change the outside world always go through a bound, single-use approval. */
  readonly requiresApproval: boolean;
}

export interface ConnectorDefinition {
  readonly key: ConnectorKey;
  readonly name: string;
  readonly summary: string;
  readonly auth: ConnectorAuthKind;
  readonly capabilities: readonly ConnectorCapability[];
  /** Limits the user should know before connecting. */
  readonly limits: readonly string[];
}

export const connectors: Readonly<Record<ConnectorKey, ConnectorDefinition>> = {
  netlify: {
    key: 'netlify', name: 'Netlify', auth: 'oauth2',
    summary: 'Deploy projects to sites in your Netlify account.',
    capabilities: [
      { key: 'sites.read', title: 'List sites', description: 'See the sites LotusBuild may deploy to.', requiresApproval: false },
      { key: 'deploy', title: 'Deploy a project', description: 'Publish a build to a site you choose, with your approval each time.', requiresApproval: true },
    ],
    limits: ['Deploys only to sites you grant to a project.'],
  },
  vercel: {
    key: 'vercel', name: 'Vercel', auth: 'oauth2',
    summary: 'Deploy projects to your Vercel account or team.',
    capabilities: [
      { key: 'projects.read', title: 'List projects', description: 'See the Vercel projects LotusBuild may deploy to.', requiresApproval: false },
      { key: 'deploy', title: 'Deploy a project', description: 'Create a deployment, with your approval each time.', requiresApproval: true },
    ],
    limits: ['Production promotions always ask first.'],
  },
  slack: {
    key: 'slack', name: 'Slack', auth: 'slack-install',
    summary: 'Let the agent post updates to channels in a workspace you choose.',
    capabilities: [
      { key: 'channels.read', title: 'List channels', description: 'See the public channels it may post to.', requiresApproval: false },
      { key: 'chat.post', title: 'Post a message', description: 'Send a message to a channel, with your approval each time.', requiresApproval: true },
    ],
    limits: ['Installs the LotusBuild app into one workspace with narrow scopes; signing in with Slack is not enough.'],
  },
  aws: {
    key: 'aws', name: 'AWS', auth: 'aws-role',
    summary: 'Publish static sites to an S3 bucket behind CloudFront in your AWS account.',
    capabilities: [
      { key: 'static.publish', title: 'Publish a static site', description: 'Upload a build to S3 and invalidate CloudFront, with your approval each time.', requiresApproval: true },
    ],
    limits: ['Static hosting only — not general-purpose AWS deployment.', 'Uses a cross-account IAM role with an external ID and temporary credentials; never root keys.'],
  },
  mcp: {
    key: 'mcp', name: 'Custom MCP server', auth: 'mcp-remote',
    summary: 'Connect a remote MCP server and choose which of its tools the agent may use.',
    capabilities: [
      { key: 'tools.discover', title: 'Discover tools', description: 'Read the tool list the server exposes.', requiresApproval: false },
      { key: 'tools.call', title: 'Call an enabled tool', description: 'Only tools you enable, each call approved when it can change something.', requiresApproval: true },
    ],
    limits: ['HTTPS only; private-network addresses are refused.', 'Not every MCP server supports OAuth — the server’s own method is used.'],
  },
};

export const isConnectorKey = (value: unknown): value is ConnectorKey =>
  typeof value === 'string' && (connectorKeys as readonly string[]).includes(value);
