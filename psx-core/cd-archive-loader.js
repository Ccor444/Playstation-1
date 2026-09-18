(function (scope) {
'use strict';

const ZIP_MAGIC = [0x50, 0x4b];
const SEVENZ_MAGIC = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];
const MEDIA_EXTS = ['.bin', '.iso', '.img', '.chd', '.mdf', '.mds', '.ecm', '.wav'];

let custom7zExtractor = null;

const scans = new Map();
let scanSeq = 0;

function register7zExtractor(fn) {
    custom7zExtractor = fn;
}

// ============================================================================
// Utilidades
// ============================================================================

function normalizePath(p) {
    return String(p || '')
        .replace(/\\/g, '/')
        .replace(/^[./]+/, '')
        .toLowerCase();
}

function baseName(p) {
    const s = normalizePath(p);
    const i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
}

function isMediaPath(p) {
    return MEDIA_EXTS.some(ext => p.endsWith(ext));
}

function isKnownMediaBase(name) {
    return /\.(bin|iso|img|chd|cue|wav|mdf|mds|ecm)$/i.test(name);
}

function normalizeBase(name) {
    return String(name || '')
        .replace(/\.[^.]+$/, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

function partInfo(name) {
    const s = String(name || '');

    let m = s.match(/^(.*)\.z(\d{2,3})$/i);
    if (m) {
        return {
            base: m[1] + '.zip',
            index: parseInt(m[2], 10)
        };
    }

    m = s.match(/^(.*)\.(zip|7z|rar|bin|iso|img|chd|cue|wav|mdf|mds|ecm)\.(\d{2,3})$/i);
    if (m) {
        return {
            base: m[1] + '.' + m[2],
            index: parseInt(m[3], 10)
        };
    }

    return {
        base: s,
        index: 0
    };
}

function isArchiveByName(name) {
    return /\.(zip|7z|rar|z\d{2,3})$/i.test(name) ||
           /\.(zip|7z|rar)\.\d{2,3}$/i.test(name);
}

function startsWith(u8, magic) {
    if (!u8 || u8.length < magic.length) return false;
    for (let i = 0; i < magic.length; i++) {
        if (u8[i] !== magic[i]) return false;
    }
    return true;
}

async function readMagic(blob) {
    try {
        const ab = await blob.slice(0, 16).arrayBuffer();
        return new Uint8Array(ab);
    } catch (e) {
        return new Uint8Array(0);
    }
}

function addFile(map, fullName, data) {
    if (!fullName) return;

    let u8;
    if (data instanceof Uint8Array) {
        u8 = data;
    } else if (data instanceof ArrayBuffer) {
        u8 = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
        u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
        u8 = new Uint8Array(data);
    }

    map.set(normalizePath(fullName), u8);
}

function resolveFileData(map, name) {
    const p = normalizePath(name);
    if (map.has(p)) return map.get(p);

    const base = baseName(p);
    for (const [k, v] of map.entries()) {
        if (baseName(k) === base) return v;
    }

    return undefined;
}

function findPathsByExt(map, exts) {
    return [...map.keys()]
        .filter(k => exts.some(e => k.endsWith(e)))
        .sort();
}

function findMediaPaths(map) {
    return [...map.keys()]
        .filter(isMediaPath)
        .sort();
}

function dispatchStatus(message, error = false) {
    scope.dispatchEvent(new CustomEvent('cdarchive:status', {
        detail: { message, error }
    }));
}

// ============================================================================
// Junção de partes
// ============================================================================

async function combineParts(namedBlobs) {
    const groups = new Map();
    let combinedAny = false;

    for (const item of namedBlobs) {
        const info = partInfo(item.name);
        const key = info.base.toLowerCase();

        if (!groups.has(key)) {
            groups.set(key, {
                base: info.base,
                items: []
            });
        }

        groups.get(key).items.push({
            item,
            index: info.index
        });
    }

    const out = [];

    for (const group of groups.values()) {
        if (group.items.length === 1) {
            out.push(group.items[0].item);
            continue;
        }

        combinedAny = true;

        const zero = group.items.find(e => e.index === 0);
        const isZip = /\.zip$/i.test(group.base);

        if (zero && !isZip) {
            out.push(zero.item);
            continue;
        }

        group.items.sort((a, b) => {
            let ai = a.index;
            let bi = b.index;

            if (isZip) {
                if (ai === 0) ai = Number.MAX_SAFE_INTEGER;
                if (bi === 0) bi = Number.MAX_SAFE_INTEGER;
            }

            return ai - bi;
        });

        const chunks = [];
        for (const entry of group.items) {
            chunks.push(new Uint8Array(await entry.item.blob.arrayBuffer()));
        }

        const total = chunks.reduce((s, u) => s + u.byteLength, 0);
        const combined = new Uint8Array(total);

        let off = 0;
        for (const u of chunks) {
            combined.set(u, off);
            off += u.byteLength;
        }

        out.push({
            name: group.base,
            blob: new Blob([combined], { type: 'application/octet-stream' })
        });
    }

    return {
        items: out,
        combinedAny
    };
}

function assembleSplitEntries(map) {
    let assembled = false;
    const groups = new Map();

    for (const key of [...map.keys()]) {
        const info = partInfo(key);

        if (info.index > 0 && isKnownMediaBase(info.base)) {
            if (!groups.has(info.base)) {
                groups.set(info.base, []);
            }

            groups.get(info.base).push({
                key,
                index: info.index
            });
        }
    }

    for (const [base, parts] of groups.entries()) {
        if (map.has(base)) {
            parts.forEach(p => map.delete(p.key));
            assembled = true;
            continue;
        }

        parts.sort((a, b) => a.index - b.index);

        const datas = parts
            .map(p => map.get(p.key))
            .filter(Boolean);

        if (!datas.length) continue;

        const total = datas.reduce((s, d) => s + d.byteLength, 0);
        const combined = new Uint8Array(total);

        let off = 0;
        for (const d of datas) {
            combined.set(d, off);
            off += d.byteLength;
        }

        parts.forEach(p => map.delete(p.key));
        map.set(base, combined);
        assembled = true;
    }

    return assembled;
}

// ============================================================================
// Extração ZIP
// ============================================================================

async function getFflate() {
    if (scope.fflate) return scope.fflate;

    const mod = await import('https://cdn.jsdelivr.net/npm/fflate@0.8.2/+esm');
    return mod;
}

async function extractZip(blob) {
    const fflate = await getFflate();
    const u8 = new Uint8Array(await blob.arrayBuffer());

    const entries = fflate.unzipSync
        ? fflate.unzipSync(u8)
        : fflate.default.unzipSync(u8);

    const out = new Map();

    for (const [entryName, data] of Object.entries(entries)) {
        if (entryName.endsWith('/')) continue;
        addFile(out, entryName, data);
    }

    return out;
}

// ============================================================================
// Extração 7z / RAR
// ============================================================================

async function ensureLibarchive() {
    if (scope.Archive) return scope.Archive;

    const url = scope.CD_ARCHIVE_LIBARCHIVE_URL ||
        'https://cdn.jsdelivr.net/npm/libarchive.js@2/+esm';

    const workerUrl = scope.CD_ARCHIVE_LIBARCHIVE_WORKER ||
        'https://cdn.jsdelivr.net/npm/libarchive.js@2/dist/worker-bundle.js';

    const mod = await import(/* @vite-ignore */ url);

    const Archive =
        mod.Archive ||
        (mod.default && mod.default.Archive) ||
        mod.default;

    if (!Archive || typeof Archive.open !== 'function') {
        throw new Error('Não conseguiu carregar libarchive.js (window.Archive).');
    }

    if (typeof Archive.init === 'function') {
        Archive.init({ workerUrl });
    }

    scope.Archive = Archive;
    return Archive;
}

async function extractWithLibarchive(blob, Archive) {
    const archive = await Archive.open(blob);
    const out = new Map();

    try {
        const entries = await archive.getFilesArray();

        for (const entry of entries) {
            if (entry.directory) continue;

            const name = entry.path || entry.name;
            if (!name || name.endsWith('/')) continue;

            if (typeof entry.size === 'number' && entry.size === 0) continue;

            const extracted = await entry.extract();
            const ab = await extracted.arrayBuffer();
            addFile(out, name, new Uint8Array(ab));
        }
    } finally {
        if (typeof archive.close === 'function') {
            try {
                await archive.close();
            } catch (e) {
                // ignore
            }
        }
    }

    return out;
}

function normalizeExtractedMap(result) {
    if (result instanceof Map) return result;

    const out = new Map();

    if (Array.isArray(result)) {
        for (const item of result) {
            addFile(out, item.name || item.path, item.data);
        }
    } else if (result && typeof result === 'object') {
        for (const [k, v] of Object.entries(result)) {
            addFile(out, k, v);
        }
    }

    return out;
}

async function extract7z(blob, name) {
    if (custom7zExtractor) {
        const result = await custom7zExtractor(blob, name);
        return normalizeExtractedMap(result);
    }

    const Archive = scope.Archive || await ensureLibarchive();
    return extractWithLibarchive(blob, Archive);
}

async function extractAnyArchive(blob, name) {
    const magic = await readMagic(blob);

    if (startsWith(magic, ZIP_MAGIC) || /\.zip$/i.test(name)) {
        return extractZip(blob);
    }

    if (startsWith(magic, SEVENZ_MAGIC) || /\.(7z|rar)$/i.test(name)) {
        return extract7z(blob, name);
    }

    try {
        return await extractZip(blob);
    } catch (e) {
        // ignore
    }

    return extract7z(blob, name);
}

// ============================================================================
// Preparar arquivos extraídos
// ============================================================================

async function prepareMapFromFileList(fileList) {
    const items = Array
        .from(fileList || [])
        .filter(Boolean)
        .map(f => ({
            name: f.name || 'file',
            blob: f
        }));

    if (!items.length) {
        return {
            map: new Map(),
            transformed: false,
            archiveFound: false
        };
    }

    const { items: combined, combinedAny } = await combineParts(items);

    const map = new Map();
    let archiveFound = false;
    let singlePartRenamed = false;

    for (const item of combined) {
        const magic = await readMagic(item.blob);

        const archive =
            startsWith(magic, ZIP_MAGIC) ||
            startsWith(magic, SEVENZ_MAGIC) ||
            isArchiveByName(item.name);

        if (archive) {
            archiveFound = true;

            const extracted = await extractAnyArchive(item.blob, item.name);
            for (const [k, v] of extracted.entries()) {
                map.set(k, v);
            }
        } else {
            const data = new Uint8Array(await item.blob.arrayBuffer());
            const info = partInfo(item.name);

            // Se for uma parte única de mídia, renomeia para o nome base.
            if (info.index > 0 && isKnownMediaBase(info.base)) {
                addFile(map, info.base, data);
                singlePartRenamed = true;
            } else {
                addFile(map, item.name, data);
            }
        }
    }

    const assembledAny = assembleSplitEntries(map);

    return {
        map,
        transformed: combinedAny || archiveFound || assembledAny || singlePartRenamed,
        archiveFound
    };
}

// ============================================================================
// CUE helpers
// ============================================================================

function decodeText(u8) {
    const labels = ['utf-8', 'windows-1252', 'shift_jis', 'iso-8859-1'];

    for (const label of labels) {
        try {
            return new TextDecoder(label, { fatal: true }).decode(u8);
        } catch (e) {
            // tenta o próximo
        }
    }

    return new TextDecoder('utf-8').decode(u8);
}

function parseCueFileNames(cueText) {
    const names = [];
    const lines = cueText.split(/\r?\n/);

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        const m = line.match(/^FILE\s+(?:"([^"]+)"|(\S+))\s+(\S+)/i);
        if (m) {
            names.push(m[1] || m[2]);
        }
    }

    return names;
}

function resolveMediaByName(map, refName) {
    const p = normalizePath(refName);

    if (map.has(p) && isMediaPath(p)) {
        return {
            key: p,
            data: map.get(p)
        };
    }

    const base = baseName(p);

    for (const [k, v] of map.entries()) {
        if (isMediaPath(k) && baseName(k) === base) {
            return {
                key: k,
                data: v
            };
        }
    }

    const norm = normalizeBase(base);
    if (norm) {
        for (const [k, v] of map.entries()) {
            if (isMediaPath(k) && normalizeBase(baseName(k)) === norm) {
                return {
                    key: k,
                    data: v
                };
            }
        }
    }

    return null;
}

function createFileFromData(name, data) {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    return new File([u8], name, { type: 'application/octet-stream' });
}

function buildFilesForCue(map, cuePath) {
    const cueData = resolveFileData(map, cuePath);
    if (!cueData) {
        throw new Error('CUE não encontrado: ' + cuePath);
    }

    const cueName = baseName(cuePath);
    const files = [createFileFromData(cueName, cueData)];
    const seen = new Set([cueName.toLowerCase()]);

    const cueText = decodeText(cueData);
    const refs = parseCueFileNames(cueText);

    let foundCount = 0;

    for (const ref of refs) {
        const found = resolveMediaByName(map, ref);

        if (found) {
            const name = baseName(found.key);

            if (!seen.has(name.toLowerCase())) {
                files.push(createFileFromData(name, found.data));
                seen.add(name.toLowerCase());
            }

            foundCount++;
        }
    }

    // Fallback: se o CUE referencia arquivos e nem todos foram encontrados,
    // tenta incluir todas as mídias disponíveis.
    if (foundCount < refs.length) {
        for (const p of findMediaPaths(map)) {
            const name = baseName(p);

            if (!seen.has(name.toLowerCase())) {
                files.push(createFileFromData(name, map.get(p)));
                seen.add(name.toLowerCase());
            }
        }
    }

    return files;
}

function chooseMediaPath(map) {
    const paths = findMediaPaths(map);

    if (!paths.length) return undefined;
    if (paths.length === 1) return paths[0];

    const size = (p) => {
        const d = map.get(p);
        return d ? d.byteLength : 0;
    };

    return paths.slice().sort((a, b) => size(b) - size(a))[0];
}

// ============================================================================
// Injeção compatível com index.js
// ============================================================================

function injectFiles(files) {
    const input = document.getElementById('file');

    if (!input) {
        throw new Error('Elemento #file não encontrado para compatibilidade com index.js');
    }

    let dt;

    try {
        dt = new DataTransfer();
    } catch (e) {
        throw new Error('DataTransfer não suportado neste navegador.');
    }

    for (const f of files) {
        dt.items.add(f);
    }

    try {
        input.files = dt.files;
        const evt = new Event('change', {
            bubbles: true,
            cancelable: true
        });
        input.dispatchEvent(evt);
    } catch (e) {
        const dropEvt = new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt
        });
        document.dispatchEvent(dropEvt);
    }
}

