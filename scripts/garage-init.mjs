// One-time setup of the Garage object store: assign the single node to a layout, create the bucket, import the dev
// S3 key and allow it on the bucket. Safe to run again (it stops at once if the bucket exists). Garage ships as a
// single static binary with no shell, so everything goes through `docker compose exec garage /garage ...`.
// DEV key pair: public in the repository, must match docker-compose.yml. Replace both before real use.
import { execFileSync } from 'node:child_process';

const BUCKET = process.env.S3_BUCKET ?? 'pos-images';
const KEY_NAME = 'pos-api';
const KEY_ID = process.env.S3_ACCESS_KEY_ID ?? 'GK000000000000000000000001';
const KEY_SECRET = process.env.S3_SECRET_ACCESS_KEY ?? '0'.repeat(63) + '1';

const garage = (...args) => execFileSync('docker', ['compose', 'exec', '-T', 'garage', '/garage', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tryGarage = (...args) => { try { return garage(...args); } catch { return null; } };

if (tryGarage('bucket', 'info', BUCKET)) {
  console.log(`garage: bucket ${BUCKET} already set up`);
  process.exit(0);
}

const nodeId = /^([0-9a-f]{16})\b/m.exec(garage('status').split('==== HEALTHY NODES ====')[1] ?? garage('status'))?.[1];
if (!nodeId) throw new Error('garage: could not read the node id from `garage status`');

// A fresh single node has no layout yet; a node that already has one just skips these two.
if (!tryGarage('layout', 'show')?.includes(nodeId) || /No nodes/i.test(tryGarage('layout', 'show') ?? '')) {
  garage('layout', 'assign', '-z', 'dc1', '-c', '10G', nodeId);
  garage('layout', 'apply', '--version', '1');
}
garage('bucket', 'create', BUCKET);
garage('key', 'import', '--yes', '-n', KEY_NAME, KEY_ID, KEY_SECRET);
garage('bucket', 'allow', '--read', '--write', '--owner', BUCKET, '--key', KEY_NAME);
console.log(`garage: bucket ${BUCKET} ready, key ${KEY_ID} allowed`);
