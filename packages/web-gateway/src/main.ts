// Entry point for the VM service: settings from the environment, one process, plain stdout logging.
import { configFromEnv } from './config.js';
import { createGateway } from './server.js';
import { GoogleDemoExecutor } from './google-demo-executor.js';

const config = configFromEnv();
const executor = config.googleDemo ? await GoogleDemoExecutor.create(config.googleDemo) : undefined;
if (executor) console.log(`Demo calendar executor: ${executor.calendar.label} (${executor.calendar.timeZone}), retention ${config.googleDemo!.cleanupMinutes} min`);
const gateway = createGateway({ ...config, ...(executor ? { executor } : {}) });
const address = await gateway.listen();
console.log(`Tanya public gateway listening on http://${address.host}:${address.port} (brain ${config.brainUrl}, static ${config.staticDir ?? 'none'})`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void gateway.close().then(() => process.exit(0)); });
}
