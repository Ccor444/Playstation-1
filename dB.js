// dB.js — Database Manager atualizado
console.log('[dB] Inicializando carregamento de DBs...');

const DBManager = (() => {
    let dbs = {
        disc: {},
        achievements: {},
        games: {}
    };
    let loaded = {
        disc: false,
        achievements: false,
        games: false
    };

    // Função genérica para carregar YAML
    async function loadYAML(url) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Falha ao carregar ${url}: ${res.status}`);
            const text = await res.text();
            return parseYAML(text);
        } catch (err) {
            console.error(`[dB] Erro ao carregar ${url}:`, err);
            return {};
        }
    }

    // Parse YAML simples
    function parseYAML(yamlText) {
        const lines = yamlText.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
        const obj = {};
        let currentKey = null;

        lines.forEach(line => {
            if (/^\S/.test(line)) {
                const [key, value] = line.split(':').map(s => s.trim());
                currentKey = key;
                obj[key] = value || {};
            } else if (currentKey) {
                const match = line.match(/^\s+(\S+):\s*(.+)$/);
                if (match) {
                    const [, k, v] = match;
                    obj[currentKey][k] = v;
                }
            }
        });
        return obj;
    }

    // Carrega todos os DBs
    async function loadAll() {
        dbs.disc = await loadYAML('discdb.yaml');
        loaded.disc = true;
        console.log('[dB] discDB carregado:', Object.keys(dbs.disc).length, 'entradas');

        dbs.achievements = await loadYAML('achievement_hashlib.yaml');
        loaded.achievements = true;
        console.log('[dB] achievement_hashlib carregado:', Object.keys(dbs.achievements).length, 'entradas');

        dbs.games = await loadYAML('gamedb.yaml');
        loaded.games = true;
        console.log('[dB] gamedb carregado:', Object.keys(dbs.games).length, 'entradas');
    }

    // Funções de busca
    function findDisc(serial) {
        if (!loaded.disc) {
            console.warn('[dB] discDB ainda não carregado.');
            return null;
        }
        return dbs.disc[serial] || null;
    }

    function findAchievement(id) {
        if (!loaded.achievements) {
            console.warn('[dB] achievement_hashlib ainda não carregado.');
            return null;
        }
        return dbs.achievements[id] || null;
    }

    function findGame(id) {
        if (!loaded.games) {
            console.warn('[dB] gamedb ainda não carregado.');
            return null;
        }
        return dbs.games[id] || null;
    }

    // Integração com CDR
    function attachCDR(cdrModule) {
        if (!cdrModule) return console.warn('[dB] Módulo CDR não fornecido.');

        cdrModule.onDiscLoad = (serial) => {
            const entry = findDisc(serial);
            if (entry) {
                console.log('[dB] Disco reconhecido:', serial, entry);
                cdrModule.setDiscMetadata(entry);
            } else {
                console.warn('[dB] Disco não encontrado no discDB:', serial);
            }
        };
    }

    return {
        loadAll,
        findDisc,
        findAchievement,
        findGame,
        attachCDR
    };
})();

// Auto-load
DBManager.loadAll();

// Export
if (typeof window !== 'undefined') window.DBManager = DBManager;
if (typeof module !== 'undefined') module.exports = DBManager;