function injectCue(map, cuePath) {
    const files = buildFilesForCue(map, cuePath);
    injectFiles(files);
    dispatchStatus('CD carregado via CUE: ' + baseName(cuePath));
}

function injectMedia(map, mediaPath) {
    const data = map.get(mediaPath);
    const files = [createFileFromData(baseName(mediaPath), data)];
    injectFiles(files);
    dispatchStatus('CD carregado: ' + baseName(mediaPath));
}

function handleExtractedMap(map) {
    const cues = findPathsByExt(map, ['.cue']);

    if (cues.length > 1) {
        const scanId = ++scanSeq;
        scans.set(scanId, { map });

        const evt = new CustomEvent('cdarchive:multidue', {
            detail: {
                scanId,
                cues
            },
            cancelable: true
        });

        scope.dispatchEvent(evt);

        // Se a UI não tratar, carrega o primeiro automaticamente.
        if (!evt.defaultPrevented) {
            selectCue(scanId, cues[0]);
        }

        return;
    }

    if (cues.length === 1) {
        injectCue(map, cues[0]);
        return;
    }

    const media = chooseMediaPath(map);

    if (!media) {
        throw new Error('Nenhuma imagem de CD encontrada (.cue/.bin/.iso/.img/.chd).');
    }

    injectMedia(map, media);
}

