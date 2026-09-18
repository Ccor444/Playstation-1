(scope => {
    'use strict';

    let running = false;
    let canvas = undefined;
    let renderer;

    const PSX_SPEED = 44100 * 768; // 33868800 cycles

    // ============================================================
    // [BIOS AUTO-LOAD]
    // ============================================================
    const BIOS_PATH = 'bios/bios.bin';
    const BIOS_BASE = 0x01C00000;
    const BIOS_SIZE_512K = 0x80000;
    const BIOS_MAX_SIZE = 0x110000;
    const BIOS_STORAGE_KEY = 'bios-1mb';

    function isValidBiosSize(size) {
        return size === BIOS_SIZE_512K ||
            (size > BIOS_SIZE_512K && size <= BIOS_MAX_SIZE && (size & 3) === 0);
    }

    function applyBiosLimit(size) {
        if (typeof scope.setBiosLimit === 'function') {
            scope.setBiosLimit(size);
        }
    }

    function abort() {
        console.error(Array.prototype.slice.call(arguments).join(' '));

        if (canvas) {
            canvas.style.borderColor = 'red';
        }

        running = false;

        if (typeof scope.spu !== 'undefined') {
            scope.spu.silence();
        }

        throw 'abort';
    }

    let hasFocus = true;

    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') {
            document.title = 'active';
            hasFocus = true;
        } else {
            document.title = 'paused';
            hasFocus = false;

            if (typeof scope.spu !== 'undefined') {
                scope.spu.silence();
            }
        }
    });

    const context = {
        timeStamp: 0,
        realtime: 0,
        emutime: 0,
        counter: 0
    };

    function isTouchEnabled() {
        return ('ontouchstart' in window) ||
            (navigator.maxTouchPoints > 0) ||
            (navigator.msMaxTouchPoints > 0);
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
        if (!entry) return abort('invalid pc');

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

    // ============================================================
    // [CUE] HELPERS
    // ============================================================
    function msfToFrames(msf) {
        if (!msf) return 0;
        return ((msf.mm * 60) + msf.ss) * 75 + msf.ff;
    }

    function normalizeBinName(name) {
        return name
            .replace(/\.[^.]+$/, '')
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');
    }

    // ============================================================
    // [CUE] PARSER DE CUE SHEET
    // ============================================================
    function parseCue(cueText) {
        const lines = cueText.split(/\r?\n/);
        const disc = {
            files: [],
            tracks: []
        };

        let currentFile = null;
        let currentTrack = null;

        for (let rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;

            const upper = line.toUpperCase();

            if (upper.startsWith('FILE ')) {
                const m =
                    line.match(/^FILE\s+"([^"]+)"\s+(\w+)/i) ||
                    line.match(/^FILE\s+(\S+)\s+(\w+)/i);

                if (m) {
                    currentFile = {
                        name: m[1],
                        type: m[2].toUpperCase(),
                        tracks: []
                    };

                    disc.files.push(currentFile);
                }
            } else if (upper.startsWith('TRACK ')) {
                const m = line.match(/^TRACK\s+(\d+)\s+(\S+)/i);

                if (m) {
                    currentTrack = {
                        number: parseInt(m[1], 10),
                        type: m[2].toUpperCase(),
                        file: currentFile,
                        indices: {},
                        pregap: null,
                        postgap: null
                    };

                    if (currentFile) currentFile.tracks.push(currentTrack);
                    disc.tracks.push(currentTrack);
                }
            } else if (upper.startsWith('INDEX ')) {
                const m = line.match(/^INDEX\s+(\d+)\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/i);

                if (m && currentTrack) {
                    currentTrack.indices[parseInt(m[1], 10)] = {
                        mm: parseInt(m[2], 10),
                        ss: parseInt(m[3], 10),
                        ff: parseInt(m[4], 10)
                    };
                }
            } else if (upper.startsWith('PREGAP ')) {
                const m = line.match(/^PREGAP\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/i);

                if (m && currentTrack) {
                    currentTrack.pregap = {
                        mm: +m[1],
                        ss: +m[2],
                        ff: +m[3]
                    };
                }
            } else if (upper.startsWith('POSTGAP ')) {
                const m = line.match(/^POSTGAP\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/i);

                if (m && currentTrack) {
                    currentTrack.postgap = {
                        mm: +m[1],
                        ss: +m[2],
                        ff: +m[3]
                    };
                }
            }
        }

        return disc;
    }

    // ============================================================
    // [CUE] ESTADO PENDENTE
    // Permite carregar o CUE e os BINs/CHDs em momentos diferentes.
    // Quando todos os arquivos necessários estão presentes,
    // a imagem é montada automaticamente.
    // ============================================================
    const pendingCue = {
        disc: null,
        buffers: new Map()
    };

    function resetPendingCue() {
        pendingCue.disc = null;
        pendingCue.buffers.clear();
    }

    function loadCueText(cueText) {
        const disc = parseCue(cueText);

        console.log(`[CUE] disco: ${disc.tracks.length} tracks, ${disc.files.length} arquivo(s)`);

        if (disc.tracks.length === 0) {
            abort('CUE sem tracks');
            return;
        }

        pendingCue.disc = disc;

        console.log('[CUE] aguardando arquivos:');
        for (const f of disc.files) {
            console.log('  -', f.name);
        }

        tryBuildPendingCue();
    }

    // ============================================================
    // [CHD]
    // loadBinFile agora pode receber CHD.
    // Se detectar CHD, decodifica para raw antes de continuar.
    // ============================================================
    async function loadBinFile(fileName, buffer) {
        try {
            const looksLikeChd =
                (scope.isChdBuffer && scope.isChdBuffer(buffer)) ||
                /\.chd$/i.test(fileName || '');

            if (looksLikeChd) {
                try {
                    if (!scope.decodeChdToArrayBuffer) {
                        throw new Error('para suporte a CHD, carregue chd.js antes do index.js');
                    }

                    console.log('[CHD] detectado:', fileName, buffer.byteLength);

                    buffer = await scope.decodeChdToArrayBuffer(buffer, (done, total) => {
                        if ((done & 0xff) === 0 || done === total) {
                            console.log(`[CHD] decodificando hunk ${done}/${total}`);
                        }
                    });

                    // Garante ArrayBuffer.
                    if (!(buffer instanceof ArrayBuffer)) {
                        const u8 = buffer instanceof Uint8Array
                            ? buffer
                            : new Uint8Array(buffer);

                        buffer = (u8.byteOffset === 0 && u8.buffer.byteLength === u8.byteLength)
                            ? u8.buffer
                            : u8.slice().buffer;
                    }

                    console.log('[CHD] decodificado para raw:', buffer.byteLength);

                    // Para matching com CUE, trata CHD como se fosse BIN.
                    fileName = fileName.replace(/\.[^.]+$/i, '.bin');
                } catch (err) {
                    console.error('[CHD]', err);

                    try {
                        abort('Falha no CHD: ' + (err && err.message ? err.message : err));
                    } catch (e) {
                        // abort() lança exceção de propósito.
                    }

                    return;
                }
            }

            // Se há um CUE pendente, adiciona este BIN/CHD decodificado ao conjunto.
            if (pendingCue.disc) {
                const norm = normalizeBinName(fileName);
                pendingCue.buffers.set(norm, buffer);

                console.log(`[CUE] BIN/CHD adicionado ao conjunto: ${fileName}`);

                tryBuildPendingCue();
                return;
            }

            // Sem CUE pendente: carrega como disco único (BIN/ISO/VCD/CHD decodificado).
            loadFileData(buffer);
        } catch (err) {
            if (err !== 'abort') {
                console.error('[loadBinFile]', err);
            }
        }
    }

    function tryBuildPendingCue() {
        const disc = pendingCue.disc;
        if (!disc) return;

        const matched = new Map();

        for (const fileEntry of disc.files) {
            const baseName = fileEntry.name.split(/[\\/]/).pop();
            const norm = normalizeBinName(baseName);

            // Match exato normalizado.
            let buffer = pendingCue.buffers.get(norm);

            // Match parcial (um nome contém o outro).
            if (!buffer) {
                for (const [key, buf] of pendingCue.buffers.entries()) {
                    if (key.includes(norm) || norm.includes(key)) {
                        buffer = buf;
                        break;
                    }
                }
            }

            if (buffer) {
                matched.set(fileEntry, buffer);
            }
        }

        if (matched.size === disc.files.length) {
            console.log('[CUE] todos os arquivos presentes, montando imagem...');
            buildImageFromCue(disc, matched);
            resetPendingCue();
        } else if (disc.files.length === 1 && pendingCue.buffers.size >= 1) {
            // Fallback single-file: usa o primeiro BIN/CHD disponível.
            const firstBuffer = pendingCue.buffers.values().next().value;
            matched.set(disc.files[0], firstBuffer);

            console.log('[CUE] fallback single-file: usando BIN/CHD disponível');

            buildImageFromCue(disc, matched);
            resetPendingCue();
        } else {
            const missing = disc.files
                .filter(f => !matched.has(f))
                .map(f => f.name);

            console.log(`[CUE] aguardando ${missing.length} arquivo(s):`, missing);
        }
    }

    function buildImageFromCue(disc, buffers) {
        const SECTOR = 2352;

        const chunks = [];
        const fileStartFrame = new Map();

        let totalFrames = 0;

        // 1ª passada: calcula o offset de cada arquivo e coleta os chunks.
        for (const fileEntry of disc.files) {
            const buf = buffers.get(fileEntry);
            if (!buf) continue;

            fileStartFrame.set(fileEntry, totalFrames);
            chunks.push(new Uint8Array(buf));

            totalFrames += Math.floor(buf.byteLength / SECTOR);
        }

        if (totalFrames === 0) {
            abort('[CUE] nenhum dado de BIN/CHD carregado');
            return;
        }

        // 2ª passada: monta a TOC.
        const toc = [];
        toc[0] = {
            id: 0,
            begin: 0,
            end: totalFrames
        };

        for (const track of disc.tracks) {
            const startOfFile = fileStartFrame.get(track.file) || 0;

            const idx1 =
                track.indices[1] ||
                track.indices[0] ||
                { mm: 0, ss: 0, ff: 0 };

            const beginInFile = msfToFrames(idx1);
            const beginAbs = startOfFile + beginInFile;

            const isData = track.type.indexOf('MODE') === 0;

            toc[track.number] = {
                id: track.number,
                begin: beginAbs,
                end: totalFrames,
                data: isData,
                audio: !isData
            };
        }

        // Ajusta o 'end' de cada track = begin da próxima.
        const maxTrack = disc.tracks.length;

        for (let i = 1; i < maxTrack; i++) {
            if (toc[i] && toc[i + 1]) {
                toc[i].end = toc[i + 1].begin;
            }
        }

        if (toc[maxTrack]) {
            toc[maxTrack].end = totalFrames;
        }

        const totalBytes = chunks.reduce((s, c) => s + c.length, 0);

        let finalBuffer;

        // Evita copiar novamente quando há apenas um arquivo.
        if (
            chunks.length === 1 &&
            chunks[0].byteOffset === 0 &&
            chunks[0].buffer.byteLength === chunks[0].length
        ) {
            finalBuffer = chunks[0].buffer;
        } else {
            const combined = new Uint8Array(totalBytes);

            let off = 0;
            for (const c of chunks) {
                combined.set(c, off);
                off += c.length;
            }

            finalBuffer = combined.buffer;
        }

        console.log(
            `[CUE] imagem montada: ${totalFrames} frames, ` +
            `${toc.length - 1} tracks, ${totalBytes} bytes`
        );

        const mem = new MemoryBlock(finalBuffer);

        cdr.setCdImage(mem);
        cdr.setTOC(toc);

        running = true;
    }

    // ============================================================
    // [ABERTURA DE ARQUIVOS]
    // ============================================================
    function openFile(file) {
        const ext = file.name.split('.').pop().toLowerCase();

        // Arquivos CUE são lidos como texto.
        if (ext === 'cue') {
            const reader = new FileReader();

            reader.onload = function (event) {
                console.log('[CUE] carregado:', escape(file.name), file.size);
                loadCueText(event.target.result);
            };

            reader.readAsText(file);
            return;
        }

        // Arquivos de dados: BIN, ISO, VCD, CHD, BIOS, MEMCARD, PS-EXE.
        const reader = new FileReader();

        reader.onload = function (event) {
            console.log(escape(file.name), file.size);
            loadBinFile(file.name, event.target.result);
        };

        reader.readAsArrayBuffer(file);
    }

    function loadFileData(arrayBuffer) {
        let vcdOffset = 0;
        let vcdTracks = null;

        const btoi = b => Math.floor(b / 16) * 10 + Math.floor(b % 16);

        // [VCD/POPSTARTER] Detecção: header de 1MB + imagem BIN.
        if (
            arrayBuffer.byteLength > 0x100000 &&
            ((arrayBuffer.byteLength - 0x100000) % 2352 === 0)
        ) {
            const view = new Uint8Array(arrayBuffer, 0x100000, 12);

            if (
                view[0] === 0x00 &&
                view[1] === 0xFF &&
                view[2] === 0xFF &&
                view[3] === 0xFF
            ) {
                vcdOffset = 0x100000;

                console.log('[VCD] POPSTARTER VCD format detected.');

                try {
                    const h = new Uint8Array(arrayBuffer, 0, 0x100000);

                    if (h[2] === 0xA0 && h[12] === 0xA1 && h[22] === 0xA2) {
                        let firstTrack = btoi(h[7]);
                        let lastTrack = btoi(h[17]);
                        let trackCount = lastTrack - firstTrack + 1;

                        if (trackCount > 0 && trackCount < 100) {
                            vcdTracks = [];

                            let lastLoc = (arrayBuffer.byteLength - vcdOffset) / 2352;

                            vcdTracks.push({
                                id: 0,
                                begin: 0,
                                end: lastLoc
                            });

                            for (let t = 0; t < trackCount; t++) {
                                let off = 0x1E + t * 10;

                                let trackType = h[off + 0];
                                let trackNum = btoi(h[off + 2]);

                                let mm = btoi(h[off + 7]);
                                let ss = btoi(h[off + 8]);
                                let ff = btoi(h[off + 9]);

                                let beginSector = (mm * 60 + ss) * 75 + ff - 150;
                                if (beginSector < 0) beginSector = 0;

                                let isData = (trackType === 0x41);

                                vcdTracks.push({
                                    id: trackNum,
                                    begin: beginSector,
                                    end: lastLoc,
                                    data: isData,
                                    audio: !isData
                                });
                            }

                            let leadMM = btoi(h[27]);
                            let leadSS = btoi(h[28]);
                            let leadFF = btoi(h[29]);

                            let leadOutSector = (leadMM * 60 + leadSS) * 75 + leadFF - 150;

                            for (let t = 1; t < vcdTracks.length - 1; t++) {
                                vcdTracks[t].end = vcdTracks[t + 1].begin;
                            }

                            if (vcdTracks.length > 1) {
                                vcdTracks[vcdTracks.length - 1].end = leadOutSector;
                            }

                            console.log('[VCD] TOC extraído do header com sucesso:', vcdTracks);
                        }
                    }
                } catch (e) {
                    console.warn('[VCD] Falha ao ler TOC do header, usando auto-TOC.', e);
                    vcdTracks = null;
                }
            }
        }

        let data;

        if ((arrayBuffer.byteLength & 3) !== 0) {
            const copy = new Uint8Array(arrayBuffer);
            data = new MemoryBlock(((copy.length + 3) & ~3) >> 2);

            for (let i = 0; i < copy.length; ++i) {
                data.setInt8(i, copy[i]);
            }
        } else {
            data = new MemoryBlock(arrayBuffer);
        }

        const view8 = new Int8Array(data.buffer);

        if ((data[0] & 0xffff) === 0x5350) {
            // PS-EXE
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

            let textSegmentOffset = data.getInt32(0x18);
            const fileContentLength = data.getInt32(0x1C);

            for (let i = 0; i < fileContentLength; ++i) {
                map8[(textSegmentOffset & 0x001fffff) >>> 0] = view8[(0x800 + i) >>> 0];
                textSegmentOffset++;
            }

            clearCodeCache(data.getInt32(0x18), view8.length);

            running = true;
        } else if (data.getInt32(vcdOffset) === (0xffffff00 >> 0)) {
            // ISO/BIN/VCD/CHD decodificado
            let tracks = vcdTracks;

            if (!tracks) {
                // Auto build TOC (attempt to not need .cue files).
                let loc = 0;
                let lastLoc = (arrayBuffer.byteLength - vcdOffset) / 2352;
                let type = 0; // data

                tracks = [];

                tracks.push({
                    id: 0,
                    begin: 0,
                    end: lastLoc
                });

                const sectorLength = 2352;

                function isDataSector(startLoc) {
                    let pos = vcdOffset + startLoc * sectorLength;

                    let mask1 = data.getInt32(pos + 0) >>> 0;
                    let mask2 = data.getInt32(pos + 4) >>> 0;
                    let mask3 = data.getInt32(pos + 8) >>> 0;

                    return (
                        mask1 === 0xffffff00 &&
                        mask2 === 0xffffffff &&
                        mask3 === 0x00ffffff
                    );
                }

                function isEmptySector(startLoc) {
                    let mask = 0;
                    let pos = vcdOffset + startLoc * sectorLength;

                    for (let i = 0; i < sectorLength; i += 4) {
                        mask |= data.getInt32(pos + i);
                    }

                    return (mask >>> 0) === (0x00000000 >>> 0);
                }

                let begin, end, lead, track = 0;
                let i = 0;

                begin = i;
                while ((i < lastLoc) && isDataSector(i)) ++i;
                end = i;

                while ((i < lastLoc) && isEmptySector(i)) ++i;

                tracks.push({
                    id: 1,
                    begin,
                    end,
                    data: true
                });

                let id = 2;

                if (i < lastLoc) {
                    begin = i;

                    while (i < lastLoc) {
                        while ((i < lastLoc) && !isEmptySector(i)) ++i;
                        end = i;

                        while ((i < lastLoc) && isEmptySector(i)) ++i;
                        lead = i;

                        if ((lead - end) < 75) continue;

                        tracks.push({
                            id,
                            begin,
                            end,
                            audio: true
                        });

                        begin = i;
                        id++;
                    }

                    if (begin < lastLoc) {
                        end = lead = lastLoc;

                        tracks.push({
                            id,
                            begin,
                            end,
                            audio: true
                        });
                    }
                }
            }

            cdr.setCdImage(data, vcdOffset);
            cdr.setTOC(tracks);

            running = true;
        } else if (data[0] === 0x0000434d) {
            // MEMCARD
            console.log('loaded MEMCARD');

            const copy = new Uint8Array(arrayBuffer);
            let card = joy.devices ? joy.devices[0].data : joy.cardOneMemory;

            for (let i = 0; i < copy.length; ++i) {
                card[i] = copy[i];
            }
        } else if (isValidBiosSize(arrayBuffer.byteLength)) {
            // BIOS
            const biosSize = arrayBuffer.byteLength;
            const copySize = (biosSize + 3) & ~3;

            applyBiosLimit(biosSize);

            writeStorageStream(BIOS_STORAGE_KEY, arrayBuffer);

            for (let i = 0; i < copySize; i += 4) {
                map[(BIOS_BASE + i) >>> 2] = data[i >>> 2];
            }

            bios();

            let header = document.querySelector('span.nobios');
            if (header) {
                header.classList.remove('nobios');
            }
        } else {
            abort('Unsupported fileformat');
        }
    }

    // ============================================================
    // [BIOS AUTO-LOAD]
    // ============================================================
    function loadBiosFromServer() {
        fetch(BIOS_PATH, { cache: 'no-store' })
            .then(res => {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.arrayBuffer();
            })
            .then(buffer => {
                if (!isValidBiosSize(buffer.byteLength)) {
                    throw new Error(
                        'tamanho inesperado: ' + buffer.byteLength +
                        ' (esperado 524288 ou BIOS expandida até ' + BIOS_MAX_SIZE + ' bytes, alinhada a 4)'
                    );
                }

                console.log('[bios] carregada de', BIOS_PATH, buffer.byteLength);

                try {
                    loadFileData(buffer);
                } catch (e) {
                    if (e !== 'abort') {
                        console.error('[bios]', e);
                    }
                }
            })
            .catch(err => {
                console.log(
                    '[bios] não encontrada em "' + BIOS_PATH + '" (' + err.message +
                    '), tentando cache local...'
                );

                loadBiosFromCache();
            });
    }

    function loadBiosFromCache() {
        readStorageStream(BIOS_STORAGE_KEY, data => {
            if (data) {
                if (!isValidBiosSize(data.byteLength)) {
                    console.log('[bios] cache com tamanho inválido:', data.byteLength);
                    return;
                }

                const biosSize = data.byteLength;
                const copySize = (biosSize + 3) & ~3;

                applyBiosLimit(biosSize);

                let data32 = new Uint32Array(data);

                for (let i = 0; i < copySize; i += 4) {
                    map[(BIOS_BASE + i) >>> 2] = data32[i >>> 2];
                }

                let header = document.querySelector('span.nobios');
                if (header) {
                    header.classList.remove('nobios');
                }

                bios();

                console.log('[bios] carregada do cache local (localStorage)', biosSize);
            } else {
                console.log(
                    '[bios] nenhuma bios disponível — arraste um bios.bin (512KB, 1MB ou 1.05MB) pra tela, ' +
                    'ou coloque o arquivo em "' + BIOS_PATH + '" no servidor.'
                );
            }
        });
    }

    // ============================================================
    // [SELEÇÃO DE ARQUIVOS]
    // Suporta múltiplos arquivos e CUE+BINS/CHDs separados.
    // ============================================================
    function handleFileSelect(evt) {
        evt.stopPropagation();
        evt.preventDefault();

        const fileList = evt.dataTransfer ? evt.dataTransfer.files : evt.target.files;
        const files = [];

        for (let i = 0; i < fileList.length; i++) {
            files.push(fileList[i]);
        }

        // Procura um CUE no conjunto.
        const cueFile = files.find(f => f.name.toLowerCase().endsWith('.cue'));

        if (cueFile) {
            // Há um CUE: processa ele primeiro (para criar o pending),
            // depois os demais arquivos são adicionados ao conjunto.
            loadCueThenBins(cueFile, files.filter(f => f !== cueFile));
        } else {
            // Sem CUE: carrega cada arquivo normalmente.
            for (const f of files) {
                openFile(f);
            }
        }
    }

    function loadCueThenBins(cueFile, binFiles) {
        const cueReader = new FileReader();

        cueReader.onload = function (e) {
            // Carrega o CUE (cria o pending).
            loadCueText(e.target.result);

            // Agora carrega cada BIN/ISO/CHD, que será adicionado ao pending.
            for (const bf of binFiles) {
                const ext = bf.name.split('.').pop().toLowerCase();

                if (ext === 'cue') continue;

                const binReader = new FileReader();

                binReader.onload = function (ev) {
                    console.log(escape(bf.name), bf.size);
                    loadBinFile(bf.name, ev.target.result);
                };

                binReader.readAsArrayBuffer(bf);
            }
        };

        cueReader.readAsText(cueFile);
    }

    function handleDragOver(evt) {
        evt.stopPropagation();
        evt.preventDefault();
    }

    function init() {
        canvas = document.getElementById('display');

        document.addEventListener('dragover', handleDragOver, false);
        document.addEventListener('drop', handleFileSelect, false);

        // [MULTI-SELECT + CHD]
        const fileInput = document.getElementById('file');

        if (fileInput) {
            fileInput.setAttribute('multiple', 'multiple');

            const accept = (fileInput.getAttribute('accept') || '').trim();

            if (!/\.chd/i.test(accept)) {
                fileInput.setAttribute(
                    'accept',
                    accept ? (accept + ',.chd') : '.chd'
                );
            }

            fileInput.addEventListener('change', handleFileSelect, false);
        }

        settings.updateQuality();

        const qualityButton = document.getElementById('quality');

        if (qualityButton) {
            qualityButton.addEventListener('click', evt => {
                settings.updateQuality(true);

                evt.stopPropagation();
                evt.preventDefault();

                return false;
            });
        }

        emulate(performance.now());

        renderer = new WebGLRenderer(canvas);
        scope.renderer = renderer;

        canvas.addEventListener('dblclick', function (e) {
            running = !running;

            if (!running) {
                spu.silence();
            }
        });

        window.addEventListener('keydown', function (e) {
            if (e.key === 'F12') return; // allow developer tools
            if (e.key === 'F11') return; // allow full screen
            if (e.key === 'F5') return;  // allow page refresh

            e.preventDefault();
        }, false);

        window.addEventListener('keyup', function (e) {
            if (e.key === '1' && e.ctrlKey) renderer.setMode('disp');
            if (e.key === '2' && e.ctrlKey) renderer.setMode('draw');
            if (e.key === '3' && e.ctrlKey) renderer.setMode('clut8');
            if (e.key === '4' && e.ctrlKey) renderer.setMode('clut4');
            if (e.key === '0' && e.ctrlKey) renderer.setMode('page2');

            if (e.key === 'F12') return; // allow developer tools
            if (e.key === 'F11') return; // allow full screen
            if (e.key === 'F5') return;  // allow page refresh

            e.preventDefault();
        }, false);

        loadBiosFromServer();

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

    function togglePause() {
        running = !running;

        if (!running) {
            spu.silence();
        }

        return running;
    }

    function isRunning() {
        return running;
    }

    scope.init = init;
    scope.PSX_SPEED = PSX_SPEED;
    scope.renderer = renderer;
    scope.abort = abort;
    scope.context = context;
    scope.togglePause = togglePause;
    scope.isRunning = isRunning;

})(window);