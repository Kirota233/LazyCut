import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

for (const file of [
  'app/dist/client/index.html',
  'app/dist/client/assets/webview2-bridge.js',
  '.generated/native/helpers/PeriodKeeper.exe',
  'app/build/jianying/JianYingEngine.exe',
  'app/build/jianying/engine.json',
  'app/build/watermark/WatermarkEngine.exe',
  'app/build/watermark/engine.json',
  'app/build/host/LazyCut.exe',
  'app/lib/webview2/Microsoft.Web.WebView2.Core.dll',
  'app/lib/webview2/Microsoft.Web.WebView2.WinForms.dll',
  'app/lib/webview2/WebView2Loader.dll',
]) {
  await fs.access(file);
}

const outDir = path.join(root, 'artifacts', 'LazyCut-win32-x64');
await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
await fs.mkdir(path.join(outDir, 'resources', 'client'), { recursive: true });
await fs.mkdir(path.join(outDir, 'resources', 'helpers'), { recursive: true });
await fs.mkdir(path.join(outDir, 'resources', 'jianying'), { recursive: true });
await fs.mkdir(path.join(outDir, 'resources', 'watermark'), { recursive: true });

// 1. Copy Native C# + WebView2 Host (~56 KB) and WebView2 Loader DLLs (~790 KB total, zero bundled Chromium kernel!)
await fs.copyFile('app/build/host/LazyCut.exe', path.join(outDir, 'LazyCut.exe'));
for (const dll of ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll']) {
  await fs.copyFile(path.join('app/lib/webview2', dll), path.join(outDir, dll));
}
await fs.copyFile('app/assets/app-icon.ico', path.join(outDir, 'app-icon.ico'));
await fs.copyFile('app/THIRD_PARTY_NOTICES.txt', path.join(outDir, 'THIRD_PARTY_NOTICES.txt'));

// 2. Copy frontend client assets (prune unreferenced decorative PNGs)
await fs.cp('app/dist/client', path.join(outDir, 'resources', 'client'), { recursive: true });
for (const unusedAsset of ['provider-portal-scene.png', 'signal-ribbon.png']) {
  await fs.rm(path.join(outDir, 'resources', 'client', 'assets', unusedAsset), { force: true }).catch(() => {});
}

// 3. Copy native C# engines (PeriodKeeper 15KB, JianYingEngine 48KB, WatermarkEngine 24KB + watermark.png 21KB)
await fs.copyFile('.generated/native/helpers/PeriodKeeper.exe', path.join(outDir, 'resources', 'helpers', 'PeriodKeeper.exe'));
await fs.cp('app/build/jianying', path.join(outDir, 'resources', 'jianying'), { recursive: true });
await fs.cp('app/build/watermark', path.join(outDir, 'resources', 'watermark'), { recursive: true });

console.log(outDir);