// ============================================================================
// API principal
// ============================================================================

async function processFiles(fileList) {
    const { map, transformed } = await prepareMapFromFileList(fileList);

    if (!transformed) {
        return false;
    }

    handleExtractedMap(map);
    return true;
}

function selectCue(scanId, cuePath) {
    const scan = scans.get(scanId);
    if (!scan) return;

    scans.delete(scanId);
    injectCue(scan.map, cuePath);
}

function cancelScan(scanId) {
    scans.delete(scanId);
}

function hasArchiveOrPartsByName(fileList) {
    if (!fileList) return false;

    for (let i = 0; i < fileList.length; i++) {
        const name = fileList[i].name || '';

        if (isArchiveByName(name)) return true;

        const info = partInfo(name);
        if (info.index > 0 && isKnownMediaBase(info.base)) return true;
    }

    return false;
}

// ============================================================================
// Bind automático, compatível com index.js
// ============================================================================

function bind() {
    const input = document.getElementById('file');

    if (input) {
        input.addEventListener('change', async function (e) {
            const files = e.target.files;

            if (!files || !files.length) return;

            // Se não for ZIP/7z/partes, deixa o index.js normal trabalhar.
            if (!hasArchiveOrPartsByName(files)) return;

            // Intercepta antes do index.js
            e.stopImmediatePropagation();
            e.preventDefault();

            try {
                dispatchStatus('Processando arquivos compactados/partes...');
                const consumed = await processFiles(files);

                if (!consumed) {
                    dispatchStatus('Nada para processar.', true);
                }
            } catch (err) {
                console.error('[cd-archive-loader]', err);
                dispatchStatus(err.message || String(err), true);
            } finally {
                try {
                    input.value = '';
                } catch (_) {
                    // ignore
                }
            }
        }, true);
    }

    // Drag & drop: intercepta somente quando houver ZIP/7z/partes.
    document.addEventListener('dragover', function (e) {
        e.preventDefault();
    }, true);

    document.addEventListener('drop', async function (e) {
        const files = e.dataTransfer && e.dataTransfer.files;

        if (!files || !files.length) return;

        if (!hasArchiveOrPartsByName(files)) return;

        e.preventDefault();
        e.stopImmediatePropagation();

        try {
            dispatchStatus('Processando arquivos compactados/partes...');
            await processFiles(files);
        } catch (err) {
            console.error('[cd-archive-loader]', err);
            dispatchStatus(err.message || String(err), true);
        }
    }, true);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
} else {
    bind();
}

scope.cdArchiveLoader = {
    processFiles,
    selectCue,
    cancelScan,
    register7zExtractor
};

})(window);