// Bündelt das Spiel in einen Ordner, der im Browser und in der Android-App läuft.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDirs = [join(root, 'dist'), join(root, 'android/app/src/main/assets/www')];
const watch = process.argv.includes('--watch');

function copyStatic() {
  for (const d of outDirs) {
    mkdirSync(d, { recursive: true });
    cpSync(join(root, 'web'), d, { recursive: true });
  }
}

const opts = {
  entryPoints: [join(root, 'src/main.ts')],
  bundle: true,
  format: 'iife',
  target: ['chrome90', 'safari15'],
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
  write: false,
};

async function buildOnce() {
  const res = await esbuild.build(opts);
  copyStatic();
  const { writeFileSync } = await import('node:fs');
  for (const d of outDirs) writeFileSync(join(d, 'game.js'), res.outputFiles[0].contents);
}

if (watch) {
  const ctx = await esbuild.context({
    ...opts,
    plugins: [
      {
        name: 'copy',
        setup(b) {
          b.onEnd(async (r) => {
            if (r.errors.length) return;
            copyStatic();
            const { writeFileSync } = await import('node:fs');
            for (const d of outDirs) writeFileSync(join(d, 'game.js'), r.outputFiles[0].contents);
          });
        },
      },
    ],
  });
  await ctx.watch();
} else {
  await buildOnce();
}
