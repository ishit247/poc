// What the console flags from a tenant's health counts. Pure, so the rules are testable without a database.
export interface HealthRow {
  devicesStale: number;
  devicesUnsynced: number;
  syncRejected24h: number;
  onlineOutboxFailed: number;
  onlineOutboxPending: number;
  integrationsQuiet: number;
  webhookRejected24h: number;
  appVersions: Record<string, number>;
}

export type Warning = { code: string; severity: 'warn' | 'alert'; message: string };

export function healthWarnings(h: HealthRow, staleHours: number, quietHours: number): Warning[] {
  const w: Warning[] = [];
  const add = (code: string, severity: Warning['severity'], message: string) => w.push({ code, severity, message });
  if (h.devicesStale > 0) add('device-stale', 'alert', `${h.devicesStale} device(s) not heard from in ${staleHours} h`);
  if (h.devicesUnsynced > 0) add('device-unsynced', 'warn', `${h.devicesUnsynced} device(s) hold unsynced events`);
  if (h.syncRejected24h > 0) add('sync-rejected', 'alert', `${h.syncRejected24h} sync event(s) rejected in 24 h`);
  if (h.onlineOutboxFailed > 0) add('outbox-failed', 'alert', `${h.onlineOutboxFailed} platform message(s) failed for good`);
  if (h.onlineOutboxPending > 0) add('outbox-backlog', 'warn', `${h.onlineOutboxPending} platform message(s) waiting to send`);
  if (h.integrationsQuiet > 0) add('integration-quiet', 'warn', `${h.integrationsQuiet} integration(s) silent for ${quietHours} h`);
  if (h.webhookRejected24h > 0) add('webhook-rejected', 'warn', `${h.webhookRejected24h} webhook(s) rejected in 24 h`);
  const versions = Object.keys(h.appVersions).filter((v) => v !== 'unknown');
  if (versions.length > 1) add('version-skew', 'warn', `devices run ${versions.length} app versions: ${versions.sort().join(', ')}`);
  return w;
}
