(function (scope) {
    'use strict';

    /**
     * ========================================================================
     * GAME INFO MANAGER
     * ========================================================================
     * Módulo para extrair, gerenciar e exibir informações do CD-ROM PS1
     * diretamente da imagem carregada (window.cdr), incluindo:
     *   - TOC / faixas (áudio, dados, MSF, duração)
     *   - Primary Volume Descriptor ISO9660 real (setor 16)
     *   - Diretório raiz (ISO9660)
     *   - SYSTEM.CNF -> executável de boot -> serial real do jogo (ex: SLUS-01234)
     *   - Região real do jogo (derivada do serial), separada da região do console
     *
     * Depende apenas de window.cdr (cdrom.js). Não depende de chd.js/chd-cd.js,
     * já que a leitura é feita sobre cdr.cdImage, que é preenchido igualmente
     * seja a origem BIN/CUE, ISO ou CHD.
     */

    const GameInfo = {
        // ====================================================================
        // Dados do jogo/disco carregado
        // ====================================================================
        current: {
            filename: '',
            filesize: 0,
            title: 'Sem Jogo Carregado',

            // Região do CONSOLE emulado (BIOS virtual: 'A'/'E'/'I'...), != região do jogo
            consoleRegion: 'A',
            // Região REAL do disco, derivada do serial (SYSTEM.CNF) quando possível
            region: 'Desconhecido',

            serial: '',
            bootExecutable: '',
            systemCnfRaw: '',

            tracks: [],
            cdType: 'PS1 CD-ROM',
            dataOffset: 0,
            hasCdFile: false,
            isAudio: false,
            isData: false,
            hasAudio: false,
            hasData: false,

            // ISO9660 (Primary Volume Descriptor)
            isoParsed: false,
            systemIdentifier: '',
            volumeIdentifier: '',
            volumeSetIdentifier: '',
            publisherIdentifier: '',
            dataPreparerIdentifier: '',
            applicationIdentifier: '',
            volumeCreationDate: null,
            volumeSpaceSizeSectors: 0,
            logicalBlockSize: 2048,
            pathTableSize: 0,
            pathTableLocation: 0,
            rootDirectory: { lba: null, size: 0 },
            rootEntries: [],

            cover: null,
            coverUrl: null,
        },

        // Prefixos de serial conhecidos -> região real do jogo
        gameDatabase: {
            'SLUS': 'EUA (NTSC-U)',
            'SCUS': 'EUA (NTSC-U, Sony 1st party)',
            'SLES': 'Europa (PAL)',
            'SCES': 'Europa (PAL, Sony 1st party)',
            'SLED': 'Europa (PAL) Demo',
            'SCED': 'Europa (PAL) Demo, Sony 1st party',
            'SLPS': 'Japão (NTSC-J)',
            'SCPS': 'Japão (NTSC-J, Sony 1st party)',
            'SLPM': 'Japão (NTSC-J)',
            'SIPS': 'Japão (NTSC-J)',
            'PAPX': 'Japão (Promo/Amostra)',
            'PDPX': 'Japão (Demo)',
            'ESPM': 'Japão (Educacional)',
            'SLAJ': 'Ásia (NTSC-J)',
            'SLKA': 'Coréia',
            'SCKA': 'Coréia (Sony 1st party)',
            'SLEA': 'Austrália (PAL)',
            'SLUJ': 'Japão (NTSC) Demo',
        },

        // Mapa da região do CONSOLE emulado (byte cdr.region, não é a região do jogo)
        consoleRegions: {
            'A': 'América (NTSC)',
            'E': 'Europa (PAL)',
            'I': 'Japão (NTSC)',
            'C': 'China',
            'K': 'Coréia',
            'H': 'Hong Kong',
            'T': 'Taiwan',
        },

        // ====================================================================
        // Inicialização
        // ====================================================================
        init: function () {
            console.log('[GameInfo] Módulo inicializado');
            this.setupCDRWatcher();
            this.updateUIOnLoad();
        },

        setupCDRWatcher: function () {
            if (typeof window.cdr !== 'undefined') {
                console.log('[GameInfo] CD-ROM detectado e pronto');
                this.extractCDInfo();
            } else {
                console.warn('[GameInfo] CD-ROM ainda não carregado');
            }
        },

        // ====================================================================
        // Acesso a bytes crus da imagem (cdr.cdImage)
        // ====================================================================

        /**
         * Retorna uma view Uint8Array sobre o buffer bruto de cdr.cdImage,
         * independentemente do TypedArray original usado para armazená-lo.
         */
        getByteView: function () {
            const img = window.cdr && window.cdr.cdImage;
            if (!img || !img.buffer || !img.buffer.byteLength) return null;
            if (img instanceof Uint8Array) return img;
            const byteOffset = img.byteOffset || 0;
            const byteLength = img.byteLength !== undefined ? img.byteLength : img.buffer.byteLength;
            return new Uint8Array(img.buffer, byteOffset, byteLength);
        },

        isReady: function () {
            const view = this.getByteView();
            return !!(window.cdr && window.cdr.hasCdFile && view && view.length > 0);
        },

        /**
         * Lê `length` bytes da área de dados do usuário de um setor bruto (LBA),
         * usando exatamente a mesma fórmula usada por cdr.readSector() em cdrom.js:
         *   offset = dataOffset + LBA * 2352 + offsetInSector
         * offsetInSector=24 é o início dos 2048 bytes de dados (Mode1/Mode2 Form1),
         * que é o layout padrão usado pelos jogos de PS1.
         */
        readSectorBytes: function (lba, length, offsetInSector) {
            length = length || 2048;
            offsetInSector = offsetInSector === undefined ? 24 : offsetInSector;
            const view = this.getByteView();
            if (!view || !window.cdr) return null;

            const base = (window.cdr.dataOffset || 0) + lba * 2352 + offsetInSector;
            if (base < 0 || base + length > view.length) return null;
            return view.subarray(base, base + length);
        },

        /**
         * Lê `size` bytes contíguos a partir do LBA `lba`, concatenando quantos
         * setores de 2048 bytes forem necessários. Usado para ler arquivos
         * (ex: SYSTEM.CNF) ou diretórios inteiros do ISO9660.
         */
        readBytesAtLBA: function (lba, size) {
            if (lba === null || lba === undefined || !size) return null;
            const sectorCount = Math.ceil(size / 2048);
            const out = new Uint8Array(sectorCount * 2048);
            for (let s = 0; s < sectorCount; s++) {
                const chunk = this.readSectorBytes(lba + s, 2048);
                if (!chunk) return null;
                out.set(chunk, s * 2048);
            }
            return out.subarray(0, size);
        },

        // ---- Helpers de leitura binária (ISO9660 usa little-endian "both-endian") ----
        readUInt32LE: function (bytes, offset) {
            return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
        },

        readUInt16LE: function (bytes, offset) {
            return (bytes[offset] | (bytes[offset + 1] << 8)) & 0xffff;
        },

        readAString: function (bytes, offset, length) {
            let s = '';
            for (let i = 0; i < length; i++) {
                const c = bytes[offset + i];
                if (c === 0) break;
                s += String.fromCharCode(c);
            }
            return s.replace(/\s+$/, '');
        },

        parseISODate: function (bytes, offset) {
            // 17 bytes ASCII: AAAAMMDDHHmmSSCC + fuso (1 byte, ignorado aqui)
            const raw = this.readAString(bytes, offset, 16);
            if (!raw || raw.length < 14 || raw.startsWith('0000')) return null;
            const year = raw.substr(0, 4);
            const month = raw.substr(4, 2);
            const day = raw.substr(6, 2);
            const hour = raw.substr(8, 2);
            const min = raw.substr(10, 2);
            const sec = raw.substr(12, 2);
            if (year === '0000' || month === '00' || day === '00') return null;
            return `${day}/${month}/${year} ${hour}:${min}:${sec}`;
        },

        // ====================================================================
        // TOC / Faixas — a partir de window.cdr.tracks (begin/end/id/audio/data)
        // ====================================================================
        extractCDInfo: function () {
            if (!window.cdr) return;
            const cdr = window.cdr;

            this.current.consoleRegion = cdr.region || 'A';
            this.current.dataOffset = cdr.dataOffset || 0;
            this.current.hasCdFile = !!cdr.hasCdFile;

            const rawTracks = Array.isArray(cdr.tracks) ? cdr.tracks : [];
            this.current.hasAudio = rawTracks.some(t => t && t.audio);
            this.current.hasData = rawTracks.some(t => t && t.data);

            if (this.current.hasAudio && this.current.hasData) {
                this.current.cdType = 'PS1 Mixed Mode (Áudio + Dados)';
                this.current.isAudio = true;
                this.current.isData = true;
            } else if (this.current.hasAudio) {
                this.current.cdType = 'CD de Áudio';
                this.current.isAudio = true;
                this.current.isData = false;
            } else if (this.current.hasData) {
                this.current.cdType = 'PS1 CD-ROM (Dados)';
                this.current.isData = true;
                this.current.isAudio = false;
            } else {
                this.current.cdType = 'PS1 CD-ROM';
                this.current.isAudio = false;
                this.current.isData = false;
            }

            // cdr.tracks[0] é um placeholder (índices reais começam em 1)
            this.current.tracks = rawTracks
                .map((track, idx) => (track && (track.begin !== undefined || track.end !== undefined)) ? this.formatTrack(track, idx) : null)
                .filter(Boolean);

            console.log('[GameInfo] Faixas extraídas:', this.current.tracks);
        },

        formatTrack: function (track, idx) {
            const begin = track.begin || 0;
            const end = track.end || 0;
            const lengthSectors = Math.max(0, end - begin);
            return {
                number: track.id !== undefined ? track.id : idx,
                type: track.audio ? 'Áudio' : 'Dados',
                audio: !!track.audio,
                data: !!track.data,
                beginLBA: begin,
                endLBA: end,
                lengthSectors: lengthSectors,
                beginMSF: this.lbaToMSF(begin),
                endMSF: this.lbaToMSF(end),
                durationMSF: this.framesToMSF(lengthSectors),
                sizeBytes: lengthSectors * 2352,
                sizeFormatted: this.formatBytes(lengthSectors * 2352),
            };
        },

        // MSF absoluto no disco (soma o pregap padrão de 150 frames / 2 segundos)
        lbaToMSF: function (lba) {
            return this.framesToMSF(Math.max(0, (lba | 0) + 150));
        },

        // MSF de uma duração pura (sem offset de pregap)
        framesToMSF: function (frames) {
            frames = Math.max(0, frames | 0);
            const mm = Math.floor(frames / (75 * 60));
            const ss = Math.floor((frames / 75) % 60);
            const ff = Math.floor(frames % 75);
            const pad = n => String(n).padStart(2, '0');
            return `${pad(mm)}:${pad(ss)}:${pad(ff)}`;
        },

        // ====================================================================
        // ISO9660 — Primary Volume Descriptor real (setor 16)
        // ====================================================================
        parsePrimaryVolumeDescriptor: function () {
            const sector = this.readSectorBytes(16, 2048);
            if (!sector) {
                console.warn('[GameInfo] Não foi possível ler o setor 16 (PVD) — imagem ainda não pronta?');
                this.current.isoParsed = false;
                return null;
            }

            const magic = String.fromCharCode(sector[1], sector[2], sector[3], sector[4], sector[5]);
            if (magic !== 'CD001' || sector[0] !== 1) {
                console.warn('[GameInfo] Setor 16 não é um Primary Volume Descriptor ISO9660 válido (magic="' + magic + '"). Disco pode ser somente áudio ou usar outro filesystem.');
                this.current.isoParsed = false;
                return null;
            }

            const pvd = {
                systemIdentifier: this.readAString(sector, 8, 32),
                volumeIdentifier: this.readAString(sector, 40, 32),
                volumeSpaceSize: this.readUInt32LE(sector, 80),
                logicalBlockSize: this.readUInt16LE(sector, 128),
                pathTableSize: this.readUInt32LE(sector, 132),
                pathTableLocation: this.readUInt32LE(sector, 140),
                rootDirectory: {
                    lba: this.readUInt32LE(sector, 156 + 2),
                    size: this.readUInt32LE(sector, 156 + 10),
                },
                volumeSetIdentifier: this.readAString(sector, 190, 128),
                publisherIdentifier: this.readAString(sector, 318, 128),
                dataPreparerIdentifier: this.readAString(sector, 446, 128),
                applicationIdentifier: this.readAString(sector, 574, 128),
                volumeCreationDate: this.parseISODate(sector, 813),
                volumeModificationDate: this.parseISODate(sector, 830),
            };

            this.current.isoParsed = true;
            this.current.systemIdentifier = pvd.systemIdentifier;
            this.current.volumeIdentifier = pvd.volumeIdentifier;
            this.current.volumeSetIdentifier = pvd.volumeSetIdentifier;
            this.current.publisherIdentifier = pvd.publisherIdentifier;
            this.current.dataPreparerIdentifier = pvd.dataPreparerIdentifier;
            this.current.applicationIdentifier = pvd.applicationIdentifier;
            this.current.volumeCreationDate = pvd.volumeCreationDate;
            this.current.volumeSpaceSizeSectors = pvd.volumeSpaceSize;
            this.current.logicalBlockSize = pvd.logicalBlockSize;
            this.current.pathTableSize = pvd.pathTableSize;
            this.current.pathTableLocation = pvd.pathTableLocation;
            this.current.rootDirectory = pvd.rootDirectory;

            console.log('[GameInfo] PVD (ISO9660) lido com sucesso:', pvd);
            return pvd;
        },

        /**
         * Lê os registros de diretório de um extent ISO9660 (LBA + tamanho em bytes)
         * e retorna a lista de entradas (arquivos e subdiretórios).
         */
        parseDirectory: function (lba, size) {
            const entries = [];
            if (lba === null || lba === undefined || !size) return entries;

            const sectorCount = Math.ceil(size / 2048);
            for (let s = 0; s < sectorCount; s++) {
                const sector = this.readSectorBytes(lba + s, 2048);
                if (!sector) break;

                let pos = 0;
                while (pos < 2048) {
                    const recLen = sector[pos];
                    if (recLen === 0 || pos + recLen > 2048) break; // fim dos registros neste setor

                    const idLen = sector[pos + 32];
                    const flags = sector[pos + 25];
                    const isDirectory = (flags & 0x02) !== 0;
                    const extentLBA = this.readUInt32LE(sector, pos + 2);
                    const dataLength = this.readUInt32LE(sector, pos + 10);

                    // Ignora as entradas especiais "." (0x00) e ".." (0x01)
                    const firstIdByte = sector[pos + 33];
                    if (!(idLen === 1 && (firstIdByte === 0x00 || firstIdByte === 0x01))) {
                        let rawName = '';
                        for (let i = 0; i < idLen; i++) rawName += String.fromCharCode(sector[pos + 33 + i]);
                        entries.push({
                            name: rawName.replace(/;\d+$/, ''), // remove ";1" de versão
                            lba: extentLBA,
                            size: dataLength,
                            isDirectory: isDirectory,
                        });
                    }

                    pos += recLen;
                }
            }
            return entries;
        },

        /**
         * Localiza e interpreta o SYSTEM.CNF na raiz do disco, extraindo o
         * executável de boot (BOOT/BOOT2) e derivando o serial oficial do jogo
         * (ex: "SLUS_012.34" -> "SLUS-01234") e sua região real.
         */
        parseSystemCnf: function () {
            if (!this.current.rootDirectory || this.current.rootDirectory.lba === null || this.current.rootDirectory.lba === undefined) {
                console.warn('[GameInfo] Diretório raiz indisponível (PVD não foi lido ainda?)');
                return null;
            }

            const rootEntries = this.parseDirectory(this.current.rootDirectory.lba, this.current.rootDirectory.size);
            this.current.rootEntries = rootEntries;

            const cnfEntry = rootEntries.find(e => !e.isDirectory && e.name.toUpperCase() === 'SYSTEM.CNF');
            if (!cnfEntry) {
                console.warn('[GameInfo] SYSTEM.CNF não encontrado na raiz do disco (jogo pode usar boot direto por PSX.EXE)');
                // Fallback: procura um executável solto na raiz (ex: PSX.EXE)
                const exeEntry = rootEntries.find(e => !e.isDirectory && /\.EXE$/i.test(e.name));
                if (exeEntry) {
                    this.current.bootExecutable = exeEntry.name;
                }
                return null;
            }

            const bytes = this.readBytesAtLBA(cnfEntry.lba, cnfEntry.size);
            if (!bytes) {
                console.warn('[GameInfo] Falha ao ler SYSTEM.CNF');
                return null;
            }

            let text = '';
            for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
            this.current.systemCnfRaw = text;

            const bootMatch = text.match(/BOOT2?\s*=\s*cdrom\d?:\\?\/?([^;\r\n]+)/i);
            if (bootMatch) {
                const exec = bootMatch[1].trim().replace(/^[\\/]+/, '');
                this.current.bootExecutable = exec;

                const serialMatch = exec.match(/([A-Za-z]{4})[_-]?(\d{3})\.?(\d{2})/);
                if (serialMatch) {
                    const prefix = serialMatch[1].toUpperCase();
                    const serial = `${prefix}-${serialMatch[2]}${serialMatch[3]}`;
                    this.current.serial = serial;
                    this.current.region = this.gameDatabase[prefix] || this.current.region;
                }
            }

            console.log('[GameInfo] SYSTEM.CNF interpretado:', {
                exec: this.current.bootExecutable,
                serial: this.current.serial,
                region: this.current.region,
            });

            return { raw: text, exec: this.current.bootExecutable, serial: this.current.serial };
        },

        /**
         * Pipeline completo de leitura do sistema de arquivos do disco.
         * Mantido com o nome parseISO9660() por compatibilidade com o HTML
         * (refreshCDInfo() / onFileLoaded() já chamam este método).
         */
        parseISO9660: function () {
            if (!this.isReady()) {
                console.warn('[GameInfo] Imagem do CD ainda não está pronta para leitura de setores');
                return null;
            }
            try {
                const pvd = this.parsePrimaryVolumeDescriptor();
                if (pvd) this.parseSystemCnf();
                return pvd;
            } catch (e) {
                console.error('[GameInfo] Erro ao interpretar sistema de arquivos ISO9660:', e);
                return null;
            }
        },

        // ====================================================================
        // Título / arquivo
        // ====================================================================
        setGameTitle: function (filename) {
            if (!filename) {
                this.current.title = 'Sem Jogo Carregado';
                return;
            }

            // Remove extensão e, se presente, um prefixo de serial solto no nome
            let title = filename.replace(/\.[^.]+$/, '');
            title = title.replace(/^(SLUS|SCUS|SLES|SCES|SLED|SCED|SLPS|SCPS|SLPM|SIPS|SLKA|SCKA|SLEA|SLUJ)[_-]?\d{3}\.?\d{2}\s*[-_.]?\s*/i, '');

            this.current.title = title.trim() || filename;
            this.current.filename = filename;
            console.log('[GameInfo] Título (heurística do nome do arquivo): ' + this.current.title);
        },

        setFileSize: function (size) {
            this.current.filesize = size;
        },

        // ====================================================================
        // Formatação
        // ====================================================================
        formatBytes: function (bytes) {
            if (!bytes || bytes <= 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
            return (Math.round((bytes / Math.pow(k, i)) * 100) / 100) + ' ' + sizes[i];
        },

        getFormattedSize: function () {
            return this.formatBytes(this.current.filesize);
        },

        // Região real do jogo (derivada do serial); cai para a região do console se desconhecida
        getRegionName: function () {
            if (this.current.region && this.current.region !== 'Desconhecido') {
                return this.current.region;
            }
            return this.consoleRegions[this.current.consoleRegion] || 'Desconhecido';
        },

        getConsoleRegionName: function () {
            return this.consoleRegions[this.current.consoleRegion] || 'Desconhecido';
        },

        getSerial: function () {
            return this.current.serial || 'Desconhecido';
        },

        // ====================================================================
        // Getters — Faixas
        // ====================================================================
        getTracks: function () { return this.current.tracks; },
        getTrackCount: function () { return this.current.tracks.length; },
        getAudioTrackCount: function () { return this.current.tracks.filter(t => t.audio).length; },
        getDataTrackCount: function () { return this.current.tracks.filter(t => t.data).length; },

        getTotalSectors: function () {
            return this.current.tracks.reduce((sum, t) => sum + t.lengthSectors, 0);
        },

        // Duração total das faixas de áudio (CD de música / trilha sonora em CDDA)
        getTotalAudioDuration: function () {
            const audioFrames = this.current.tracks.filter(t => t.audio).reduce((sum, t) => sum + t.lengthSectors, 0);
            return this.framesToMSF(audioFrames);
        },

        getCDInfo: function () {
            return {
                type: this.current.cdType,
                isAudio: this.current.isAudio,
                isData: this.current.isData,
                hasAudio: this.current.hasAudio,
                hasData: this.current.hasData,
                region: this.getRegionName(),
                consoleRegion: this.getConsoleRegionName(),
                totalTracks: this.getTrackCount(),
                audioTracks: this.getAudioTrackCount(),
                dataTracks: this.getDataTrackCount(),
                totalSectors: this.getTotalSectors(),
                totalAudioDuration: this.getTotalAudioDuration(),
            };
        },

        // ====================================================================
        // Getters — ISO9660 / Sistema de arquivos
        // ====================================================================
        getISOInfo: function () {
            return {
                parsed: this.current.isoParsed,
                systemIdentifier: this.current.systemIdentifier,
                volumeIdentifier: this.current.volumeIdentifier,
                volumeSetIdentifier: this.current.volumeSetIdentifier,
                publisherIdentifier: this.current.publisherIdentifier,
                dataPreparerIdentifier: this.current.dataPreparerIdentifier,
                applicationIdentifier: this.current.applicationIdentifier,
                volumeCreationDate: this.current.volumeCreationDate,
                volumeSpaceSizeSectors: this.current.volumeSpaceSizeSectors,
                volumeSpaceSizeFormatted: this.formatBytes(this.current.volumeSpaceSizeSectors * this.current.logicalBlockSize),
                logicalBlockSize: this.current.logicalBlockSize,
                pathTableLocation: this.current.pathTableLocation,
                pathTableSize: this.current.pathTableSize,
                rootDirectory: this.current.rootDirectory,
            };
        },

        getRootDirectoryListing: function () {
            return this.current.rootEntries.map(e => ({
                name: e.name,
                isDirectory: e.isDirectory,
                size: e.size,
                sizeFormatted: e.isDirectory ? '-' : this.formatBytes(e.size),
                lba: e.lba,
            }));
        },

        getBootExecutable: function () {
            return this.current.bootExecutable || 'Desconhecido';
        },

        // ====================================================================
        // Resumo geral
        // ====================================================================
        getGameInfo: function () {
            return {
                title: this.current.title,
                filename: this.current.filename,
                filesize: this.getFormattedSize(),
                filesizeBytes: this.current.filesize,
                serial: this.getSerial(),
                region: this.getRegionName(),
                cdInfo: this.getCDInfo(),
                isoInfo: this.getISOInfo(),
                tracks: this.getTracks(),
                bootExecutable: this.getBootExecutable(),
                cover: this.current.cover,
                coverUrl: this.current.coverUrl,
            };
        },

        // ====================================================================
        // Interface HTML
        // ====================================================================
        updateUIOnLoad: function () {
            const gameInfo = this.getGameInfo();

            const updates = {
                'game-title': gameInfo.title,
                'game-serial': gameInfo.serial,
                'game-region': gameInfo.region,
                'game-filesize': gameInfo.filesize,
                'game-cd-type': gameInfo.cdInfo.type,
                'game-tracks': gameInfo.cdInfo.totalTracks + ' faixas (' + gameInfo.cdInfo.audioTracks + 'A/' + gameInfo.cdInfo.dataTracks + 'D)',
                'game-volume-id': gameInfo.isoInfo.volumeIdentifier || '-',
                'game-publisher': gameInfo.isoInfo.publisherIdentifier || '-',
            };

            for (const [elementId, content] of Object.entries(updates)) {
                const element = document.getElementById(elementId);
                if (element) {
                    element.textContent = content;
                }
            }
            console.log('[GameInfo] UI atualizada');
        },

        onFileLoaded: function (filename, filesize) {
            this.setGameTitle(filename);
            this.setFileSize(filesize);
            this.extractCDInfo();
            this.parseISO9660();
            this.updateUIOnLoad();
            console.log('[GameInfo] Arquivo carregado: ' + filename);
        },

        clear: function () {
            this.current = {
                filename: '',
                filesize: 0,
                title: 'Sem Jogo Carregado',
                consoleRegion: 'A',
                region: 'Desconhecido',
                serial: '',
                bootExecutable: '',
                systemCnfRaw: '',
                tracks: [],
                cdType: 'PS1 CD-ROM',
                dataOffset: 0,
                hasCdFile: false,
                isAudio: false,
                isData: false,
                hasAudio: false,
                hasData: false,
                isoParsed: false,
                systemIdentifier: '',
                volumeIdentifier: '',
                volumeSetIdentifier: '',
                publisherIdentifier: '',
                dataPreparerIdentifier: '',
                applicationIdentifier: '',
                volumeCreationDate: null,
                volumeSpaceSizeSectors: 0,
                logicalBlockSize: 2048,
                pathTableSize: 0,
                pathTableLocation: 0,
                rootDirectory: { lba: null, size: 0 },
                rootEntries: [],
                cover: null,
                coverUrl: null,
            };
            console.log('[GameInfo] Informações limpas');
            this.updateUIOnLoad();
        },

        getSummary: function () {
            const info = this.getGameInfo();
            const faixasStr = `${info.cdInfo.totalTracks} (${info.cdInfo.audioTracks}A/${info.cdInfo.dataTracks}D)`;

            return `
╔════════════════════════════════════════╗
║         INFORMAÇÕES DO JOGO            ║
╠════════════════════════════════════════╣
║ Título:      ${info.title.padEnd(26)} ║
║ Serial:      ${info.serial.padEnd(26)} ║
║ Arquivo:     ${info.filename.padEnd(26)} ║
║ Região:      ${info.region.padEnd(26)} ║
║ Tamanho:     ${info.filesize.padEnd(26)} ║
║ Tipo CD:     ${info.cdInfo.type.padEnd(26)} ║
║ Faixas:      ${faixasStr.padEnd(26)} ║
║ Boot:        ${info.bootExecutable.padEnd(26)} ║
╚════════════════════════════════════════╝
            `;
        },

        debug: function () {
            console.group('[GameInfo] DEBUG - Informações Completas');
            console.log('Dados Atuais:', this.current);
            console.log('Informações do Jogo:', this.getGameInfo());
            console.log('Listagem raiz do disco:', this.getRootDirectoryListing());
            console.log('Resumo:', this.getSummary());
            console.groupEnd();
        }
    };

    // Expõe o módulo globalmente
    scope.GameInfo = GameInfo;

    // Inicializa automaticamente quando o DOM está pronto
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            GameInfo.init();
        });
    } else {
        GameInfo.init();
    }

})(window);
