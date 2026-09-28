(scope => {

	'use strict';

	let running = false;
	let canvas = undefined;

	const PSX_SPEED = 44100 * 768; // 33868800 cyles

	function abort() {
		console.error(Array.prototype.slice.call(arguments).join(' '));
		canvas.style.borderColor = 'red';
		running = false;
		spu.silence();
		throw 'abort';
	}

	let hasFocus = true;
	document.addEventListener("visibilitychange", function () {
		if (document.visibilityState === 'visible') {
			document.title = 'active';
			hasFocus = true;
		} else {
			document.title = 'paused';
			hasFocus = false;
			spu.silence();
		}
	});

	const context = {
		timeStamp: 0,
		realtime: 0,
		emutime: 0,
		counter: 0
	};

	function isTouchEnabled() {
		return ( 'ontouchstart' in window ) ||
			( navigator.maxTouchPoints > 0 ) ||
			( navigator.msMaxTouchPoints > 0 );
	}

	psx.addEvent(0, spu.event.bind(spu));
	dma.eventDMA0 = psx.addEvent(0, dma.completeDMA0.bind(dma));
	dma.eventDMA2 = psx.addEvent(0, dma.completeDMA2.bind(dma));
	dma.eventDMA3 = psx.addEvent(0, dma.completeDMA3.bind(dma));
	dma.eventDMA4 = psx.addEvent(0, dma.completeDMA4.bind(dma));
	dma.eventDMA6 = psx.addEvent(0, dma.completeDMA6.bind(dma));
	cdr.eventRead = psx.addEvent(0, cdr.completeRead.bind(cdr));
	cdr.eventCmd = psx.addEvent(0, cdr.completeCmd.bind(cdr));
	joy.eventIRQ = psx.addEvent(0, joy.completeIRQ.bind(joy));
	mdc.event = psx.addEvent(0, mdc.complete.bind(mdc));

	dot.event = psx.addEvent(0, dot.complete.bind(dot));

	let frameEvent = psx.addEvent(0, endMainLoop);
	let endAnimationFrame = false;
	function endMainLoop(self, clock) {
		endAnimationFrame = true;
		psx.unsetEvent(self);
	}

	function runFrame() {
		let entry = getCacheEntry(cpu.pc);
		if (!entry) return abort('invalid pc')

		handleGamePads();

		const $ = psx;
		while (!endAnimationFrame) {
			CodeTrace.add(entry);
			entry = entry.code($);

			if ($.clock >= $.eventClock) {
				entry = $.handleEvents(entry);
			}
		}
		cpu.pc = entry.pc;
	}

	function mainLoop(stamp) {
		const delta = stamp - context.timeStamp;
		context.timeStamp = stamp;
		if (!running || !hasFocus || delta > 250) return;

		context.realtime += delta;

		const diffTime = context.realtime - context.emutime;
		const totalCycles = diffTime * (PSX_SPEED / 1000);

		endAnimationFrame = false;
		psx.setEvent(frameEvent, +totalCycles);
		++context.counter;
		runFrame();

		context.emutime = psx.clock / (PSX_SPEED / 1000);
	}

	function emulate(stamp) {
		window.requestAnimationFrame(emulate);
		mainLoop(stamp);
	}

	function bios() {
		running = false;

		let entry = getCacheEntry(0xbfc00000);
		const $ = psx;
		while (entry.pc !== 0x00030000) {
			CodeTrace.add(entry);
			entry = entry.code($);

			if ($.clock >= $.eventClock) {
				entry = $.handleEvents(entry);
			}
		}
		context.realtime = context.emutime = psx.clock / (PSX_SPEED / 1000);
		vector = getCacheEntry(0x80);
		cpu.pc = entry.pc;
	}

	function openFile(file) {
		var reader = new FileReader();

		reader.onload = function (event) {
			console.log(escape(file.name), file.size);

			loadFileData(event.target.result)
		};

		reader.readAsArrayBuffer(file);
	}

	function loadFileData(arrayBuffer) {
		if ((arrayBuffer.byteLength & 3) !== 0) {
			var copy = new Uint8Array(arrayBuffer);
			var data = new MemoryBlock(((copy.length + 3) & ~3) >> 2);
			for (var i = 0; i < copy.length; ++i) {
				data.setInt8(i, copy[i]);
			}
		}
		else {
			var data = new MemoryBlock(arrayBuffer);
		}

		const view8 = new Int8Array(data.buffer);

		if ((data[0] & 0xffff) === 0x5350) { // PS
			cpu.pc = data.getInt32(0x10);
			cpu.gpr[28] = data.getInt32(0x14);
			cpu.gpr[29] = data.getInt32(0x30);
			cpu.gpr[30] = data.getInt32(0x30);
			cpu.gpr[31] = cpu.pc;
			console.log('init-pc  : $', hex(cpu.pc >>> 0));
			console.log('init-gp  : $', hex(cpu.gpr[28] >>> 0));
			console.log('init-sp  : $', hex(cpu.gpr[29] >>> 0));
			console.log('init-fp  : $', hex(cpu.gpr[30] >>> 0));
			console.log('init-of  : $', hex(data.getInt32(0x34) >>> 0));
			console.log('text-addr: $', hex(data.getInt32(0x18) >>> 0));
			console.log('text-size: $', hex(data.getInt32(0x1C) >>> 0));
			console.log('data-addr: $', hex(data.getInt32(0x20) >>> 0));
			console.log('data-size: $', hex(data.getInt32(0x24) >>> 0));

			var textSegmentOffset = data.getInt32(0x18);
			var fileContentLength = data.getInt32(0x1C);
			for (var i = 0; i < fileContentLength; ++i) {
				map8[(textSegmentOffset & 0x001fffff) >>> 0] = view8[(0x800 + i) >>> 0];
				textSegmentOffset++;
			}

			clearCodeCache(data.getInt32(0x18), view8.length);
			running = true;
		}
		else if (data[0] === (0xffffff00 >> 0)) { // ISO
			// auto build TOC (attempt to not need .cue files)
			let loc = 0;
			let lastLoc = data.length / (2352 / 4);
			let type = 0; // data
			let tracks = [];

			tracks.push({ id: 0, begin: 0, end: lastLoc });
			const sectorLength = 2352;
			function isDataSector(startLoc) {
				let mask1 = data.getInt32(startLoc * sectorLength + 0) >>> 0;
				let mask2 = data.getInt32(startLoc * sectorLength + 4) >>> 0;
				let mask3 = data.getInt32(startLoc * sectorLength + 8) >>> 0;
				return (mask1 === 0xffffff00 && mask2 === 0xffffffff && mask3 === 0x00ffffff);
			}

			function isEmptySector(startLoc) {
				let mask = 0;
				for (let i = 0; i < sectorLength; i += 4) {
					mask |= data.getInt32(startLoc * sectorLength + i);
				}
				return (mask >>> 0) === (0x00000000 >>> 0);
			}

			let begin, end, lead, track = 0;

			let i = 0;
			begin = i;
			while ((i < lastLoc) && isDataSector(i)) ++i;
			end = i;
			while ((i < lastLoc) && isEmptySector(i)) ++i;
			tracks.push({ id: 1, begin, end, data: true });

			let id = 2;
			if (i < lastLoc) {
				begin = i;
				while (i < lastLoc) {
					while ((i < lastLoc) && !isEmptySector(i)) ++i;
					end = i;
					while ((i < lastLoc) && isEmptySector(i)) ++i;
					lead = i;
					if ((lead - end) < 75) continue;
					tracks.push({ id, begin, end, audio: true });
					begin = i;
					id++;
				}
				if (begin < lastLoc) {
					end = lead = lastLoc
					tracks.push({ id, begin, end, audio: true });
				}
			}
			cdr.setCdImage(data);
			cdr.setTOC(tracks);

			running = true;
		}
		else if (data[0] === 0x0000434d) { // MEMCARD
			console.log('loaded MEMCARD');
			var copy = new Uint8Array(arrayBuffer);
			let card = joy.devices ? joy.devices[0].data : joy.cardOneMemory;
			for (var i = 0; i < copy.length; ++i) {
				card[i] = copy[i];
			}
		}
		else if (arrayBuffer.byteLength >= 0x00080000) {
			// ---------- BIOS ----------
			var BIOS_MAX = 0x00400000; // 4 MB

			var biosBuffer;
			if (arrayBuffer.byteLength > BIOS_MAX) {
				biosBuffer = arrayBuffer.slice(0, BIOS_MAX);
			}
			else {
				biosBuffer = arrayBuffer;
			}

			writeStorageStream('bios', biosBuffer);

			var bios32 = new Int32Array(biosBuffer);
			var biosSize = biosBuffer.byteLength;
			for (var i = 0; i < biosSize; i += 4) {
				map[(0x01c00000 + i) >>> 2] = bios32[i >>> 2];
			}

			scope.__biosLoaded = true;    // ← flag explícita

			bios();

			var header = document.querySelector('header > span');
			if (header) {
				header.classList.remove('nobios');
			}
		}
		else {
			abort('Unsupported fileformat');
		}
	}

	function handleFileSelect(evt) {
		evt.stopPropagation();
		evt.preventDefault();

		const fileList = evt.dataTransfer ? evt.dataTransfer.files : evt.target.files;

		var output = [];
		for (var i = 0, f; f = fileList[i]; i++) {
			openFile(f);
		}
	}

	function handleDragOver(evt) {
		evt.stopPropagation();
		evt.preventDefault();
	}

	// ============================================================================
	// [ENB-style] Estado persistente do pós-processamento
	// ============================================================================
	const POSTFX_DEFAULTS = {
		enabled:        false,
		bloom:          0.0,
		bloomThreshold: 0.7,
		saturation:     1.0,
		contrast:       1.0,
		brightness:     0.0,
		gamma:          1.0,
		vignette:       0.0,
		scanlines:      0.0,
		sharpen:        0.0,
		chromatic:      0.0
	};

	// Garante que scope.POSTFX existe (webGlHQ.js já cria, mas por segurança)
	if (typeof scope.POSTFX === 'undefined' || !scope.POSTFX) {
		scope.POSTFX = Object.assign({}, POSTFX_DEFAULTS);
	} else {
		for (let k in POSTFX_DEFAULTS) {
			if (typeof scope.POSTFX[k] === 'undefined') {
				scope.POSTFX[k] = POSTFX_DEFAULTS[k];
			}
		}
	}

	// Presets prontos (usados pelo menu / console)
	scope.POSTFX_PRESETS = {
		off:     { enabled: false },
		crt:     { enabled: true, bloom:0.0, saturation:1.0, contrast:1.05, brightness:0.0, gamma:1.0, vignette:0.15, scanlines:0.20, sharpen:0.35, chromatic:0.0 },
		cinema:  { enabled: true, bloom:0.5, bloomThreshold:0.75, saturation:0.9, contrast:1.10, brightness:0.0, gamma:1.05, vignette:0.45, scanlines:0.0, sharpen:0.1, chromatic:0.0 },
		sharp:   { enabled: true, bloom:0.0, saturation:1.15, contrast:1.05, brightness:0.0, gamma:1.0, vignette:0.0, scanlines:0.0, sharpen:0.6, chromatic:0.0 },
		retro:   { enabled: true, bloom:0.15, saturation:1.05, contrast:1.05, brightness:0.02, gamma:1.05, vignette:0.5, scanlines:0.35, sharpen:0.1, chromatic:0.6 }
	};

	scope.loadPostFX = function () {
		readStorageStream('postfx', data => {
			if (!data) return;
			try {
				let bytes = (data instanceof ArrayBuffer) ? new Uint8Array(data) : data;
				let text  = new TextDecoder().decode(bytes);
				let obj   = JSON.parse(text);
				for (let k in POSTFX_DEFAULTS) {
					if (Object.prototype.hasOwnProperty.call(obj, k)) {
						scope.POSTFX[k] = obj[k];
					}
				}
				// Se o renderer já existir, empurra na hora
				if (scope.renderer && typeof scope.renderer.setPostFX === 'function') {
					scope.renderer.setPostFX(scope.POSTFX);
				}
				console.log('[POSTFX] carregado:', scope.POSTFX);
			} catch (e) {
				console.warn('[POSTFX] falha ao carregar:', e);
			}
		});
	};

	scope.savePostFX = function () {
		try {
			let text  = JSON.stringify(scope.POSTFX);
			let bytes = new TextEncoder().encode(text);
			let ab    = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
			writeStorageStream('postfx', ab);
		} catch (e) {
			console.warn('[POSTFX] falha ao salvar:', e);
		}
	};

	// Aplica (merge) novos valores + salva + empurra para o renderer
	scope.applyPostFX = function (opts, persist) {
		if (opts) {
			for (let k in opts) {
				if (Object.prototype.hasOwnProperty.call(opts, k)) {
					scope.POSTFX[k] = opts[k];
				}
			}
		}
		if (scope.renderer && typeof scope.renderer.setPostFX === 'function') {
			scope.renderer.setPostFX(scope.POSTFX);
		}
		if (persist !== false) scope.savePostFX();
		return scope.POSTFX;
	};

	scope.applyPostFXPreset = function (name) {
		let p = scope.POSTFX_PRESETS[name];
		if (!p) {
			console.warn('[POSTFX] preset desconhecido:', name);
			return scope.POSTFX;
		}
		// Se o preset for "off", desliga; senão liga
		let merged = Object.assign({}, p);
		if (name !== 'off') merged.enabled = true;
		return scope.applyPostFX(merged, true);
	};

	scope.getPostFXState = function () {
		return scope.POSTFX;
	};

	scope.togglePostFX = function () {
		return scope.applyPostFX({ enabled: !scope.POSTFX.enabled }, true);
	};

	// ============================================================================
	// Fim da seção POSTFX
	// ============================================================================

	function init() {

		canvas = document.getElementById('display');

		document.addEventListener('dragover', handleDragOver, false);
		document.addEventListener('drop', handleFileSelect, false);
		document.getElementById('file').addEventListener('change', handleFileSelect, false);

		settings.updateQuality();

		document.getElementById('quality').addEventListener('click', evt => {
			settings.updateQuality(true);

			evt.stopPropagation();
			evt.preventDefault();
			return false;
		});

		emulate(performance.now());

		renderer = new WebGLRenderer(canvas);

		// [ENB] Carrega preferências salvas e aplica no renderer recém-criado
		scope.loadPostFX();
		scope.applyPostFX(null, false); // empurra o estado atual (defaults ou recém-lido)

		// Duplo-clique (desktop) pausa/despausa. Toque no canvas NÃO pausa —
		// o toque é reservado para o teclado virtual.
		canvas.addEventListener("dblclick", function (e) {
			running = !running;
			if (!running) {
				spu.silence();
			}
		});

		window.addEventListener("keydown", function (e) {
			if (e.key === 'F12') return; // allow developer tools
			if (e.key === 'F11') return; // allow full screen
			if (e.key === 'F5') return; // allow page refresh
			e.preventDefault();
		}, false);

		window.addEventListener("keyup", function (e) {
			if (e.key === '1' && e.ctrlKey) renderer.setMode('disp');
			if (e.key === '2' && e.ctrlKey) renderer.setMode('draw');
			if (e.key === '3' && e.ctrlKey) renderer.setMode('clut8');
			if (e.key === '4' && e.ctrlKey) renderer.setMode('clut4');
			if (e.key === '0' && e.ctrlKey) renderer.setMode('page2');

			// [ENB] Ctrl+Shift+P alterna o pós-processamento rapidamente
			if (e.key === 'P' && e.ctrlKey && e.shiftKey) {
				scope.togglePostFX();
				console.log('[POSTFX] enabled =', scope.POSTFX.enabled);
			}

			if (e.key === 'F12') return; // allow developer tools
			if (e.key === 'F11') return; // allow full screen
			if (e.key === 'F5') return; // allow page refresh
			e.preventDefault();
		}, false);

		readStorageStream('bios', data => {
			if (data) {
				var data32 = new Uint32Array(data);
				var size = data.byteLength;
				var max = 0x00400000;
				if (size > max) size = max;
				for (var i = 0; i < size; i += 4) {
					map[(0x01c00000 + i) >>> 2] = data32[i >>> 2];
				}
				scope.__biosLoaded = true;   // ← flag explícita também aqui

				let header = document.querySelector('header > span');
				if (header) {
					header.classList.remove('nobios');
				}
				bios();
			}
		});
		readStorageStream('card1', data => {
			if (data) {
				let data8 = new Uint8Array(data);
				console.log('loading card1', data8.length);
				for (let i = 0; i < 128 * 1024; ++i) {
					joy.devices[0].data[i] = data8[i];
				}
			}
		});
		readStorageStream('card2', data => {
			if (data) {
				let data8 = new Uint8Array(data);
				console.log('loading card2', data8.length);
				for (let i = 0; i < 128 * 1024; ++i) {
					joy.devices[1].data[i] = data8[i];
				}
			}
		});
	}

	// Exposto para o bootstrap auto-carregar a BIOS via fetch.
	// Reutiliza todo o pipeline de loadFileData (detecção, storage, boot).
	scope.loadBiosFromUrl = function (url) {
		return fetch(url, { cache: 'no-cache' }).then(function (res) {
			if (!res.ok) throw new Error('HTTP ' + res.status);
			return res.arrayBuffer();
		}).then(function (arrayBuffer) {
			loadFileData(arrayBuffer);
			return true;
		});
	};

	// Verifica se a BIOS já está mapeada em memória.
	// Usa flag explícita + sentinela (nobios) como fallback.
	function isBiosLoaded() {
		if (scope.__biosLoaded === true) return true;
		var headerSpan = document.querySelector('header > span');
		return !!(headerSpan && !headerSpan.classList.contains('nobios'));
	}

	// Exposto para o menu reiniciar a BIOS sem recarregar a página.
	scope.bootBios = function () {
		console.log('[bootBios] solicitado');

		if (!isBiosLoaded()) {
			console.warn('[bootBios] BIOS não está na memória');
			throw new Error('BIOS não carregada');
		}

		// Pausa o loop enquanto resetamos o estado
		running = false;

		// Reseta o estado da CPU para o vetor de reset
		cpu.pc = 0xbfc00000;
		cpu.gpr.fill(0);
		cpu.gpr[29] = 0x801FFFF0;   // stack pointer padrão da BIOS
		cpu.hi = 0;
		cpu.lo = 0;
		cpu.sr = 0;
		cpu.cause = 0;
		cpu.epc = 0;
		cpu.istat = 0;
		cpu.imask = 0;
		cpu.forceWriteBits = 0;

		// Reseta controladores virtuais (evita botões "grudados")
		try {
			if (scope.joy && scope.joy.devices) {
				for (var d = 0; d < scope.joy.devices.length; ++d) {
					var dev = scope.joy.devices[d];
					dev.lo = 0xff;
					dev.hi = 0xff;
					dev.initController();
					dev.initMemCard();
				}
			}
			if (scope.joy) {
				scope.joy.command = 0;
				scope.joy.r1044 = 0x0005;
				scope.joy.r104a = 0;
			}
		} catch (e) { console.warn('[bootBios] reset joy falhou:', e); }

		// Para qualquer leitura de CD em andamento
		try {
			if (scope.cdr && typeof scope.cdr.stopReading === 'function') {
				scope.cdr.stopReading();
			}
		} catch (e) { console.warn('[bootBios] reset cdr falhou:', e); }

		// Limpa o cache do recompilador — garante recompilação da BIOS do zero
		try {
			if (scope.cached && typeof scope.cached.clear === 'function') {
				scope.cached.clear();
				console.log('[bootBios] cached limpo');
			}
			if (scope.fastCache && typeof scope.fastCache.fill === 'function') {
				scope.fastCache.fill(0);
				console.log('[bootBios] fastCache limpo');
			}
		} catch (e) { console.warn('[bootBios] limpar cache falhou:', e); }

		// Reexecuta o boot da BIOS (roda até PC == 0x00030000)
		console.log('[bootBios] rodando bios()...');
		bios();
		console.log('[bootBios] concluído. cpu.pc=$' + hex(cpu.pc >>> 0));

		running = true;
		return true;
	};

	scope.init = init;
	scope.PSX_SPEED = PSX_SPEED;
	scope.renderer = undefined;
	scope.abort = abort;
	scope.context = context;
	scope.loadFileData = loadFileData;   // expõe para gameLibrary.js
	scope.isBiosLoaded = isBiosLoaded;   // expõe para o menu

})(window);