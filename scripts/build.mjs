import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const versions = JSON.parse(await readFile('versions.json', 'utf8'));
if (manifest.id !== 'obsb-tasks' || manifest.version !== pkg.version || versions[manifest.version] !== manifest.minAppVersion) {
  throw new Error('manifest, package and versions must match before releasing');
}
const out = 'dist/obsb-tasks';
const license = (await readFile('src/vendor/enhancing-mindmap/LICENSE.md', 'utf8')).replace(/\r\n/g, '\n');
await mkdir(out, { recursive: true });
await build({ entryPoints: ['src/main.ts'], outfile: `${out}/main.js`, bundle: true,
  external: ['obsidian'], format: 'cjs', platform: 'browser', target: 'es2020',
  banner: { js: '/*!\nIncludes code extracted from obsidian-enhancing-mindmap beta.41 (7c39cf6).\n' + license.trim() + '\n*/' } });
for (const name of ['manifest.json', 'styles.css']) await writeFile(`${out}/${name}`, (await readFile(name, 'utf8')).replace(/\r\n/g, '\n'));
console.log(`Built ${out}`);
