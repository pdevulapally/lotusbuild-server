import { EnvironmentError, loadConfig } from './config/index.ts';
import { buildServer } from './server.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = buildServer(config);

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((error: unknown) => {
  // Configuration problems are operator errors, not crashes: report them
  // legibly rather than as a stack trace nobody reads.
  if (error instanceof EnvironmentError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  }
  process.exit(1);
});
