/*
  VirtualGamepad Avançado (v2 - Refatorado para Classe)
  - Padrão de Classe com campos privados
  - Delegação de eventos para botões dinâmicos
  - Rastreamento de PointerID para multi-toque e "drag-off"
  - Totalmente configurável via construtor
*/
class VirtualGamepad {
  
  // --- Configuração Padrão ---
  static DEFAULT_CONFIG = {
    debug: false,
    safeReset: true,
    deviceIndex: 0,
    buttonMap: {
      up:       { byte: 'lo', mask: 0x10 },
      down:     { byte: 'lo', mask: 0x40 },
      left:     { byte: 'lo', mask: 0x80 },
      right:    { byte: 'lo', mask: 0x20 },
      select:   { byte: 'lo', mask: 0x01 },
      start:    { byte: 'lo', mask: 0x08 },
      triangle: { byte: 'hi', mask: 0x10 },
      circle:   { byte: 'hi', mask: 0x20 },
      cross:    { byte: 'hi', mask: 0x40 },
      square:   { byte: 'hi', mask: 0x80 },
      l1:       { byte: 'hi', mask: 0x04 },
      l2:       { byte: 'hi', mask: 0x01 },
      r1:       { byte: 'hi', mask: 0x08 },
      r2:       { byte: 'hi', mask: 0x02 },
      l3:       { byte: 'aux', mask: 0x01 },
      r3:       { byte: 'aux', mask: 0x02 }
    },
    // Mapeamento de teclado (KeyCode -> Config)
    keyboardMap: {
      69: { bits: 0x10, property: 'hi' }, // E -> triangle
      68: { bits: 0x20, property: 'hi' }, // D -> circle
      88: { bits: 0x40, property: 'hi' }, // X -> cross
      83: { bits: 0x80, property: 'hi' }, // S -> square
      81: { bits: 0x01, property: 'hi' }, // Q -> l2
      84: { bits: 0x02, property: 'hi' }, // T -> r2
      87: { bits: 0x04, property: 'hi' }, // W -> l1
      82: { bits: 0x08, property: 'hi' }, // R -> r1
      38: { bits: 0x10, property: 'lo' }, // ↑
      39: { bits: 0x20, property: 'lo' }, // →
      40: { bits: 0x40, property: 'lo' }, // ↓
      37: { bits: 0x80, property: 'lo' }, // ←
      32: { bits: 0x01, property: 'lo' }, // espaço -> select
      13: { bits: 0x08, property: 'lo' }  // enter -> start
    },
    preventKeys: [32, 37, 38, 39, 40]
  };

  // --- Campos Privados ---
  #config;
  #buttonMap;
  #keyboardMap;
  #preventKeys;
  #debug;
  #safeReset;
  #targetDeviceIndex;
  
  // Estado: Rastreia qual pointer (dedo/mouse) está em qual botão
  // Map<pointerId, buttonId>
  #activePointers = new Map();

  constructor(config = {}) {
    // Mescla a configuração padrão com a fornecida
    this.#config = { ...VirtualGamepad.DEFAULT_CONFIG, ...config };
    this.#buttonMap = this.#config.buttonMap;
    this.#debug = this.#config.debug;
    this.#safeReset = this.#config.safeReset;
    this.#targetDeviceIndex = this.#config.deviceIndex;

    // Constrói os mapas internos
    this.#keyboardMap = new Map(Object.entries(this.#config.keyboardMap).map(([k, v]) => [Number(k), v]));
    this.#preventKeys = new Set(this.#config.preventKeys);
  }

  // --- ------------------------ ---
  // --- Métodos de Logging e Utilitários ---
  // --- ------------------------ ---
  #log(...args) { if (this.#debug) console.log('[Gamepad]', ...args); }
  #warn(...args) { console.warn('[Gamepad]', ...args); }

  #getDevice() {
    if (window.joy && Array.isArray(joy.devices)) {
      return joy.devices[this.#targetDeviceIndex] || null;
    }
    return null;
  }

