/* virtualPad.js — Teclado virtual estilo emulador Android nativo */
(scope => {
    'use strict';

    const BUTTONS = {
        up:       { prop: 'lo', bit: 0x10, label: '▲' },
        right:    { prop: 'lo', bit: 0x20, label: '▶' },
        down:     { prop: 'lo', bit: 0x40, label: '▼' },
        left:     { prop: 'lo', bit: 0x80, label: '◀' },
        triangle: { prop: 'hi', bit: 0x10, label: '△', color: '#7fff7f' },
        circle:   { prop: 'hi', bit: 0x20, label: '○', color: '#ff7f7f' },
        cross:    { prop: 'hi', bit: 0x40, label: '✕', color: '#7f7fff' },
        square:   { prop: 'hi', bit: 0x80, label: '□', color: '#ff7fff' },
        l1:       { prop: 'hi', bit: 0x04, label: 'L1' },
        l2:       { prop: 'hi', bit: 0x01, label: 'L2' },
        r1:       { prop: 'hi', bit: 0x08, label: 'R1' },
        r2:       { prop: 'hi', bit: 0x02, label: 'R2' },
        select:   { prop: 'lo', bit: 0x01, label: 'SEL' },
        start:    { prop: 'lo', bit: 0x08, label: 'START' },
    };

    const activePtr = new Map();
    let root = null;
    let haptics = true;

    function buzz(ms) {
        if (!haptics) return;
        if (navigator.vibrate) {
            try { navigator.vibrate(ms); } catch (e) {}
        }
    }

    function press(name, on) {
        const cfg = BUTTONS[name];
        if (!cfg || !scope.joy || !scope.joy.devices) return;
        const dev = scope.joy.devices[0];
        if (!dev) return;
        if (on) dev[cfg.prop] &= ~cfg.bit;
        else    dev[cfg.prop] |= cfg.bit;
    }

    function releaseAll() {
        for (const n of Object.keys(BUTTONS)) press(n, false);
        activePtr.clear();
        if (root) root.querySelectorAll('.pressed').forEach(e => e.classList.remove('pressed'));
    }

    function makeBtn(name) {
        const cfg = BUTTONS[name];
        const e = document.createElement('div');
        e.className = `vp-btn vp-${name}`;
        e.dataset.button = name;
        e.textContent = cfg.label;
        if (cfg.color) e.style.color = cfg.color;

        e.addEventListener('pointerdown', ev => {
            ev.preventDefault();
            ev.stopPropagation();
            try { e.setPointerCapture(ev.pointerId); } catch (_) {}
            activePtr.set(ev.pointerId, name);
            e.classList.add('pressed');
            press(name, true);
            buzz(12);
        });

        const up = ev => {
            if (!activePtr.has(ev.pointerId)) return;
            activePtr.delete(ev.pointerId);
            e.classList.remove('pressed');
            press(name, false);
        };

        e.addEventListener('pointerup', up);
        e.addEventListener('pointercancel', up);
        e.addEventListener('lostpointercapture', up);
        e.addEventListener('contextmenu', ev => ev.preventDefault());
        e.addEventListener('touchstart', ev => ev.preventDefault(), { passive: false });
        e.addEventListener('touchend',   ev => ev.preventDefault(), { passive: false });

        return e;
    }

    function build() {
        const el = document.createElement('div');
        el.id = 'virtual-pad';
        el.className = 'virtual-pad hidden';

        const dpad = document.createElement('div');
        dpad.className = 'vp-area vp-dpad';
        ['up', 'left', 'right', 'down'].forEach(n => dpad.appendChild(makeBtn(n)));
        el.appendChild(dpad);

        const face = document.createElement('div');
        face.className = 'vp-area vp-face';
        ['triangle', 'square', 'circle', 'cross'].forEach(n => face.appendChild(makeBtn(n)));
        el.appendChild(face);

        const lsh = document.createElement('div');
        lsh.className = 'vp-area vp-shoulder vp-shoulder-left';
        lsh.appendChild(makeBtn('l2'));
        lsh.appendChild(makeBtn('l1'));
        el.appendChild(lsh);

        const rsh = document.createElement('div');
        rsh.className = 'vp-area vp-shoulder vp-shoulder-right';
        rsh.appendChild(makeBtn('r1'));
        rsh.appendChild(makeBtn('r2'));
        el.appendChild(rsh);

        const cen = document.createElement('div');
        cen.className = 'vp-area vp-center';
        cen.appendChild(makeBtn('select'));
        cen.appendChild(makeBtn('start'));

        const slot = document.createElement('span');
        slot.id = 'vp-menu-slot';
        slot.className = 'vp-menu-slot';
        cen.appendChild(slot);

        el.appendChild(cen);

        document.body.appendChild(el);
        return el;
    }

    function isVisible() { return !!root && !root.classList.contains('hidden'); }

    function toggle(force) {
        if (!root) root = build();
        const show = force !== undefined ? force : !isVisible();
        if (show) root.classList.remove('hidden');
        else { root.classList.add('hidden'); releaseAll(); }

        if (scope.settings) {
            scope.settings.virtualPad = show;
            localStorage.setItem('config', JSON.stringify(scope.settings));
        }
        if (scope.menu && typeof scope.menu.reanchor === 'function') scope.menu.reanchor();
        return show;
    }

    function injectCSS() {
        const s = document.createElement('style');
        s.textContent = `
.virtual-pad {
    position: fixed; inset: 0; z-index: 50;
    pointer-events: none;
    touch-action: none; user-select: none; -webkit-user-select: none;
    -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
    font-family: 'Segoe UI', Roboto, Arial, sans-serif; font-weight: 700;
}
.virtual-pad.hidden { display: none; }
.virtual-pad .vp-area { position: absolute; pointer-events: none; }

.virtual-pad .vp-btn {
    position: absolute; pointer-events: auto;
    display: flex; align-items: center; justify-content: center;
    background:
        radial-gradient(circle at 50% 30%,
            rgba(255,255,255,0.14) 0%,
            rgba(40,40,40,0.55) 55%,
            rgba(15,15,15,0.70) 100%);
    border: 1.5px solid rgba(255,255,255,0.22);
    border-radius: 50%;
    color: rgba(255,255,255,0.92);
    font-size: 20px;
    text-shadow: 0 1px 2px rgba(0,0,0,0.85);
    cursor: pointer;
    box-sizing: border-box;
    transition: transform .08s ease, background .08s ease, border-color .08s ease, box-shadow .12s ease;
    touch-action: none;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.18),
        inset 0 -1px 0 rgba(0,0,0,0.5),
        0 4px 10px rgba(0,0,0,0.45);
}
.virtual-pad .vp-btn.pressed {
    background:
        radial-gradient(circle at 50% 30%,
            rgba(140,200,255,0.85) 0%,
            rgba(80,140,220,0.85) 60%,
            rgba(40,80,160,0.85) 100%);
    border-color: rgba(255,255,255,0.95);
    transform: scale(0.92);
    box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.4),
        0 0 18px rgba(106,193,255,0.55),
        0 2px 6px rgba(0,0,0,0.5);
}

.virtual-pad .vp-dpad {
    left: max(2.5vh, env(safe-area-inset-left));
    bottom: max(2.5vh, env(safe-area-inset-bottom));
    width: 34vh; height: 34vh;
}
.virtual-pad .vp-dpad .vp-btn {
    width: 11.5vh; height: 11.5vh;
    border-radius: 2vh;
    font-size: 18px;
}
.virtual-pad .vp-up    { left: 11.5vh; top: 0; }
.virtual-pad .vp-left  { left: 0;      top: 11.5vh; }
.virtual-pad .vp-right { left: 23vh;   top: 11.5vh; }
.virtual-pad .vp-down  { left: 11.5vh; top: 23vh; }

.virtual-pad .vp-face {
    right: max(2.5vh, env(safe-area-inset-right));
    bottom: max(2.5vh, env(safe-area-inset-bottom));
    width: 34vh; height: 34vh;
}
.virtual-pad .vp-face .vp-btn { width: 11.5vh; height: 11.5vh; }
.virtual-pad .vp-triangle { left: 11.5vh; top: 0;      }
.virtual-pad .vp-circle   { left: 23vh;   top: 11.5vh; }
.virtual-pad .vp-cross    { left: 11.5vh; top: 23vh;   }
.virtual-pad .vp-square   { left: 0;      top: 11.5vh; }

.virtual-pad .vp-shoulder {
    top: max(1.8vh, env(safe-area-inset-top));
    display: flex; gap: 1.5vh;
}
.virtual-pad .vp-shoulder-left  { left: max(2.5vh, env(safe-area-inset-left)); }
.virtual-pad .vp-shoulder-right { right: max(2.5vh, env(safe-area-inset-right)); }
.virtual-pad .vp-shoulder .vp-btn {
    position: relative;
    width: 11.5vh; height: 6.2vh;
    border-radius: 1.2vh;
    font-size: 13px;
    letter-spacing: 1px;
}

.virtual-pad .vp-center {
    left: 50%;
    bottom: max(2.5vh, env(safe-area-inset-bottom));
    transform: translateX(-50%);
    display: flex; align-items: center; gap: 2vh;
    pointer-events: none;
}
.virtual-pad .vp-center .vp-btn {
    position: relative;
    width: 13vh; height: 6.2vh;
    border-radius: 3.1vh;
    font-size: 12px;
    letter-spacing: 1px;
}
.virtual-pad .vp-menu-slot {
    display: inline-flex; align-items: center; justify-content: center;
    pointer-events: auto;
}
`;
        document.head.appendChild(s);
    }

    function init() {
        root = build();
        const touch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
        const cfg = scope.settings && scope.settings.virtualPad;
        const shouldShow = cfg !== undefined ? cfg : touch;
        if (shouldShow) root.classList.remove('hidden');

        if (scope.menu && typeof scope.menu.reanchor === 'function') scope.menu.reanchor();

        if (touch) {
            window.addEventListener('orientationchange', () => {
                setTimeout(() => {
                    if (scope.menu && typeof scope.menu.reanchor === 'function') scope.menu.reanchor();
                    const want = scope.settings && scope.settings.virtualPad;
                    if (want !== false && root.classList.contains('hidden')) {
                        root.classList.remove('hidden');
                    }
                }, 250);
            });
        }
    }

    scope.virtualPad = {
        toggle,
        releaseAll,
        show: () => toggle(true),
        hide: () => toggle(false),
        isVisible,
        setHaptics: (on) => { haptics = !!on; },
        getHaptics: () => haptics,
    };

    injectCSS();

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

})(window);