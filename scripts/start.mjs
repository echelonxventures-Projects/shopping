#!/usr/bin/env node
// ONE-CLICK INSTALL + RUN — the entire platform, zero manual steps.
//   npm start
// Behavior: verifies Node >= 20 (26 for native TS), installs dependencies if
// missing, boots all modules, mounts the model-driven HTTP gateway, seeds a
// shoppable catalog, and prints the testing card (URL + credentials).
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  console.error('✖ Node >= 20 required (26 recommended for native TS). You have ' + process.versions.node);
  process.exit(1);
}
console.log('✔ Node ' + process.versions.node);

if (!existsSync(root + 'node_modules')) {
  console.log('📦 installing dependencies (one time)…');
  execSync('npm install --no-audit --no-fund', { cwd: root, stdio: 'inherit' });
}
console.log('🚀 starting AetherCommerce…\n');
const child = spawn(process.execPath, [root + 'scripts/serve.ts'], { cwd: root, stdio: 'inherit' });
child.on('close', (code) => process.exit(code ?? 0));
