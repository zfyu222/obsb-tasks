// Export only this plugin, never the framework/vault, to its dedicated BRAT repository.
import { cp, mkdir, readFile, readdir, lstat, writeFile, unlink } from 'node:fs/promises';
import { resolve, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw Error('Usage: node scripts/export-release.mjs ABSOLUTE_TARGET');
const target = resolve(process.argv[2]);
if (target === source || !relative(source, target).startsWith('..' + sep) || !relative(target, source).startsWith('..' + sep)) throw Error('Export directory must be separate from plugin source');
const roots = ['manifest.json', 'versions.json', 'package.json', 'package-lock.json', 'tsconfig.json', 'styles.css', 'README.md', 'release-notes.md', '.gitignore', 'src', 'tests', 'scripts', '.github'];
const owned = path => typeof path === 'string' && !path.includes('\\') && !path.startsWith('/') && !path.split('/').includes('..') && roots.some(root => path === root || path.startsWith(root + '/'));
await mkdir(target, { recursive: true });
if ((await lstat(target)).isSymbolicLink()) throw Error('Target must not be a symlink');
const marker = '.obsb-release-mirror.json';
let previous;
try { previous = JSON.parse(await readFile(resolve(target, marker), 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
if (previous) {
  if (previous.plugin !== 'obsb-tasks' || !Array.isArray(previous.files) || !previous.files.every(owned)) throw Error('Invalid mirror ownership marker');
  const status = execFileSync('git', ['-C', target, 'status', '--porcelain'], { encoding: 'utf8' });
  if (status.trim()) throw Error('Release mirror has local changes; commit or preserve them before exporting');
} else {
  if ((await readdir(target)).length) throw Error('First export requires an empty directory');
}
const files = [];
async function collect(path) {
  const stat = await lstat(resolve(source, path));
  if (stat.isSymbolicLink()) throw Error('Source symlinks are not exported');
  if (stat.isDirectory()) for (const name of await readdir(resolve(source, path))) await collect(`${path}/${name}`);
  else files.push(path);
}
for (const root of roots) await collect(root);
async function safeTarget(path) {
  const parts = path.split('/'); let cursor = target;
  for (const part of parts.slice(0, -1)) {
    cursor = resolve(cursor, part);
    try { if ((await lstat(cursor)).isSymbolicLink()) throw Error('Target contains a symlink'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const result = resolve(target, path);
  try { if ((await lstat(result)).isSymbolicLink()) throw Error('Target file is a symlink'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  return result;
}
for (const path of previous?.files ?? []) if (!files.includes(path)) {
  const destination = await safeTarget(path);
  // Remove only explicitly owned obsolete files, never directories or arbitrary repository content.
  try { await unlink(destination); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
for (const path of files) {
  const destination = await safeTarget(path); await mkdir(dirname(destination), { recursive: true });
  await cp(resolve(source, path), destination);
}
await writeFile(resolve(target, marker), JSON.stringify({ plugin: 'obsb-tasks', files: files.sort() }, null, 2) + '\n');
console.log(`Exported ${files.length} plugin files to ${target}`);