  #ensureInit(dev, byte) {
    if (dev[byte] === undefined) dev[byte] = 0xff;
  }

  #callHandleGamePads() {
    try {
      if (typeof handleGamePads === 'function') handleGamePads();
    } catch (err) {
      this.#warn('handleGamePads ausente:', err);
    }
  }

  #pressButton(dev, byte, mask) {
    this.#ensureInit(dev, byte);
    dev[byte] &= ~mask;
    this.#callHandleGamePads();
  }

  #releaseButton(dev, byte, mask) {
    this.#ensureInit(dev, byte);
    dev[byte] |= mask;
    this.#callHandleGamePads();
  }

  // --- ------------------------ ---
  // --- Lógica de Input (Botões) ---
  // --- ------------------------ ---

  // Encontra o ID do botão a partir do evento, subindo na árvore DOM
  #getButtonIdFromEvent(e) {
    let target = e.target;
    while (target && target !== document.body) {
      if (target.id && this.#buttonMap[target.id]) {
        return target.id;
      }
      target = target.parentElement;
    }
    return null;
  }

  // Verifica se um botão virtual está sendo pressionado por *algum* pointer
  #isButtonPressed(buttonId) {
    for (const id of this.#activePointers.values()) {
      if (id === buttonId) return true;
    }
    return false;
  }

  #handlePointerDown(e) {
    const buttonId = this.#getButtonIdFromEvent(e);
    if (!buttonId) return;

    e.preventDefault(); // Previne zoom, scroll, etc.
    const dev = this.#getDevice();
    if (!dev) return;

    // Extrai o ID único do pointer (para mouse ou toque)
    const pointerId = e.pointerId ?? e.changedTouches?.[0]?.identifier;
    if (pointerId === undefined) return; // Não é possível rastrear

    // Se este pointer já está pressionando algo, ignora (evita processamento duplicado)
    if (this.#activePointers.has(pointerId)) return;

    const { byte, mask } = this.#buttonMap[buttonId];

    // Só envia o "press" virtual se o botão não estava pressionado por *nenhum outro* pointer
    if (!this.#isButtonPressed(buttonId)) {
      this.#pressButton(dev, byte, mask);
      this.#log('Pressionado:', buttonId);
    }

    // Associa este pointer a este botão
    this.#activePointers.set(pointerId, buttonId);
  }

  #handlePointerRelease(e) {
    const pointerId = e.pointerId ?? e.changedTouches?.[0]?.identifier;
    if (pointerId === undefined || !this.#activePointers.has(pointerId)) {
      return; // Este pointer não estava sendo rastreado
    }

    const buttonId = this.#activePointers.get(pointerId);
    this.#activePointers.delete(pointerId); // Libera o pointer

    // Verifica se algum *outro* pointer ainda está segurando o *mesmo* botão
    if (this.#isButtonPressed(buttonId)) {
      return; // Não solta o botão virtual ainda (suporte a multi-toque)
    }

    // Este foi o último pointer no botão. Solta o botão virtual.
    const dev = this.#getDevice();
    if (!dev) return;

    const { byte, mask } = this.#buttonMap[buttonId];
    this.#releaseButton(dev, byte, mask);
    this.#log('Solto:', buttonId);
  }

  // --- -------------------------- ---
  // --- Lógica de Input (Teclado) ---
  // --- -------------------------- ---

  #handleKeyDown(e) {
    const m = this.#keyboardMap.get(e.keyCode);
    const dev = this.#getDevice();
    if (!m || !dev) return;

    this.#ensureInit(dev, m.property);
    dev[m.property] &= ~m.bits;
    this.#callHandleGamePads();
    if (this.#preventKeys.has(e.keyCode)) e.preventDefault();
  }

  #handleKeyUp(e) {
    const m = this.#keyboardMap.get(e.keyCode);
    const dev = this.#getDevice();
    if (!m || !dev) return;

    this.#ensureInit(dev, m.property);
    dev[m.property] |= m.bits;
    this.#callHandleGamePads();
  }

  // --- ----------------- ---
  // --- Métodos de Inicialização ---
  // --- ----------------- ---

  #initButtonListeners() {
    this.#log('Iniciando listeners de botões (via delegação global)');
    
    // Escuta "down" no body (para capturar cliques em botões)
    document.body.addEventListener('pointerdown', this.#handlePointerDown.bind(this));
    document.body.addEventListener('touchstart', this.#handlePointerDown.bind(this), { passive: false });

    // Escuta "up" no documento *inteiro* (para capturar solturas fora do botão)
    document.addEventListener('pointerup', this.#handlePointerRelease.bind(this));
    document.addEventListener('pointercancel', this.#handlePointerRelease.bind(this));
    document.addEventListener('touchend', this.#handlePointerRelease.bind(this), { passive: false });
    document.addEventListener('touchcancel', this.#handlePointerRelease.bind(this));

    // Previne menu de contexto nos botões
    document.body.addEventListener('contextmenu', e => {
      if (this.#getButtonIdFromEvent(e)) e.preventDefault();
    });
  }

  #initKeyboardListeners() {
    this.#log('Iniciando listeners de teclado.');
    window.addEventListener('keydown', this.#handleKeyDown.bind(this));
    window.addEventListener('keyup', this.#handleKeyUp.bind(this));
  }

  #initSafetyListeners() {
    if (!this.#safeReset) return;
    this.#log('Iniciando listener de segurança (blur).');
    window.addEventListener('blur', () => {
      this.#log('Reset de segurança executado (blur).');
      this.reset();
      // Limpa rastreamento de pointers para evitar botões presos
      this.#activePointers.clear();
    });
  }

  #initDeviceObserver() {
    if (this.#getDevice()) {
      this.#log('Dispositivo `joy` já disponível.');
      return;
    }
    if (!window.joy) {
      this.#warn('Global `joy` não encontrado. Auto-detect pode falhar.');
      return;
    }
    
    this.#log('Aguardando dispositivo `joy` via MutationObserver...');
    const observer = new MutationObserver(() => {
      const dev = this.#getDevice();
      if (dev) {
        this.#log('Dispositivo detectado via MutationObserver:', dev);
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // --- ----------------- ---
  // --- API Pública ---
  // --- ----------------- ---

  /** Pressiona um botão virtual por ID. */
  press(id) {
    const map = this.#buttonMap[id];
    const dev = this.#getDevice();
    if (!map || !dev) return;
    this.#pressButton(dev, map.byte, map.mask);
    this.#log('API press:', id);
  }

  /** Solta um botão virtual por ID. */
  release(id) {
    const map = this.#buttonMap[id];
    const dev = this.#getDevice();
    if (!map || !dev) return;
    this.#releaseButton(dev, map.byte, map.mask);
    this.#log('API release:', id);
  }

  /** Reseta todos os inputs (lo, hi, aux) para 0xff. */
  reset() {
    const dev = this.#getDevice();
    if (!dev) return;
    // Reseta apenas os bytes que já foram inicializados
    if (dev.lo !== undefined) dev.lo = 0xff;
    if (dev.hi !== undefined) dev.hi = 0xff;
    if (dev.aux !== undefined) dev.aux = 0xff;
    this.#callHandleGamePads();
    this.#log('API reset: Todos os inputs resetados.');
  }

  /** Inicia todos os listeners e observadores. */
  init() {
    const ready = () => {
      this.#log('DOM pronto. Iniciando listeners...');
      this.#initButtonListeners();
      this.#initKeyboardListeners();
      this.#initSafetyListeners();
      this.#initDeviceObserver();
      this.#log('Sistema de controle virtual pronto.');
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', ready);
    } else {
      ready();
    }
    return this; // Permite encadeamento
  }
}

// ------------------------------
// Inicialização
// ------------------------------
(() => {
  // Instancia o gamepad
  const gamepad = new VirtualGamepad({
    debug: false // Ative para logs detalhados
  }).init();
  
  // Expõe a instância para o mundo exterior
  window.VirtualGamepad = gamepad;
})();
