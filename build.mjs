// Builds the browser/PWA version into dist/
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const app = path.join(root, 'app');
const dist = path.join(root, 'dist');
const APP_NAME = 'ScratchJr';

fs.rmSync(dist, {recursive: true, force: true});

// 1. Copy static app files (everything except JS sources)
fs.cpSync(app, dist, {
    recursive: true,
    filter: (src) => {
        const rel = path.relative(app, src).replace(/\\/g, '/');
        if (rel === 'src' || rel.startsWith('src/') || rel === 'appEntry.js') {
            return false;
        }
        return !/\.DS_Store$/.test(rel);
    }
});

// 2. Patch navigations so pending database writes are flushed first
const navPatch = {
    name: 'nav-patch',
    setup (build) {
        build.onLoad({filter: /[\\/]app[\\/].*\.js$/}, async (args) => {
            let src = await fs.promises.readFile(args.path, 'utf8');
            src = src.replace(/window\.location(?:\.href)?\s*=\s*([^;\n]+);/g, 'window.__sjrNavigate($1);');
            // start the app only after the web backend (database + preloaded files) is ready
            src = src.replace('window.onload = () => loadPage(window.scratchJrPage);',
                'window.onload = () => window.__sjrReady.then(() => loadPage(window.scratchJrPage));');
            return {contents: src, loader: 'js'};
        });
    }
};

const common = {
    bundle: true,
    minifyWhitespace: true,
    minifySyntax: true,
    sourcemap: true,
    target: ['es2022'],
    define: {'process.env.NODE_ENV': '"production"', global: 'globalThis'},
    logLevel: 'info'
};

await esbuild.build({
    ...common,
    entryPoints: [path.join(app, 'appEntry.js')],
    outfile: path.join(dist, 'app.bundle.js'),
    plugins: [navPatch],
    minifyIdentifiers: false, // CSS templates eval() names like css_vw
    format: 'iife'
});

await esbuild.build({
    ...common,
    entryPoints: [path.join(root, 'web', 'webClient.js')],
    outfile: path.join(dist, 'webclient.bundle.js'),
    format: 'iife',
    // sql.js references node modules in code paths never used in the browser
    external: ['fs', 'path', 'crypto']
});

fs.copyFileSync(path.join(root, 'node_modules/sql.js/dist/sql-wasm-browser.wasm'), path.join(dist, 'sql-wasm.wasm'));

// Files the app reads synchronously: fetched async at startup (offline-safe)
const preload = [];
const addDir = (dir, re) => {
    for (const f of fs.readdirSync(path.join(dist, dir))) {
        if (re.test(f)) {
            preload.push(dir + '/' + f);
        }
    }
};
addDir('css', /\.css$/);
addDir('inapp/style', /\.css$/);
addDir('sounds', /\.(wav|mp3)$/);
preload.push('settings.json', 'media.json');
fs.writeFileSync(path.join(dist, 'preload.json'), JSON.stringify(preload));

// 3. Rewrite HTML pages to load the web scripts and register the PWA
const headExtra = [
    '<link rel="manifest" href="manifest.webmanifest">',
    '<meta name="theme-color" content="#7c55c7">',
    '<meta name="mobile-web-app-capable" content="yes">',
    '<link rel="apple-touch-icon" href="icons/icon-192.png">',
    '<script src="webclient.bundle.js"></script>',
    '<script src="app.bundle.js"></script>',
    '<script>if("serviceWorker" in navigator){navigator.serviceWorker.register("sw.js");}</script>'
].join('\n');

for (const f of fs.readdirSync(dist).filter((n) => n.endsWith('.html'))) {
    const p = path.join(dist, f);
    let html = fs.readFileSync(p, 'utf8');
    html = html
        .replace(/<script src='..\/electronClient.js'><\/script>\s*/, '')
        .replace(/<script type="text\/javascript" src="appEntry.js"><\/script>/, headExtra);
    fs.writeFileSync(p, html);
}

// 4. Icons
fs.mkdirSync(path.join(dist, 'icons'), {recursive: true});
const iconSrc = path.join(root, 'web', 'icons');
for (const f of fs.readdirSync(iconSrc)) {
    fs.copyFileSync(path.join(iconSrc, f), path.join(dist, 'icons', f));
}

// 5. Manifest
fs.writeFileSync(path.join(dist, 'manifest.webmanifest'), JSON.stringify({
    name: APP_NAME,
    short_name: APP_NAME,
    start_url: './index.html',
    scope: './',
    display: 'fullscreen',
    orientation: 'landscape',
    background_color: '#000000',
    theme_color: '#7c55c7',
    icons: [
        {src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png'},
        {src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png'},
        {src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable'}
    ]
}, null, 2));

// 6. Service worker with a full precache (the app works offline)
const files = [];
(function walk (dir) {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            walk(full);
        } else if (!/\.map$/.test(e.name)) {
            files.push(path.relative(dist, full).replace(/\\/g, '/'));
        }
    }
})(dist);
const hash = crypto.createHash('sha1');
for (const f of files.sort()) {
    hash.update(f);
    hash.update(fs.readFileSync(path.join(dist, f)));
}
const version = hash.digest('hex').slice(0, 12);
const sw = fs.readFileSync(path.join(root, 'web', 'sw.template.js'), 'utf8')
    .replace('__VERSION__', version)
    .replace('__FILES__', JSON.stringify(['./', ...files]));
fs.writeFileSync(path.join(dist, 'sw.js'), sw);

console.log(`Built ${files.length} files, cache version ${version}`); // eslint-disable-line no-console
