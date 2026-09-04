#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const child = spawn(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'src/cli.ts'), ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (c) => process.exit(c ?? 1));
