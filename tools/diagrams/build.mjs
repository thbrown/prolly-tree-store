/**
 * Render the README animations.
 *
 *   npm run build && node tools/diagrams/build.mjs
 *
 * Requires ffmpeg on PATH and @napi-rs/canvas installed (dev-only, not a
 * dependency of the library).
 */
import { renderGif } from './lib.mjs';
import { scenes } from './scenes.mjs';
import { stats } from './measure.mjs';
import { statSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outDir = new URL('../../docs/images/', import.meta.url).pathname;
const tmpRoot = mkdtempSync(join(tmpdir(), 'prolly-diagrams-'));

const only = process.argv.slice(2);

for (const scene of scenes) {
  if (only.length > 0 && !only.includes(scene.name)) continue;
  const steps = scene.build(stats);
  const seconds = steps.reduce((sum, s) => sum + s.seconds, 0);
  const { out, frames } = await renderGif({
    name: scene.name, title: scene.title, steps, outDir, tmpRoot,
  });
  const kb = Math.round(statSync(out).size / 1024);
  console.log(`${scene.name.padEnd(12)} ${String(frames).padStart(4)} frames  ${seconds.toFixed(1)}s  ${kb} KB`);
}
