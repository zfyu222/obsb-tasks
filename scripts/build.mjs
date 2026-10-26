import { build } from 'esbuild';
import { mkdir, copyFile, readFile } from 'node:fs/promises';
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const versions = JSON.parse(await readFile('versions.json', 'utf8'));
if (manifest.id !== 'obsb-tasks' || manifest.version !== pkg.version || versions[manifest.version] !== manifest.minAppVersion) {
  throw new Error('manifest, package and versions must match before releasing');
}
const out = 'dist/obsb-tasks';
await mkdir(out, { recursive: true });
await build({ entryPoints: ['src/main.ts'], outfile: `${out}/main.js`, bundle: true,
  external: ['obsidian'], format: 'cjs', platform: 'browser', target: 'es2020' });
for (const name of ['manifest.json', 'styles.css']) await copyFile(name, `${out}/${name}`);
console.log(`Built ${out}`);
