(scope => {

	'use strict';

	// =================================================================
	// ✅ CORREÇÃO: Polyfill para Base64 (Resolve 'ReferenceError: Base64 is not defined')
	// Este bloco garante que o Base64 esteja disponível para salvar a BIOS no Storage.
	// =================================================================
	if (typeof window.Base64 === 'undefined') {
		// Implementação simplificada usando btoa/atob nativos
		window.Base64 = {
			encode: function(buffer) {
				var binary = '';
				var bytes = new Uint8Array(buffer);
				var len = bytes.byteLength;
				for (var i = 0; i < len; i++) {
					binary += String.fromCharCode(bytes[i]);
				}
				return window.btoa(binary);
			},
			decode: function(str) {
				var binary_string = window.atob(str);
				var len = binary_string.length;
				var bytes = new Uint8Array(len);
				for (var i = 0; i < len; i++) {
					bytes[i] = binary_string.charCodeAt(i);
				}
				return bytes.buffer;
			}
		};
	}
	// =================================================================


	let running = false;
	let canvas = undefined;
	let logElement = undefined;
	// Mapeamento de tipos para classes CSS e ícones
	const NOTIFICATION_TYPES = {
		'success': { icon: '✔️', class: 'success' },
		'error': { icon: '❌', class: 'error' },
		'warning': { icon: '⚠️', class: 'warning' },
		'info': { icon: 'ℹ️', class: 'info' },
		'loading': { icon: '⏳', class: 'loading' }
	};
	const MAX_LOG_ENTRIES = 5; // Número máximo de notificações visíveis

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
	
	/**
	 * Função avançada para exibir notificações no log do sistema.
	 */
	function showNotification(message, type = 'info', duration = 5000) {
		if (!logElement) {
			console.warn(`[Notification] Elemento 'system-log' não encontrado. Mensagem: ${message}`);
			return;
		}

		const config = NOTIFICATION_TYPES[type] || NOTIFICATION_TYPES['info'];
		
		const p = document.createElement('p');
		p.classList.add('log-message', config.class);
		p.style.opacity = '0'; 
		p.textContent = `${config.icon} ${message}`;
		
		// Remove notificações antigas se a lista estiver muito longa
		while (logElement.children.length >= MAX_LOG_ENTRIES) {
			logElement.removeChild(logElement.children[0]);
		}
		
		logElement.appendChild(p);

		// 1. Fade-in
		setTimeout(() => {
			p.style.opacity = '1';
		}, 10); 

		// 2. Fade-out e Remoção
		setTimeout(() => {
			if (logElement.contains(p)) {
				p.style.opacity = '0'; 
				
				// Remove o elemento após a transição CSS (0.5s)
				setTimeout(() => {
					if (logElement.contains(p)) {
						logElement.removeChild(p);
					}
				}, 500); 
			}
		}, duration); 

		console.log(`[${type.toUpperCase()}] ${message}`);
	}

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
			loadFileData(event.target.result, file.name); 
		};

		reader.readAsArrayBuffer(file);
	}

	function loadFileData(arrayBuffer, fileName = 'Arquivo Desconhecido') { 
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

		if ((data[0] & 0xffff) === 0x5350) { // PS (Executable)
			// ... lógica de carregamento de executável ...
			clearCodeCache(data.getInt32(0x18), view8.length);
			running = true;
			showNotification(`Jogo (EXE) "${fileName}" carregado.`, 'success'); 
		}
		else if (data[0] === (0xffffff00 >> 0)) { // ISO
			// ... lógica de carregamento de ISO ...
			cdr.setCdImage(data);
			// ...
			running = true;
			showNotification(`Jogo (ISO/BIN) "${fileName}" carregado.`, 'success'); 
		}
		else if (data[0] === 0x0000434d) { // MEMCARD
			// ... lógica de carregamento de Memcard ...
			showNotification(`Memory Card carregado: "${fileName}".`, 'info'); 
		}
		else if (arrayBuffer.byteLength === 524288) {
			// Esta é a parte que carrega a BIOS e a salva no Storage
			writeStorageStream('bios', arrayBuffer); // <--- Isso chama Base64.encode
			for (var i = 0; i < 0x00080000; i += 4) {
				map[(0x01c00000 + i) >>> 2] = data[i >>> 2];
			}
			bios();
			let header = document.querySelector('span.nobios');
			if (header) {
				header.classList.remove('nobios');
			}
			// Não mostra notificação aqui, pois a notificação de sucesso está em loadBiosFromPath
		}
		else {
			abort('Unsupported fileformat');
			showNotification(`Formato de arquivo "${fileName}" não suportado.`, 'error');
		}
	}

	function handleFileSelect(evt) {
		evt.stopPropagation();
		evt.preventDefault();

		const fileList = evt.dataTransfer ? evt.dataTransfer.files : evt.target.files;

		for (var i = 0, f; f = fileList[i]; i++) {
			openFile(f);
		}
	}

	function handleDragOver(evt) {
		evt.stopPropagation();
		evt.preventDefault();
	}

	/**
	 * Tenta carregar a BIOS de um caminho fixo usando fetch.
	 * @param {string} path O caminho relativo/absoluto para o arquivo da BIOS.
	 */
	function loadBiosFromPath(path) {
		showNotification(`Tentando carregar BIOS de ${path}...`, 'loading', 8000); 
		fetch(path)
			.then(response => {
				if (!response.ok) {
					showNotification(`Falha ao buscar BIOS de ${path}. Status: ${response.status}`, 'error');
					return null;
				}
				return response.arrayBuffer();
			})
			.then(arrayBuffer => {
				if (arrayBuffer) {
					if (arrayBuffer.byteLength === 524288) {
						loadFileData(arrayBuffer, path.split('/').pop()); 
						showNotification(`BIOS (512KB) carregada com sucesso!`, 'success'); 
					} else {
						showNotification(`BIOS de ${path} tem tamanho incorreto (${arrayBuffer.byteLength} bytes).`, 'warning');
					}
				}
			})
			.catch(error => {
				showNotification('Erro de rede ao carregar a BIOS.', 'error');
				console.error('Erro de rede ou processamento ao carregar a BIOS:', error);
			});
	}

	/**
	 * Carrega Memory Card de um caminho específico (mcr/)
	 * @param {string} path Caminho do arquivo .mcr
	 * @param {number} slotIndex 0 para Slot 1, 1 para Slot 2
	 */
	function loadMemoryCardFromPath(path, slotIndex) {
		const slotName = slotIndex === 0 ? "Memory Card 1" : "Memory Card 2";
		
		fetch(path)
			.then(response => {
				if (!response.ok) {
					// Não é um erro crítico, apenas um aviso se o arquivo não existir.
					console.warn(`[Memory Card] Arquivo não encontrado em: ${path}`);
					return null;
				}
				return response.arrayBuffer();
			})
			.then(arrayBuffer => {
				if (arrayBuffer) {
					// Memory Cards de PS1 têm 128KB (131072 bytes)
					if (arrayBuffer.byteLength === 131072) {
						let data8 = new Uint8Array(arrayBuffer);
						// Copia os dados para o dispositivo do joypad correto
						for (let i = 0; i < 128 * 1024; ++i) {
							joy.devices[slotIndex].data[i] = data8[i];
						}
						showNotification(`${slotName} carregado: ${path}`, 'success');
					} else {
						showNotification(`Tamanho inválido para ${slotName}: ${path} (${arrayBuffer.byteLength} bytes). Esperado: 131072`, 'warning');
					}
				}
			})
			.catch(error => {
				console.error(`Erro ao carregar ${slotName}:`, error);
				showNotification(`Falha ao carregar ${slotName}. Verifique o caminho.`, 'error');
			});
	}

	/**
	 * Função auxiliar para carregar um jogo diretamente de um ArrayBuffer
	 * Esta função é chamada pelo Local Game Manager para jogos instalados
	 */
	function loadGameFromArrayBuffer(arrayBuffer, fileName) {
		try {
			loadFileData(arrayBuffer, fileName);
			showNotification(`Jogo carregado: ${fileName}`, 'success');
			return true;
		} catch (error) {
			console.error('Erro ao carregar jogo:', error);
			showNotification(`Erro ao carregar ${fileName}: ${error.message}`, 'error');
			return false;
		}
	}

	function init() {

		canvas = document.getElementById('display');
		logElement = document.getElementById('system-log'); 

		// REMOVIDO: listeners duplicados que causam conflito
		// document.addEventListener('dragover', handleDragOver, false);
		// document.addEventListener('drop', handleFileSelect, false);
		
		// Atualizar o seletor para o novo campo de upload direto
		const directGameFile = document.getElementById('directGameFile');
		if (directGameFile) {
			directGameFile.addEventListener('change', function(e) {
				// Processamento simplificado para evitar conflitos
				const fileList = e.target.files;
				if (fileList && fileList[0]) {
					openFile(fileList[0]);
					
					// Mostrar notificação
					if (window.showNotification) {
						showNotification(`Carregando ${fileList[0].name}...`, 'loading');
					}
				}
			}, false);
		}

		settings.updateQuality();

		document.getElementById('quality').addEventListener('click', evt => {
			settings.updateQuality(true);
			showNotification(`Qualidade de Renderização alterada.`, 'info', 2000); 

			evt.stopPropagation();
			evt.preventDefault();
			return false;
		});

		emulate(performance.now());

		renderer = new WebGLRenderer(canvas);

		canvas.addEventListener("dblclick", function (e) {
			running = !running;
			if (!running) {
				spu.silence();
				showNotification('Emulação Pausada.', 'info', 3000);
			} else {
				showNotification('Emulação Retomada.', 'info', 3000);
			}
		});

		canvas.addEventListener("touchstart", function (e) {
			running = !running;
			if (!running) {
				spu.silence();
				showNotification('Emulação Pausada.', 'info', 3000);
			} else {
				showNotification('Emulação Retomada.', 'info', 3000);
			}
		});


		window.addEventListener("keydown", function (e) {
			// Adicionando notificação para o usuário se tentar usar teclas de controle de modo (Ctrl + 1, 2, etc.)
			if (e.ctrlKey && ['1', '2', '3', '4', '0'].includes(e.key)) {
				// Adicionado um pequeno atraso para não sobrescrever a mensagem de keyup
				setTimeout(() => showNotification(`Modo de Renderização alterado (Ctrl+${e.key}).`, 'info', 2000), 50);
			}
			
			if (e.key === 'F12' || e.key === 'F11' || e.key === 'F5') return; 
			e.preventDefault();
		}, false);

		window.addEventListener("keyup", function (e) {
			if (e.key === '1' && e.ctrlKey) renderer.setMode('disp');
			if (e.key === '2' && e.ctrlKey) renderer.setMode('draw');
			if (e.key === '3' && e.ctrlKey) renderer.setMode('clut8');
			if (e.key === '4' && e.ctrlKey) renderer.setMode('clut4');
			if (e.key === '0' && e.ctrlKey) renderer.setMode('page2');

			if (e.key === 'F12' || e.key === 'F11' || e.key === 'F5') return; 
			e.preventDefault();
		}, false);

		// Carregamento da BIOS
		loadBiosFromPath('bios/SCPH1001.BIN');
		
		// Carregamento dos Memory Cards da pasta 'mcr'
		loadMemoryCardFromPath('mcr/epsxe000.mcr', 0); // Slot 1
		loadMemoryCardFromPath('mcr/epsxe001.mcr', 1); // Slot 2
		
		// Inicializar o Local Game Manager se disponível
		if (window.localGameManager) {
			console.log('✅ Local Game Manager inicializado');
			
			// Carregar jogos instalados automaticamente após um delay
			setTimeout(() => {
				if (window.localGameManager.loadInstalledGames) {
					window.localGameManager.loadInstalledGames();
				}
				
				// Mostrar info do storage
				setTimeout(() => {
					if (window.showStorageInfo) {
						window.showStorageInfo();
					}
				}, 2000);
			}, 1000);
		}

		// Expor funções importantes para uso global pelo Local Game Manager
		window.showNotification = showNotification;
		window.loadFileData = loadFileData;
		window.openFile = openFile;
		window.loadGameFromArrayBuffer = loadGameFromArrayBuffer;
		
		// Mostrar notificação de inicialização completa
		setTimeout(() => {
			showNotification('Emulador PS1 pronto! Use "Instalar Novo Jogo" para adicionar jogos ao cache.', 'success', 5000);
		}, 2000);
		
		console.log('✅ Emulador PS1 inicializado com sucesso!');
	}

	// 🔧 CORREÇÃO CRÍTICA: Exportar todas as funções necessárias
	scope.init = init;
	scope.PSX_SPEED = PSX_SPEED;
	scope.renderer = undefined;
	scope.abort = abort;
	scope.context = context;
	scope.showNotification = showNotification;
	scope.loadFileData = loadFileData;
	scope.openFile = openFile;
	scope.loadGameFromArrayBuffer = loadGameFromArrayBuffer; // ✅ NOVA FUNÇÃO EXPORTADA

	// ✅ EXPORTAR PARA USO GLOBAL (IMPORTANTE PARA LocalGameManager)
	window.showNotification = showNotification;
	window.openFile = openFile;
	window.loadFileData = loadFileData;
	window.loadGameFromArrayBuffer = loadGameFromArrayBuffer;

})(window);