// Browser replacement for the Electron main process of the ScratchJr desktop port.
// Implements the same synchronous "ipc" channels (see web/ipc.js) on top of an
// in-memory sql.js database that is persisted to IndexedDB.

import initSqlJs from 'sql.js';
import md5 from 'blueimp-md5';

const IDB_NAME = 'scratchjr-web';
const IDB_STORE = 'kv';
const DB_KEY = 'scratchjr.sqlite';

// ---------------------------------------------------------------- IndexedDB

function idbOpen () {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idbGet (idb, key) {
    return new Promise((resolve, reject) => {
        const req = idb.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idbPut (idb, key, value) {
    return new Promise((resolve, reject) => {
        const tx = idb.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

// ---------------------------------------------------------------- Database

class DatabaseManager {
    constructor (SQL, bytes) {
        if (bytes) {
            this.db = new SQL.Database(bytes);
        } else {
            this.db = new SQL.Database();
            this.initTables();
        }
        this.runMigrations();
    }

    initTables () {
        this.db.exec('CREATE TABLE IF NOT EXISTS PROJECTS (ID INTEGER PRIMARY KEY AUTOINCREMENT, CTIME DATETIME DEFAULT CURRENT_TIMESTAMP, MTIME DATETIME, ALTMD5 TEXT, POS INTEGER, NAME TEXT, JSON TEXT, THUMBNAIL TEXT, OWNER TEXT, GALLERY TEXT, DELETED TEXT, VERSION TEXT)');
        this.db.exec('CREATE TABLE IF NOT EXISTS USERSHAPES (ID INTEGER PRIMARY KEY AUTOINCREMENT, CTIME DATETIME DEFAULT CURRENT_TIMESTAMP, MD5 TEXT, ALTMD5 TEXT, WIDTH TEXT, HEIGHT TEXT, EXT TEXT, NAME TEXT, OWNER TEXT, SCALE TEXT, VERSION TEXT)');
        this.db.exec('CREATE TABLE IF NOT EXISTS USERBKGS (ID INTEGER PRIMARY KEY AUTOINCREMENT, CTIME DATETIME DEFAULT CURRENT_TIMESTAMP, MD5 TEXT, ALTMD5 TEXT, WIDTH TEXT, HEIGHT TEXT, EXT TEXT, OWNER TEXT,  VERSION TEXT)');
        this.db.exec('CREATE TABLE IF NOT EXISTS PROJECTFILES (MD5 TEXT PRIMARY KEY, CONTENTS TEXT)');
    }

    runMigrations () {
        const cols = this.query({stmt: 'PRAGMA table_info(PROJECTS)'}).map((c) => c.name.toUpperCase());
        if (cols.indexOf('ISGIFT') < 0) {
            this.db.exec('ALTER TABLE PROJECTS ADD COLUMN ISGIFT INTEGER DEFAULT 0');
        }
    }

    // Executes a statement and returns the last inserted row id (or -1 on error)
    stmt (jsonStrOrObj) {
        try {
            const json = (typeof jsonStrOrObj === 'string') ? JSON.parse(jsonStrOrObj) : (jsonStrOrObj || {});
            const statement = this.db.prepare(json.stmt, json.values);
            while (statement.step()) {
                statement.get();
            }
            statement.free();
            const res = this.db.exec('select last_insert_rowid();');
            return res[0].values[0][0];
        } catch (e) {
            console.warn('stmt failed', jsonStrOrObj, e); // eslint-disable-line no-console
            return -1;
        }
    }

    // Runs a query and returns the rows as objects
    query (jsonStrOrObj) {
        try {
            const json = (typeof jsonStrOrObj === 'string') ? JSON.parse(jsonStrOrObj) : (jsonStrOrObj || {});
            const statement = this.db.prepare(json.stmt, json.values);
            const rows = [];
            while (statement.step()) {
                rows.push(statement.getAsObject());
            }
            statement.free();
            return rows;
        } catch (e) {
            console.warn('query failed', jsonStrOrObj, e); // eslint-disable-line no-console
            return [];
        }
    }

    readProjectFile (name) {
        const rows = this.query({stmt: 'select CONTENTS from PROJECTFILES where MD5 = ?', values: [name]});
        return rows.length > 0 ? rows[0].CONTENTS : null;
    }

    saveToProjectFiles (name, contents) {
        return this.stmt({
            stmt: 'insert or replace into projectfiles (md5, contents) values (?,?)',
            values: [name, contents]
        }) >= 0;
    }

    removeProjectFile (name) {
        this.stmt({stmt: 'delete from PROJECTFILES where MD5 = ?', values: [name]});
    }

    cleanProjectFiles (fileType) {
        if (fileType === 'wav') {
            fileType = 'webm'; // recordings are stored as webm in the web/desktop port
        }
        const files = this.query({stmt: 'select MD5 from PROJECTFILES where MD5 like ?', values: ['%.' + fileType]});
        for (const row of files) {
            const name = row.MD5;
            if (!name) {
                continue;
            }
            if (this.query({stmt: 'select ID from PROJECTS where JSON like ?', values: ['%' + name + '%']}).length) {
                continue;
            }
            if (this.query({stmt: 'select MD5 from USERSHAPES where MD5 = ?', values: [name]}).length) {
                continue;
            }
            if (this.query({stmt: 'select MD5 from USERBKGS where MD5 = ?', values: [name]}).length) {
                continue;
            }
            this.removeProjectFile(name);
        }
    }
}

// ---------------------------------------------------------------- Persistence

let idb = null;
let dbm = null;
let dirty = false;
let saveTimer = null;
let savePromise = Promise.resolve();

function markDirty () {
    dirty = true;
    if (saveTimer) {
        clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(flush, 400);
}

export function flush () {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    if (!dirty) {
        return savePromise;
    }
    dirty = false;
    const bytes = dbm.db.export();
    savePromise = savePromise
        .then(() => idbPut(idb, DB_KEY, bytes))
        .catch((e) => console.error('Saving database failed', e)); // eslint-disable-line no-console
    return savePromise;
}

// ---------------------------------------------------------------- App files

// Service workers do not serve synchronous XHR offline, so files the app reads
// synchronously are fetched asynchronously at startup (see preload.json) and
// everything else is loaded through the async paths below.
const resourceCache = new Map(); // path -> text, or data URI for audio

const isAudio = (p) => /\.(wav|mp3|webm)$/i.test(p);
const audioMime = (p) => (/\.mp3$/i.test(p) ? 'audio/mp3' : /\.webm$/i.test(p) ? 'audio/webm' : 'audio/wav');

function blobToDataURL (blob) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
    });
}

async function fetchResource (p) {
    if (resourceCache.has(p)) {
        return resourceCache.get(p);
    }
    const res = await fetch(p);
    if (!res.ok) {
        return null;
    }
    let value;
    if (isAudio(p)) {
        const blob = await res.blob();
        value = await blobToDataURL(new Blob([blob], {type: audioMime(p)}));
    } else {
        value = await res.text();
    }
    resourceCache.set(p, value);
    return value;
}

async function preloadResources () {
    try {
        const list = JSON.parse(await (await fetch('preload.json')).text());
        await Promise.all(list.map((p) => fetchResource(p).catch(() => null)));
    } catch (e) {
        console.warn('Preloading resources failed', e); // eslint-disable-line no-console
    }
}

export async function getTextResourceAsync (filename) {
    const p = safeAppPath(filename);
    if (!p) {
        return null;
    }
    try {
        return await fetchResource(p);
    } catch (e) {
        return null;
    }
}

export async function getAudioDataAsync (audioName) {
    const candidates = audioName.indexOf('/') >= 0 ? [audioName] : ['sounds/' + audioName, audioName];
    for (const c of candidates) {
        const p = safeAppPath(c);
        if (!p || !/\.(wav|mp3)$/i.test(p)) {
            continue;
        }
        try {
            const data = await fetchResource(p);
            if (data) {
                return data;
            }
        } catch (e) {
            // try next
        }
    }
    // user recordings live in the database (already stored as data URIs)
    return dbm.readProjectFile(audioName);
}

// Synchronous fetch of a file shipped with the app (relative to the page).
// Returns {text} or {binary} (a binary string), or null when missing.
function syncFetch (url, binary) {
    try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, false);
        if (binary) {
            xhr.overrideMimeType('text/plain; charset=x-user-defined');
        }
        xhr.send(null);
        if (xhr.status !== 200 && xhr.status !== 0) {
            return null;
        }
        return xhr.responseText;
    } catch (e) {
        return null;
    }
}

function binaryStringToBase64 (str) {
    let out = '';
    const chunk = 0x8000;
    for (let i = 0; i < str.length; i += chunk) {
        const part = str.slice(i, i + chunk);
        let bin = '';
        for (let j = 0; j < part.length; j++) {
            bin += String.fromCharCode(part.charCodeAt(j) & 0xff);
        }
        out += bin;
    }
    return btoa(out);
}

function safeAppPath (file) {
    if (!file || /(^|\/)\.\.(\/|$)/.test(file) || /^[a-z]+:/i.test(file)) {
        return null;
    }
    return file.replace(/^\/+/, '');
}

// ---------------------------------------------------------------- Channels

const mediaCache = {};

const handlers = {
    io_getIsDebug: () => false,
    debugWriteLog: () => true,

    io_cleanassets: (fileType) => {
        dbm.cleanProjectFiles(fileType);
        markDirty();
        return true;
    },

    io_setfile: (arg) => {
        const ok = dbm.saveToProjectFiles(arg.name, arg.contents);
        markDirty();
        return ok ? arg.name : -1;
    },

    io_getfile: (name) => dbm.readProjectFile(name),
    io_getmedia: (name) => dbm.readProjectFile(name),

    io_getmedialen: (file, key) => {
        const str = dbm.readProjectFile(file);
        mediaCache[key] = str;
        return str ? str.length : 0;
    },

    io_getmediadata: (key, offset, length) => {
        const str = mediaCache[key];
        return str ? str.substring(offset, offset + length) : null;
    },

    io_getmediadone: (key) => {
        delete mediaCache[key];
        return true;
    },

    io_setmedia: (base64, ext) => {
        const name = md5(base64) + '.' + ext;
        dbm.saveToProjectFiles(name, base64);
        markDirty();
        return name;
    },

    io_setmedianame: (data, key, ext) => {
        const name = key + '.' + ext;
        dbm.saveToProjectFiles(name, data);
        markDirty();
        return name;
    },

    io_getsettings: () => 'ScratchJr,false,YES,YES',

    io_getmd5: (data) => md5(data),

    io_remove: (name) => {
        dbm.removeProjectFile(name);
        markDirty();
        return true;
    },

    io_gettextresource: (filename) => {
        const p = safeAppPath(filename);
        if (!p) {
            return null;
        }
        if (resourceCache.has(p)) {
            return resourceCache.get(p);
        }
        return syncFetch(p, false); // works online; offline only preloaded files are available
    },

    io_getAudioData: (audioName) => {
        const candidates = audioName.indexOf('/') >= 0 ? [audioName] : ['sounds/' + audioName, audioName];
        for (const c of candidates) {
            const p = safeAppPath(c);
            if (!p || !/\.(wav|mp3)$/i.test(p)) {
                continue;
            }
            if (resourceCache.has(p)) {
                return resourceCache.get(p);
            }
            const data = syncFetch(p, true);
            if (data) {
                const mime = /\.mp3$/i.test(p) ? 'audio/mp3' : 'audio/wav';
                return 'data:' + mime + ';base64,' + binaryStringToBase64(data);
            }
        }
        // user recordings live in the database (already stored as data URIs)
        return dbm.readProjectFile(audioName);
    },

    database_stmt: (json) => {
        const res = dbm.stmt(json);
        const s = (typeof json === 'string' ? json : (json && json.stmt) || '').trim().toLowerCase();
        if (!s.startsWith('select')) {
            markDirty();
        }
        return res;
    },

    database_query: (json) => {
        const s = (typeof json === 'string' ? JSON.parse(json).stmt : (json && json.stmt) || '').trim().toLowerCase();
        const res = JSON.stringify(dbm.query(json));
        if (!s.startsWith('select')) {
            markDirty();
        }
        return res;
    }
};

export const ipcRenderer = {
    sendSync (channel, ...args) {
        const h = handlers[channel];
        if (!h) {
            console.warn('Unhandled channel', channel, args); // eslint-disable-line no-console
            return null;
        }
        return h(...args);
    },
    send (channel, ...args) {
        try {
            this.sendSync(channel, ...args);
        } catch (e) {
            // ignore
        }
    },
    on () {}
};

// ---------------------------------------------------------------- Startup

export async function initBackend () {
    const [SQL, idbHandle] = await Promise.all([
        initSqlJs({locateFile: () => 'sql-wasm.wasm'}),
        idbOpen(),
        preloadResources()
    ]);
    idb = idbHandle;
    const bytes = await idbGet(idb, DB_KEY);
    dbm = new DatabaseManager(SQL, bytes ? new Uint8Array(bytes) : null);
    if (!bytes) {
        dirty = true;
        await flush();
    }
    if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().catch(() => {});
    }
    // Save before the page goes away (best effort)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            flush();
        }
    });
    window.addEventListener('pagehide', () => flush());
}

// Navigation used by the app (patched in at build time): wait for pending saves.
export function navigate (url) {
    flush().then(() => {
        window.location.href = url;
    });
}

// Raw database export/import for backups
export async function exportDatabase () {
    await flush();
    return dbm.db.export();
}

export async function importDatabase (bytes) {
    await idbPut(idb, DB_KEY, bytes);
}
