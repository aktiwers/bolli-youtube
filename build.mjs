// Builds the app into apps/bolli-youtube: the TypeScript to ES5 (build/tsc), each entry as one script (rollup) with
// the version from appinfo.json, then compact: no comments or indentation, in plain ASCII (the TV holds such a script
// at one byte per character, else at two). Usage: npm run build
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import * as acorn from 'acorn';

const folder = 'apps/bolli-youtube';
const version = JSON.parse(fs.readFileSync(folder + '/appinfo.json', 'utf8')).version;
const bundles = {"main":"app.js","parse-worker":"parse.js"};
execFileSync('node_modules/.bin/tsc', ['-p', '.'], { stdio: 'inherit' });
for (const [entry, file] of Object.entries(bundles)) {
    const out = folder + '/' + file;
    execFileSync('node_modules/.bin/rollup', ['build/tsc/src/youtube/' + entry + '.js', '--format', 'iife', '--file', out, '--silent'], { stdio: 'inherit' });
    fs.writeFileSync(out, compact(fs.readFileSync(out, 'utf8').split('__BOLLI_VERSION__').join(version)));
}

function compact(code) {
    const comments = [];
    acorn.parse(code, { ecmaVersion: 5, onComment: (block, text, start, end) => comments.push([start, end]) });
    let out = '';
    let at = 0;
    for (const [start, end] of comments) {
        out += code.slice(at, start) + (/[\n\r]/.test(code.slice(start, end)) ? '\n' : ' ');
        at = end;
    }
    out += code.slice(at);
    return out.replace(/^[ \t]+/gm, '').replace(/[ \t]+$/gm, '').replace(/\n{2,}/g, '\n')
        .replace(/[\u0080-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
