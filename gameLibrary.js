/* gameLibrary.js — Biblioteca de jogos lendo de uma pasta local */
(scope => {
    'use strict';

    const DB_NAME = 'psx-lib';
    const STORE   = 'handles';
    const KEY     = 'gamesDir';
    const GAME_EXT = ['.iso', '.bin', '.img', '.cue', '.exe'];

    let dirHandle   = null;     // desktop (persistente)
    let sessionFiles = null;    // fallback mobile (só na sessão)
    let modal = null;
    let entries = [];

    /* ---------- IndexedDB ---------- */
    function openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => req.result.createObjectStore(STORE);
            req.onsuccess = () => resolve(req.result);
            req.onerror   = () => reject(req.error);
        });
    }
    async function idbPut(key, val) {
        const db = await openDB();
        return new Promise((res, rej) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(val, key);
            tx.oncomplete = res;
            tx.onerror = () => rej(tx.error);
        });
    }
    async function idbGet(key) {
        const db = await openDB();
        return new Promise(res => {
            const tx = db.transaction(STORE, 'readonly');
            const r  = tx.objectStore(STORE).get(key);
            r.onsuccess = () => res(r.result || null);
            r.onerror   = () => res(null);
        });
    }

    /* ---------- Permissões ---------- */
    async function ensurePerm(handle, mode = 'read') {
        if (!handle || !handle.queryPermission) return true;
        const opts = { mode };
        if (await handle.queryPermission(opts) === 'granted') return true;
        return (await handle.requestPermission(opts)) === 'granted';
    }

    const hasFS = typeof window.showDirectoryPicker === 'function';

    /* ---------- Escolher pasta ---------- */
    async function pickFolder() {
        if (hasFS) {
            try {
                const h = await window.showDirectoryPicker({ id: 'psx-games', mode: 'read' });
                if (!await ensurePerm(h)) return false;
                dirHandle = h;
                sessionFiles = null;
                await idbPut(KEY, h);
                return true;
            } catch (e) {
                if (e.name !== 'AbortError') console.warn('[gameLibrary]', e);
                return false;
            }
        }
        // Fallback: input webkitdirectory (Android Chrome, Safari parcial)
        return new Promise(resolve => {
            const inp = document.createElement('input');
            inp.type = 'file';
            inp.webkitdirectory = true;
            inp.multiple = true;
            inp.style.display = 'none';
            const cleanup = () => inp.remove();
            inp.addEventListener('change', () => {
                sessionFiles = Array.from(inp.files || []);
                dirHandle = null;
                cleanup();
                resolve(sessionFiles.length > 0);
            });
            inp.addEventListener('cancel', () => { cleanup(); resolve(false); });
            document.body.appendChild(inp);
            inp.click();
        });
    }

    /* ---------- Escanear ---------- */
    const isGame = n => GAME_EXT.some(ext => n.toLowerCase().endsWith(ext));

    async function scan() {
        const out = [];
        if (dirHandle) {
            if (!await ensurePerm(dirHandle)) return [];
            try {
                for await (const e of dirHandle.values()) {
                    if (e.kind === 'file' && isGame(e.name))
                        out.push({ name: e.name, handle: e });
                }
            } catch (e) { console.warn(e); }
        } else if (sessionFiles) {
            for (const f of sessionFiles)
                if (isGame(f.name)) out.push({ name: f.name, file: f });
        }
        out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        return out;
    }

    /* ---------- Carregar ---------- */
    async function readEntry(entry) {
        if (entry.file) return entry.file.arrayBuffer();
        const f = await entry.handle.getFile();
        return f.arrayBuffer();
    }

    async function loadEntry(entry) {
        let buf = await readEntry(entry);

        // .cue → tenta carregar o .bin referenciado
        if (entry.name.toLowerCase().endsWith('.cue') && dirHandle) {
            const txt = new TextDecoder('latin1').decode(buf);
            const m = txt.match(/FILE\s+"([^"]+)"/i);
            if (m) {
                const binName = m[1].split(/[\\/]/).pop();
                try {
                    const h  = await dirHandle.getFileHandle(binName);
                    const bf = await h.getFile();
                    buf = await bf.arrayBuffer();
                } catch (_) { /* mantém o .cue */ }
            }
        }

        if (typeof scope.loadFileData !== 'function') {
            alert('loadFileData indisponível. Adicione em index.js.');
            return false;
        }
        scope.loadFileData(buf);
        return true;
    }

    /* ---------- UI ---------- */
    const el = (t, c, x) => {
        const e = document.createElement(t);
        if (c) e.className = c;
        if (x !== undefined) e.textContent = x;
        return e;
    };

    function buildModal() {
        const overlay = el('div', 'menu-modal hidden');
        const box = el('div', 'menu-box');

        const header = el('div', 'menu-header');
        header.appendChild(el('h2', 'menu-title', '📚  Biblioteca'));
        const close = el('button', 'menu-close', '×');
        close.type = 'button';
        close.addEventListener('click', () => hide());
        header.appendChild(close);
        box.appendChild(header);

        const toolbar = el('div', 'lib-toolbar');
        const btnPick = el('button', 'lib-btn', '📁  Escolher pasta');
        btnPick.type = 'button';
        btnPick.addEventListener('click', async () => {
            const ok = await pickFolder();
            if (ok) { entries = await scan(); renderList(); }
        });
        const btnRefresh = el('button', 'lib-btn', '🔄  Recarregar');
        btnRefresh.type = 'button';
        btnRefresh.addEventListener('click', async () => {
            entries = await scan();
            renderList();
        });
        toolbar.appendChild(btnPick);
        toolbar.appendChild(btnRefresh);
        box.appendChild(toolbar);

        const info = el('div', 'lib-info', 'Nenhuma pasta configurada.');
        info.id = 'lib-info';
        box.appendChild(info);

        const list = el('div', 'menu-list');
        list.id = 'lib-list';
        box.appendChild(list);

        overlay.appendChild(box);
        overlay.addEventListener('click', e => { if (e.target === overlay) hide(); });
        document.body.appendChild(overlay);
        return overlay;
    }

    function renderList() {
        const list = document.getElementById('lib-list');
        const info = document.getElementById('lib-info');
        list.innerHTML = '';

        if (!entries.length) {
            info.textContent = (dirHandle || sessionFiles)
                ? 'Nenhum jogo (.iso/.bin/.cue/.img/.exe) encontrado na pasta.'
                : 'Toque em "Escolher pasta" para começar.';
            return;
        }
        info.textContent = entries.length + ' jogo(s) encontrado(s).';

        for (const ent of entries) {
            const item = el('button', 'menu-item');
            item.type = 'button';
            item.appendChild(el('span', 'menu-icon', '💿'));
            item.appendChild(el('span', 'menu-label', ent.name));
            item.addEventListener('click', async () => {
                item.classList.add('loading');
                try {
                    const ok = await loadEntry(ent);
                    if (ok) hide();
                } finally {
                    item.classList.remove('loading');
                }
            });
            list.appendChild(item);
        }
    }

    async function show() {
        if (!modal) modal = buildModal();
        modal.classList.remove('hidden');
        entries = await scan();
        renderList();
    }

    function hide() {
        if (modal) modal.classList.add('hidden');
    }

    /* ---------- Restaurar pasta (desktop) ---------- */
    async function restore() {
        if (!hasFS) return;
        const h = await idbGet(KEY);
        if (h) dirHandle = h;
    }

    /* ---------- CSS ---------- */
    function injectCSS() {
        const s = document.createElement('style');
        s.textContent = `
.lib-toolbar {
    display: flex; gap: 8px; padding: 10px 14px 4px;
}
.lib-btn {
    flex: 1;
    padding: 10px 12px;
    background: rgba(106,193,255,0.12);
    border: 1px solid rgba(106,193,255,0.35);
    border-radius: 12px;
    color: #eaeaea;
    font-family: inherit; font-size: 14px; font-weight: 600;
    cursor: pointer;
    transition: background .15s;
}
.lib-btn:hover  { background: rgba(106,193,255,0.22); }
.lib-btn:active { background: rgba(106,193,255,0.35); }
.lib-info {
    padding: 4px 18px 8px;
    font-size: 11.5px;
    letter-spacing: .4px;
    color: #8a8a8a;
    text-transform: uppercase;
    font-weight: 600;
}
.menu-item.loading { opacity: .55; pointer-events: none; }
        `;
        document.head.appendChild(s);
    }

    injectCSS();
    restore();

    scope.gameLibrary = {
        show, hide, pickFolder,
        refresh: async () => { entries = await scan(); if (modal) renderList(); },
        hasFolder: () => !!(dirHandle || sessionFiles),
    };

})(window);