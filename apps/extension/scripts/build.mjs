import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderIconPng } from './generate-icon.mjs';

const watch = process.argv.includes('--watch');
const outDir = path.join(import.meta.dirname, '..', 'dist');

const staticFiles = ['manifest.json', 'popup.html', 'popup.css'];

function copyStatic() {
  for (const file of staticFiles) {
    fs.copyFileSync(
      path.join(import.meta.dirname, '..', 'public', file),
      path.join(outDir, file),
    );
  }
  const iconsDir = path.join(outDir, 'icons');
  fs.mkdirSync(iconsDir, { recursive: true });
  fs.writeFileSync(path.join(iconsDir, 'icon48.png'), renderIconPng(48));
}

const buildOptions = {
  entryPoints: {
    'background/service-worker': path.join(import.meta.dirname, '..', 'src/background/service-worker.ts'),
    'content/content-script': path.join(import.meta.dirname, '..', 'src/content/content-script.ts'),
    'popup/popup': path.join(import.meta.dirname, '..', 'src/popup/popup.ts'),
  },
  bundle: true,
  outdir: outDir,
  format: 'esm',
  target: 'chrome120',
  sourcemap: true,
  logLevel: 'info',
  define: {
    'import.meta.env.DASHBOARD_BASE': JSON.stringify(
      process.env.DASHBOARD_BASE ?? 'http://localhost:5173/scans/',
    ),
  },
};

async function build() {
  fs.mkdirSync(outDir, { recursive: true });
  copyStatic();

  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('Watching extension files...');
  } else {
    await esbuild.build(buildOptions);
    console.log('Extension built to dist/');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
