// Stops the Docker environment. Data is kept (the volume survives). Pass --volumes to destroy it as well.
import { execFileSync } from 'node:child_process';

execFileSync('docker', ['compose', '--profile', 'seed', 'down', ...(process.argv.includes('--volumes') ? ['-v'] : [])], { stdio: 'inherit' });
