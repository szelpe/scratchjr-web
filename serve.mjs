// Tiny static server for dist/ (use any static host in production)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'dist');
const port = Number(process.env.PORT) || 8642;
const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.ttf': 'font/ttf', '.otf': 'font/otf',
    '.woff': 'font/woff', '.txt': 'text/plain', '.map': 'application/json'
};

http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) {
        p += 'index.html';
    }
    const file = path.join(root, p);
    if (!file.startsWith(root)) {
        res.writeHead(403).end();
        return;
    }
    fs.readFile(file, (err, data) => {
        if (err) {
            res.writeHead(404).end('not found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-cache'
        });
        res.end(data);
    });
}).listen(port, () => {
    const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
    console.log(`Serving ${root}`); // eslint-disable-line no-console
    console.log(`  http://localhost:${port}/`); // eslint-disable-line no-console
    for (const i of ips) {
        console.log(`  http://${i.address}:${port}/`); // eslint-disable-line no-console
    }
});
