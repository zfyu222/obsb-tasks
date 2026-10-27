import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir('.test-build', { recursive: true });
await build({ entryPoints: ['tests/browser-entry.mjs'], outfile: '.test-build/browser-host.js', bundle: true, format: 'esm', platform: 'browser' });
const bundle = await readFile('dist/obsb-tasks/main.js', 'utf8');
await writeFile('.test-build/production.html', `<!doctype html><meta charset="utf-8"><title>OBSB Tasks · production bundle fixture</title><link rel="stylesheet" href="../styles.css"><style>
:root{--interactive-accent:#6274da;--text-on-accent:white;--text-muted:#777f8a;--text-faint:#acb6c7;--text-error:#c44;--background-primary:#fff;--background-secondary:#f3f5fa;--background-modifier-border:#dce1ea;--font-smallest:12px;--font-monospace:monospace}*{box-sizing:border-box}html,body{height:100%;margin:0;font:14px system-ui;color:#253045}button,input,select,textarea{font:inherit;border:1px solid #dce1ea;border-radius:6px;padding:6px 9px;background:white;color:inherit}button{cursor:pointer}button:hover{background:#edf0fa}.obsb-tasks{height:100vh}
</style><body><script>window.releaseBundle=${JSON.stringify(bundle).replace(/</g, '\\u003c')};</script><script type="module" src="browser-host.js"></script></body>`);
console.log('Prepared .test-build/production.html using the exact release main.js');
