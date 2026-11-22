// Builds and publishes dist/ to the gh-pages branch of the origin remote.
import {execSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const dist = path.join(root, 'dist');
const run = (cmd, cwd = root) => execSync(cmd, {cwd, stdio: 'inherit'});
const out = (cmd) => execSync(cmd, {cwd: root}).toString().trim();

run('node build.mjs');
fs.writeFileSync(path.join(dist, '.nojekyll'), '');

const remote = out('git remote get-url origin');
fs.rmSync(path.join(dist, '.git'), {recursive: true, force: true});
run('git init -q -b gh-pages', dist);
run('git add -A', dist);
run('git -c core.autocrlf=false commit -q -m "Deploy"', dist);
run(`git push -f "${remote}" gh-pages`, dist);
fs.rmSync(path.join(dist, '.git'), {recursive: true, force: true});
console.log('Deployed to gh-pages'); // eslint-disable-line no-console
