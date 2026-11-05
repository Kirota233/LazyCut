import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
if (process.platform !== 'win32') throw new Error('Desktop host requires Windows x64.');
await import('./package.mjs');
const exe = path.join(root, 'artifacts', 'LazyCut-win32-x64', 'LazyCut.exe');
await fs.access(exe);
const child = spawn(exe, [], { stdio: 'inherit', windowsHide: false });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
