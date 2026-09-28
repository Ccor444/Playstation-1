/* menu.js — Menu modal Material 3 + seletor de qualidade HD + Efeitos ENB + Iniciar BIOS */
(scope => {
    'use strict';

    let modal = null;
    let openBtn = null;

    function makeEl(tag, cls, txt) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (txt !== undefined) e.textContent = txt;
        return e;
    }

    function makeItem(icon, label, onClick) {
        const item = makeEl('button', 'menu-item');
        item.type = 'button';
        item.appendChild(makeEl('span', 'menu-icon', icon));
        const lbl = makeEl('span', 'menu-label', label);
        item.appendChild(lbl);
        item.addEventListener('click', onClick);
        return { item, label: lbl };
    }

    // Grupo de qualidade HD (3 opções radio)
    function makeHDGroup() {
        const group = makeEl('div', 'menu-group');
        const title = makeEl('div', 'menu-group-title', 'Qualidade Gráfica');
        group.appendChild(title);

        const options = scope.settings.hdOptions;
        const current = scope.settings.hd;
        const rows = [];

        options.forEach(function (opt) {
            const row = makeEl('button', 'menu-radio' + (current === opt.id ? ' checked' : ''));
            row.type = 'button';

            const dot = makeEl('span', 'menu-radio-dot');
            const text = makeEl('span', 'menu-radio-text');
            const lbl = makeEl('span', 'menu-radio-label', opt.label);
            const desc = makeEl('span', 'menu-radio-desc', opt.desc);
            text.appendChild(lbl);
            text.appendChild(desc);

            row.appendChild(dot);
            row.appendChild(text);

            row.addEventListener('click', function () {
                if (scope.settings.hd === opt.id) return;

                scope.settings.setHD(opt.id);

                if (navigator.vibrate) {
                    try { navigator.vibrate(15); } catch (_) {}
                }

                rows.forEach(function (r) { r.classList.remove('checked'); });
                row.classList.add('checked');

                setTimeout(function () {
                    location.reload();
                }, 220);
            });

            group.appendChild(row);
            rows.push(row);
        });

        return group;
    }

    // ========================================================================
    // Grupo de Efeitos (ENB-style) — presets de pós-processamento
    // Não recarrega a página; aplica na hora via scope.applyPostFXPreset().
    // ========================================================================
    function makeENBGroup() {
        const group = makeEl('div', 'menu-group');
        const title = makeEl('div', 'menu-group-title', 'Efeitos (ENB)');
        group.appendChild(title);

        const presets = [
            { id: 'off',    label: 'Desligado',  desc: 'Pipeline PS1 original' },
            { id: 'crt',    label: 'CRT suave',  desc: 'Scanlines + nítido' },
            { id: 'cinema', label: 'Cinema',     desc: 'Bloom + vignette + gamma' },
            { id: 'sharp',  label: 'Nitidez HD', desc: 'Sharpen + saturação' },
            { id: 'retro',  label: 'Retro TV',   desc: 'Chromatic + scanlines' }
        ];

        const state = (typeof scope.getPostFXState === 'function')
            ? scope.getPostFXState()
            : { enabled: false };

        // Descobre qual preset bate com o estado atual (com tolerância)
        function currentPresetId() {
            if (!state.enabled) return 'off';
            const p = scope.POSTFX_PRESETS;
            if (!p) return null;
            function close(a, b) { return Math.abs((a || 0) - (b || 0)) < 0.02; }
            for (let i = 0; i < presets.length; ++i) {
                const id = presets[i].id;
                if (id === 'off') continue;
                const q = p[id];
                if (!q) continue;
                let match = true;
                for (const k in q) {
                    if (k === 'enabled') continue;
                    if (!close(state[k], q[k])) { match = false; break; }
                }
                if (match) return id;
            }
            return null; // custom
        }

        const activeId = currentPresetId();
        const rows = [];

        presets.forEach(function (opt) {
            const row = makeEl('button', 'menu-radio' + (activeId === opt.id ? ' checked' : ''));
            row.type = 'button';

            const dot  = makeEl('span', 'menu-radio-dot');
            const text = makeEl('span', 'menu-radio-text');
            const lbl  = makeEl('span', 'menu-radio-label', opt.label);
            const desc = makeEl('span', 'menu-radio-desc', opt.desc);
            text.appendChild(lbl);
            text.appendChild(desc);

            row.appendChild(dot);
            row.appendChild(text);

            row.addEventListener('click', function () {
                if (typeof scope.applyPostFXPreset !== 'function') {
                    console.warn('[menu] applyPostFXPreset indisponível');
                    return;
                }

                if (navigator.vibrate) {
                    try { navigator.vibrate(15); } catch (_) {}
                }

                scope.applyPostFXPreset(opt.id);

                rows.forEach(function (r) { r.classList.remove('checked'); });
                row.classList.add('checked');
            });

            group.appendChild(row);
            rows.push(row);
        });

        return group;
    }

    function build() {
        const overlay = makeEl('div', 'menu-modal hidden');
        const box = makeEl('div', 'menu-box');

        const header = makeEl('div', 'menu-header');
        header.appendChild(makeEl('h2', 'menu-title', '☰  Menu'));
        const closeBtn = makeEl('button', 'menu-close', '×');
        closeBtn.type = 'button';
        closeBtn.addEventListener('click', () => toggle(false));
        header.appendChild(closeBtn);
        box.appendChild(header);

        const list = makeEl('div', 'menu-list');

        // 0) Biblioteca de jogos (lê de pasta local)
        const lib = makeItem('📚', 'Biblioteca de Jogos', () => {
            toggle(false);
            if (scope.gameLibrary) scope.gameLibrary.show();
        });
        list.appendChild(lib.item);

        // 1) Carregar arquivo
        const loadInput = document.getElementById('file');
        const load = makeItem('📁', 'Carregar Jogo / BIOS', () => {
            if (loadInput) loadInput.click();
            toggle(false);
        });
        list.appendChild(load.item);

        // 1b) Iniciar BIOS — reboot sem recarregar a página
        const biosBtn = makeItem('💾', 'Iniciar BIOS', async () => {
            toggle(false);

            // Usa o helper exposto pelo index.js (lida com sentinel + flag)
            const biosLoaded = (typeof scope.isBiosLoaded === 'function')
                ? scope.isBiosLoaded()
                : false;

            if (!biosLoaded) {
                // Tenta baixar bios.bin; se falhar, abre o seletor manual
                if (typeof scope.loadBiosFromUrl === 'function') {
                    try {
                        await scope.loadBiosFromUrl('bios.bin');
                        // loadFileData já roda bios() ao carregar a BIOS
                        return;
                    } catch (e) {
                        console.warn('[BIOS] auto-load falhou:', e);
                    }
                }
                if (loadInput) loadInput.click();
                return;
            }

            if (!confirm('Iniciar a BIOS? O jogo atual será interrompido.')) return;

            if (typeof scope.bootBios === 'function') {
                try {
                    scope.bootBios();
                    if (navigator.vibrate) try { navigator.vibrate(20); } catch (_) {}
                } catch (e) {
                    console.error('[BIOS] boot falhou:', e);
                    alert('Não foi possível iniciar a BIOS: ' + (e && e.message ? e.message : e));
                }
            } else {
                console.warn('[BIOS] bootBios indisponível');
                alert('Função de boot indisponível.');
            }
        });
        list.appendChild(biosBtn.item);

        // 2) Teclado Virtual
        const pad = makeItem('🎮',
            'Teclado Virtual: ' + (scope.virtualPad.isVisible() ? 'ON' : 'OFF'),
            () => {
                const on = scope.virtualPad.toggle();
                pad.label.textContent = 'Teclado Virtual: ' + (on ? 'ON' : 'OFF');
            });
        list.appendChild(pad.item);

        // 3) Vibração
        const hap = makeItem('📳',
            'Vibração: ' + (scope.virtualPad.getHaptics() ? 'ON' : 'OFF'),
            () => {
                const on = !scope.virtualPad.getHaptics();
                scope.virtualPad.setHaptics(on);
                hap.label.textContent = 'Vibração: ' + (on ? 'ON' : 'OFF');
                if (on && navigator.vibrate) navigator.vibrate(20);
            });
        list.appendChild(hap.item);

        // 4) Qualidade Gráfica — 3 opções estilo app
        list.appendChild(makeHDGroup());

        // 4b) Efeitos (ENB) — presets de pós-processamento, sem reload
        list.appendChild(makeENBGroup());

        // 5) Silenciar
        const mute = makeItem('🔇', 'Silenciar Áudio', () => {
            if (scope.spu) scope.spu.silence();
            toggle(false);
        });
        list.appendChild(mute.item);

        // 6) Tela cheia
        const fs = makeItem('⛶', 'Tela Cheia', () => {
            if (document.fullscreenElement) {
                document.exitFullscreen();
            } else if (document.documentElement.requestFullscreen) {
                document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
            }
            toggle(false);
        });
        list.appendChild(fs.item);

        // 7) Reiniciar emulador
        const rst = makeItem('🔄', 'Reiniciar Emulador', () => {
            if (confirm('Reiniciar o emulador?')) location.reload();
        });
        list.appendChild(rst.item);

        box.appendChild(list);
        overlay.appendChild(box);
        overlay.addEventListener('click', e => { if (e.target === overlay) toggle(false); });

        document.body.appendChild(overlay);
        return overlay;
    }

    function toggle(force) {
        if (!modal) modal = build();
        const show = force !== undefined ? force : modal.classList.contains('hidden');
        if (show) modal.classList.remove('hidden');
        else modal.classList.add('hidden');
        return show;
    }

    function createButton() {
        const btn = makeEl('button', 'menu-open-btn', '☰');
        btn.id = 'menu-open-btn';
        btn.type = 'button';
        btn.title = 'Abrir Menu';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggle(true);
        });
        btn.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            if (navigator.vibrate) try { navigator.vibrate(12); } catch (_) {}
        });
        btn.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
        return btn;
    }

    function reanchor() {
        if (!openBtn) return;
        const slot = document.getElementById('vp-menu-slot');
        const padVisible = scope.virtualPad && scope.virtualPad.isVisible();
        if (slot && padVisible) {
            if (openBtn.parentNode !== slot) {
                openBtn.classList.add('in-slot');
                slot.appendChild(openBtn);
            }
        } else {
            if (openBtn.parentNode !== document.body) {
                openBtn.classList.remove('in-slot');
                document.body.appendChild(openBtn);
            }
        }
    }

    function injectCSS() {
        const s = document.createElement('style');
        s.textContent = `
/* =========================================================
   Modal
   ========================================================= */
.menu-modal {
    position: fixed; inset: 0; padding: 16px;
    background: rgba(0,0,0,0.62);
    backdrop-filter: blur(14px) saturate(140%);
    -webkit-backdrop-filter: blur(14px) saturate(140%);
    z-index: 500;
    display: flex; align-items: center; justify-content: center;
    box-sizing: border-box;
    animation: menuFadeIn .18s ease;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
.menu-modal.hidden { display: none; }
@keyframes menuFadeIn { from { opacity: 0; } to { opacity: 1; } }

.menu-box {
    background: linear-gradient(180deg, #262626 0%, #171717 100%);
    border: 1px solid #3a3a3a;
    border-radius: 22px;
    width: min(92vw, 460px); max-height: 88vh;
    display: flex; flex-direction: column;
    box-shadow:
        0 30px 70px rgba(0,0,0,0.85),
        inset 0 1px 0 rgba(255,255,255,0.08);
    overflow: hidden; color: #eee;
    animation: menuPop .25s cubic-bezier(.2,.9,.3,1.2);
}
@keyframes menuPop {
    from { opacity: 0; transform: scale(0.92) translateY(8px); }
    to   { opacity: 1; transform: scale(1)    translateY(0);   }
}

.menu-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 14px 18px;
    background: rgba(0,0,0,0.35);
    border-bottom: 1px solid #333;
}
.menu-title {
    margin: 0; font-size: 17px; font-weight: 700;
    color: #fff; letter-spacing: .6px;
}
.menu-close {
    background: transparent; border: none; color: #bbb;
    font-size: 26px; line-height: 1; cursor: pointer;
    padding: 0 8px; border-radius: 50%;
    transition: background .15s;
    font-family: inherit;
}
.menu-close:hover { background: rgba(220,60,60,0.4); color: #fff; }

.menu-list {
    padding: 10px;
    display: flex; flex-direction: column; gap: 6px;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
}

.menu-item {
    display: flex; align-items: center; gap: 14px;
    padding: 14px 16px;
    background: rgba(255,255,255,0.045);
    border: 1px solid transparent;
    border-radius: 14px;
    color: #eee; font-size: 15px; text-align: left;
    cursor: pointer; font-family: inherit; width: 100%;
    transition: background .15s, border-color .15s, transform .08s;
    box-sizing: border-box;
    -webkit-tap-highlight-color: transparent;
}
.menu-item:hover  { background: rgba(106,193,255,0.15); border-color: rgba(106,193,255,0.35); }
.menu-item:active { background: rgba(106,193,255,0.28); transform: scale(0.985); }

.menu-icon  { font-size: 20px; width: 28px; text-align: center; flex-shrink: 0; }
.menu-label { flex: 1; }

/* =========================================================
   Grupo "Qualidade Gráfica" / "Efeitos (ENB)" — radios
   ========================================================= */
.menu-group {
    margin: 6px 0 2px;
    padding: 12px;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.05);
    border-radius: 16px;
}
.menu-group-title {
    font-size: 11px;
    letter-spacing: 2.2px;
    text-transform: uppercase;
    color: #8a8a8a;
    font-weight: 700;
    padding: 2px 6px 8px;
}

.menu-radio {
    display: flex; align-items: center; gap: 12px;
    width: 100%;
    padding: 10px 12px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 12px;
    color: #ddd;
    font-family: inherit;
    font-size: 15px;
    text-align: left;
    cursor: pointer;
    transition: background .15s, border-color .15s;
    -webkit-tap-highlight-color: transparent;
}
.menu-radio:hover  { background: rgba(255,255,255,0.04); }
.menu-radio:active { background: rgba(106,193,255,0.15); }
.menu-radio.checked { background: rgba(106,193,255,0.10); }

.menu-radio-dot {
    width: 20px; height: 20px;
    border-radius: 50%;
    border: 2px solid #6a6a6a;
    flex-shrink: 0;
    position: relative;
    transition: border-color .15s, background .15s;
}
.menu-radio.checked .menu-radio-dot {
    border-color: #6ac1ff;
    background: #6ac1ff;
    box-shadow: 0 0 0 4px rgba(106,193,255,0.18);
}
.menu-radio.checked .menu-radio-dot::after {
    content: '';
    position: absolute;
    inset: 4px;
    background: #171717;
    border-radius: 50%;
}

.menu-radio-text {
    display: flex; flex-direction: column;
    line-height: 1.25;
    min-width: 0;
}
.menu-radio-label {
    font-weight: 600;
    color: #eee;
}
.menu-radio.checked .menu-radio-label { color: #fff; }
.menu-radio-desc {
    font-size: 12px;
    color: #8a8a8a;
    margin-top: 2px;
}

/* =========================================================
   Botão hamburguer
   ========================================================= */
.menu-open-btn {
    display: flex; align-items: center; justify-content: center;
    box-sizing: border-box; padding: 0;
    width: 13vh; height: 6.2vh;
    border-radius: 3.1vh;
    background:
        radial-gradient(circle at 50% 30%,
            rgba(255,255,255,0.14) 0%,
            rgba(40,40,40,0.55) 55%,
            rgba(15,15,15,0.70) 100%);
    border: 1.5px solid rgba(255,255,255,0.22);
    color: rgba(255,255,255,0.92);
    font-size: 20px; font-weight: 700;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    text-shadow: 0 1px 2px #000;
    cursor: pointer;
    touch-action: none;
    -webkit-tap-highlight-color: transparent;
    transition: transform .08s ease, background .08s ease, border-color .08s ease, box-shadow .12s ease;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.18),
        inset 0 -1px 0 rgba(0,0,0,0.5),
        0 4px 10px rgba(0,0,0,0.45);
}
.menu-open-btn:hover  { border-color: #fff; }
.menu-open-btn:active {
    background:
        radial-gradient(circle at 50% 30%,
            rgba(140,200,255,0.85) 0%,
            rgba(80,140,220,0.85) 60%,
            rgba(40,80,160,0.85) 100%);
    transform: scale(0.92);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.4),
                0 0 18px rgba(106,193,255,0.55);
}

.menu-open-btn:not(.in-slot) {
    position: fixed;
    top: max(12px, env(safe-area-inset-top));
    right: max(12px, env(safe-area-inset-right));
    z-index: 60;
    width: 48px; height: 48px;
    border-radius: 50%;
    font-size: 22px;
    background: rgba(20,20,20,0.7);
    box-shadow: 0 6px 20px rgba(0,0,0,0.6),
                inset 0 1px 0 rgba(255,255,255,0.15);
}
.menu-open-btn.in-slot { position: relative; }
`;
        document.head.appendChild(s);
    }

    scope.menu = {
        toggle,
        show: () => toggle(true),
        hide: () => toggle(false),
        reanchor,
    };

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) toggle(false);
    });

    injectCSS();

    function init() {
        if (!openBtn) openBtn = createButton();
        reanchor();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(init, 0));
    } else {
        setTimeout(init, 0);
    }

})(window);