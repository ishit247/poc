import { buildApp } from './app.js';
import { startExpiryJob } from './jobs/expireOnline.js';
import { startOutboxJob } from './jobs/outbox.js';

const app = buildApp();
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
startExpiryJob();
startOutboxJob();
