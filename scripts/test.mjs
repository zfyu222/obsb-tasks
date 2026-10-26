import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
await build({ entryPoints: ['src/model.ts', 'src/codec.ts', 'src/store.ts'], outdir: '.test-build', bundle: true,
  platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' } });
await build({ entryPoints: ['tests/view-entry.mjs'], outfile: '.test-build/view.mjs', bundle: true,
  platform: 'node', format: 'esm', alias: { obsidian: './tests/obsidian-mock.mjs' } });
const result = spawnSync(process.execPath, ['--test', 'tests/model.test.mjs', 'tests/store.test.mjs', 'tests/view.test.mjs'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
