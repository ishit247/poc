import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import './scope.js';
import { registerAuth } from './auth.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { brandingRoutes } from './routes/branding.js';
import { healthRoutes } from './routes/health.js';
import { counterRoutes } from './routes/counters.js';
import { dayCloseRoutes } from './routes/dayclose.js';
import { menuRoutes } from './routes/menu.js';
import { onlineRoutes } from './routes/online.js';
import { webhookRoutes } from './routes/webhooks.js';
import { orderRoutes } from './routes/orders.js';
import { outletRoutes } from './routes/outlets.js';
import { settingsRoutes } from './routes/settings.js';
import { settlementRoutes } from './routes/settlement.js';
import { reportRoutes } from './routes/reports.js';
import { syncRoutes } from './routes/sync.js';
import { platformRoutes } from './routes/platform.js';

export function buildApp() {
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    // Set TRUST_PROXY only when behind a proxy you control; otherwise rate limits key on a spoofable header.
    trustProxy: process.env.TRUST_PROXY === '1',
  });

  // Fails at startup (and in tests) if any route lacks a scope declaration, or a
  // non-public route lacks a permission.
  app.addHook('onRoute', (route) => {
    const cfg = route.config;
    if (!cfg?.scope) throw new Error(`route ${route.method} ${route.url} has no config.scope declaration`);
    if (cfg.scope !== 'public' && !cfg.permission) {
      throw new Error(`route ${route.method} ${route.url} has no config.permission declaration`);
    }
    // The console lives under /platform/ and nowhere else (the host restriction keys on the prefix), and
    // nothing under that prefix may be a tenant route.
    const url = String(route.url);
    if (cfg.scope === 'platform' && !url.startsWith('/platform/')) throw new Error(`route ${route.method} ${url} has scope platform outside /platform/`);
    if (url.startsWith('/platform/') && cfg.scope !== 'platform' && url !== '/platform/login') {
      throw new Error(`route ${route.method} ${url} is under /platform/ but is not scope platform`);
    }
  });

  app.setErrorHandler((err: { statusCode?: number }, _req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) console.error('SERVER ERROR', err); // logged here, never sent to the client
    // Never leak internals on a 5xx.
    reply.code(status).send({ error: status >= 500 ? 'internal error' : 'request failed' });
  });

  app.register(helmet);
  app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });
  registerAuth(app);
  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(menuRoutes);
  app.register(counterRoutes);
  app.register(orderRoutes);
  app.register(onlineRoutes);
  app.register(webhookRoutes);
  app.register(outletRoutes);
  app.register(settingsRoutes);
  app.register(brandingRoutes);
  app.register(adminRoutes);
  app.register(syncRoutes);
  app.register(dayCloseRoutes);
  app.register(settlementRoutes);
  app.register(reportRoutes);
  app.register(platformRoutes);
  return app;
}
