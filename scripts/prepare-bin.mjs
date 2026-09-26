import {chmod} from 'node:fs/promises';
await chmod(new URL('../dist/muster.js',import.meta.url),0o755);
