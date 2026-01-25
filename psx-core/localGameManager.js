
/**
 * Local Game Manager - Sistema de instalação local de jogos
 * Suporta arquivos grandes (até vários GB) usando streaming
 */

console.log('[LocalGameManager] Inicializando...');

class LocalGameManager {
    constructor() {
        this.dbName = 'PS1LocalGamesDB';
        this.dbVersion = 3; // Incrementado para nova estrutura
        this.storeName = 'localGames';
        this.chunkStoreName = 'gameChunks';
        this.db = null;
        this.initialized = false;
        this.chunkSize = 10 * 1024 * 1024; // 10MB por chunk para arquivos grandes
        
        this.initDB();
    }
    
    async initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            
            request.onerror = (event) => {
                console.error('[LocalGameManager] Erro ao abrir IndexedDB:', event.target.error);
                reject(event.target.error);
            };
            
            request.onsuccess = (event) => {
                this.db = event.target.result;
                this.initialized = true;
                console.log('[LocalGameManager] IndexedDB inicializado');
                resolve(this.db);
                
                // Carregar jogos automaticamente
                this.loadInstalledGames();
            };
            
            request.onupgradeneeded = (event) => {
                console.log('[LocalGameManager] Atualizando banco de dados...');
                const db = event.target.result;
                
                // Store para metadados dos jogos
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, { keyPath: 'id' });
                    store.createIndex('name', 'name', { unique: false });
                    store.createIndex('region', 'region', { unique: false });
                    store.createIndex('installedDate', 'installedDate', { unique: false });
                    store.createIndex('lastPlayed', 'lastPlayed', { unique: false });
                }
                
                // Store para chunks de arquivos grandes (se necessário)
                if (!db.objectStoreNames.contains(this.chunkStoreName)) {
                    const chunkStore = db.createObjectStore(this.chunkStoreName, { keyPath: ['gameId', 'chunkIndex'] });
                    chunkStore.createIndex('gameId', 'gameId', { unique: false });
                }
            };
        });
    }
    
    /**
     * Instala um jogo a partir de um arquivo local
     * Agora suporta arquivos grandes usando chunks
     */
    async installGameFromFile(file, name, region, progressCallback = null) {
        if (!this.initialized) {
            await this.initDB();
        }
        
        const fileSizeMB = Math.round(file.size / (1024 * 1024));
        console.log(`[LocalGameManager] Instalando: ${name} (${fileSizeMB}MB)`);
        
        if (window.showNotification) {
            window.showNotification(`Instalando "${name}" (${fileSizeMB}MB)...`, 'loading');
        }
        
        // Para arquivos muito grandes (> 100MB), usar chunks
        const useChunks = file.size > 100 * 1024 * 1024;
        
        if (useChunks) {
            return this.installLargeFile(file, name, region, progressCallback);
        } else {
            return this.installSmallFile(file, name, region, progressCallback);
        }
    }
    
    /**
     * Instala arquivos pequenos (< 100MB) de uma vez
     */
    async installSmallFile(file, name, region, progressCallback = null) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            
            reader.onload = async (event) => {
                try {
                    const arrayBuffer = event.target.result;
                    
                    if (progressCallback) progressCallback(0.3);
                    
                    let gameFiles = [];
                    let extractedFiles = [];
                    
                    // Verificar se é ZIP
                    const isZip = file.name.toLowerCase().endsWith('.zip');
                    
                    if (isZip && typeof JSZip !== 'undefined') {
                        console.log('[LocalGameManager] Processando arquivo ZIP...');
                        if (progressCallback) progressCallback(0.4);
                        
                        try {
                            const zip = new JSZip();
                            const zipData = await zip.loadAsync(arrayBuffer);
                            
                            // Extrair todos os arquivos relevantes
                            const filePromises = [];
                            const fileEntries = [];
                            
                            // Primeiro, listar todos os arquivos
                            zipData.forEach((relativePath, zipEntry) => {
                                if (!zipEntry.dir) {
                                    const lowerPath = relativePath.toLowerCase();
                                    // Aceitar arquivos de jogo e arquivos relacionados
                                    if (lowerPath.endsWith('.bin') || 
                                        lowerPath.endsWith('.iso') || 
                                        lowerPath.endsWith('.img') ||
                                        lowerPath.endsWith('.cue') ||
                                        lowerPath.endsWith('.ecm') ||
                                        lowerPath.endsWith('.pbp')) {
                                        fileEntries.push({ path: relativePath, entry: zipEntry });
                                    }
                                }
                            });
                            
                            if (progressCallback) progressCallback(0.5);
                            
                            // Processar arquivos em paralelo
                            for (const fileEntry of fileEntries) {
                                const promise = this.zipEntryToFile(fileEntry.entry, fileEntry.path);
                                filePromises.push(promise);
                            }
                            
                            extractedFiles = await Promise.all(filePromises);
                            
                            console.log(`[LocalGameManager] Extraídos ${extractedFiles.length} arquivos do ZIP`);
                            
                        } catch (zipError) {
                            console.error('[LocalGameManager] Erro ao processar ZIP:', zipError);
                            // Se falhar, tratar como arquivo único
                            extractedFiles = [{
                                filename: file.name,
                                data: arrayBuffer,
                                size: arrayBuffer.byteLength,
                                type: 'direct'
                            }];
                        }
                    } else {
                        // Arquivo direto (BIN, ISO, etc)
                        const fileType = this.getFileType(file.name);
                        extractedFiles = [{
                            filename: file.name,
                            data: arrayBuffer,
                            size: arrayBuffer.byteLength,
                            type: fileType
                        }];
                    }
                    
                    if (progressCallback) progressCallback(0.7);
                    
                    // Filtrar apenas arquivos principais (BIN, ISO, PBP)
                    const mainFiles = extractedFiles.filter(f => 
                        f.type === 'bin' || f.type === 'iso' || f.type === 'pbp');
                    
                    // Se não encontrar arquivos principais, usar todos
                    gameFiles = mainFiles.length > 0 ? mainFiles : extractedFiles;
                    
                    // Criar ID único para o jogo
                    const gameId = `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                    
                    // Criar objeto do jogo
                    const gameData = {
                        id: gameId,
                        name: name,
                        region: region,
                        originalFilename: file.name,
                        fileSize: file.size,
                        fileType: isZip ? 'zip' : this.getFileType(file.name),
                        files: gameFiles,
                        installedDate: new Date().toISOString(),
                        lastPlayed: null,
                        playCount: 0,
                        isCompressed: isZip,
                        useChunks: false
                    };
                    
                    if (progressCallback) progressCallback(0.9);
                    
                    // Salvar no IndexedDB
                    await this.saveGame(gameData);
                    
                    if (progressCallback) progressCallback(1.0);
                    
                    console.log('[LocalGameManager] Jogo instalado:', name, gameData.files.length, 'arquivos');
                    
                    if (window.showNotification) {
                        window.showNotification(`"${name}" instalado com sucesso!`, 'success');
                    }
                    
                    resolve(gameData);
                    
                } catch (error) {
                    console.error('[LocalGameManager] Erro na instalação:', error);
                    reject(error);
                }
            };
            
            reader.onerror = () => {
                reject(new Error('Erro ao ler arquivo'));
            };
            
            reader.onprogress = (event) => {
                if (progressCallback && event.lengthComputable) {
                    const progress = event.loaded / event.total * 0.3;
                    progressCallback(progress);
                }
            };
            
            reader.readAsArrayBuffer(file);
        });
    }
    
    /**
     * Instala arquivos grandes usando chunks
     */
    async installLargeFile(file, name, region, progressCallback = null) {
        const gameId = `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const totalChunks = Math.ceil(file.size / this.chunkSize);
        
        console.log(`[LocalGameManager] Instalando arquivo grande em ${totalChunks} chunks`);
        
        if (window.showNotification) {
            window.showNotification(`Instalando "${name}" em ${totalChunks} partes...`, 'loading');
        }
        
        // Para arquivos grandes que não são ZIP, armazenar como chunks
        if (!file.name.toLowerCase().endsWith('.zip')) {
            return this.storeFileAsChunks(file, gameId, name, region, progressCallback);
        }
        
        // Para ZIPs grandes, temos que processar de forma diferente
        try {
            if (progressCallback) progressCallback(0.1);
            
            // Ler o ZIP inteiro (pode ser lento para ZIPs muito grandes)
            const arrayBuffer = await this.readFileAsArrayBuffer(file, (progress) => {
                if (progressCallback) {
                    progressCallback(progress * 0.4); // Primeiros 40% é leitura
                }
            });
            
            if (progressCallback) progressCallback(0.5);
            
            // Processar ZIP
            const zip = new JSZip();
            const zipData = await zip.loadAsync(arrayBuffer);
            
            // Encontrar arquivo principal (BIN/ISO)
            let mainFileEntry = null;
            zipData.forEach((relativePath, zipEntry) => {
                if (!zipEntry.dir) {
                    const lowerPath = relativePath.toLowerCase();
                    if ((lowerPath.endsWith('.bin') || lowerPath.endsWith('.iso') || lowerPath.endsWith('.pbp')) && !mainFileEntry) {
                        mainFileEntry = zipEntry;
                    }
                }
            });
            
            if (!mainFileEntry) {
                throw new Error('Nenhum arquivo BIN/ISO encontrado no ZIP');
            }
            
            if (progressCallback) progressCallback(0.7);
            
            // Extrair arquivo principal
            const fileData = await mainFileEntry.async('arraybuffer');
            const fileName = mainFileEntry.name.split('/').pop();
            
            // Armazenar como chunks
            const gameFiles = [{
                filename: fileName,
                data: fileData,
                size: fileData.byteLength,
                type: this.getFileType(fileName),
                isChunked: true,
                chunkInfo: {
                    gameId: gameId,
                    totalChunks: 1,
                    chunkSize: this.chunkSize
                }
            }];
            
            // Criar objeto do jogo
            const gameData = {
                id: gameId,
                name: name,
                region: region,
                originalFilename: file.name,
                fileSize: file.size,
                fileType: 'zip',
                files: gameFiles,
                installedDate: new Date().toISOString(),
                lastPlayed: null,
                playCount: 0,
                isCompressed: true,
                useChunks: true,
                mainFileName: fileName
            };
            
            if (progressCallback) progressCallback(0.9);
            
            // Salvar metadados e chunks
            await this.saveGame(gameData);
            
            // Salvar o arquivo extraído como chunk único
            await this.saveChunk(gameId, 0, fileData);
            
            if (progressCallback) progressCallback(1.0);
            
            console.log('[LocalGameManager] ZIP grande instalado:', name);
            
            if (window.showNotification) {
                window.showNotification(`"${name}" instalado com sucesso!`, 'success');
            }
            
            return gameData;
            
        } catch (error) {
            console.error('[LocalGameManager] Erro ao instalar ZIP grande:', error);
            throw error;
        }
    }
    
    /**
     * Armazena um arquivo não-ZIP como chunks
     */
    async storeFileAsChunks(file, gameId, name, region, progressCallback = null) {
        const totalChunks = Math.ceil(file.size / this.chunkSize);
        const fileType = this.getFileType(file.name);
        
        console.log(`[LocalGameManager] Armazenando ${totalChunks} chunks`);
        
        const chunks = [];
        let offset = 0;
        
        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
            const chunkStart = chunkIndex * this.chunkSize;
            const chunkEnd = Math.min(chunkStart + this.chunkSize, file.size);
            const chunk = file.slice(chunkStart, chunkEnd);
            
            const chunkData = await this.readFileChunk(chunk);
            
            // Salvar chunk no IndexedDB
            await this.saveChunk(gameId, chunkIndex, chunkData);
            
            chunks.push({
                index: chunkIndex,
                start: chunkStart,
                end: chunkEnd,
                size: chunkData.byteLength
            });
            
            // Atualizar progresso
            if (progressCallback) {
                const progress = (chunkIndex + 1) / totalChunks;
                progressCallback(progress);
            }
            
            // Liberar memória
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        
        // Criar objeto do jogo
        const gameData = {
            id: gameId,
            name: name,
            region: region,
            originalFilename: file.name,
            fileSize: file.size,
            fileType: fileType,
            files: [{
                filename: file.name,
                size: file.size,
                type: fileType,
                isChunked: true,
                chunkInfo: {
                    gameId: gameId,
                    totalChunks: totalChunks,
                    chunkSize: this.chunkSize,
                    chunks: chunks
                }
            }],
            installedDate: new Date().toISOString(),
            lastPlayed: null,
            playCount: 0,
            isCompressed: false,
            useChunks: true
        };
        
        // Salvar metadados
        await this.saveGame(gameData);
        
        console.log(`[LocalGameManager] Arquivo grande armazenado em ${totalChunks} chunks`);
        return gameData;
    }
    
    async readFileAsArrayBuffer(file, progressCallback = null) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            
            reader.onload = (event) => {
                resolve(event.target.result);
            };
            
            reader.onerror = () => {
                reject(new Error('Erro ao ler arquivo'));
            };
            
            reader.onprogress = (event) => {
                if (progressCallback && event.lengthComputable) {
                    progressCallback(event.loaded / event.total);
                }
            };
            
            reader.readAsArrayBuffer(file);
        });
    }
    
    async readFileChunk(chunk) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            
            reader.onload = (event) => {
                resolve(event.target.result);
            };
            
            reader.onerror = () => {
                reject(new Error('Erro ao ler chunk'));
            };
            
            reader.readAsArrayBuffer(chunk);
        });
    }
    
    async saveChunk(gameId, chunkIndex, chunkData) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.chunkStoreName], 'readwrite');
            const store = transaction.objectStore(this.chunkStoreName);
            
            const chunkRecord = {
                gameId: gameId,
                chunkIndex: chunkIndex,
                data: chunkData,
                timestamp: Date.now()
            };
            
            const request = store.put(chunkRecord);
            
            request.onsuccess = () => resolve();
            request.onerror = (event) => reject(event.target.error);
        });
    }
    
    async loadChunk(gameId, chunkIndex) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.chunkStoreName], 'readonly');
            const store = transaction.objectStore(this.chunkStoreName);
            
            const request = store.get([gameId, chunkIndex]);
            
            request.onsuccess = (event) => {
                const result = event.target.result;
                resolve(result ? result.data : null);
            };
            
            request.onerror = (event) => reject(event.target.error);
        });
    }
    
    async loadChunkedFile(gameId, totalChunks) {
        const chunks = [];
        
        for (let i = 0; i < totalChunks; i++) {
            const chunkData = await this.loadChunk(gameId, i);
            if (chunkData) {
                chunks.push(new Uint8Array(chunkData));
            }
        }
        
        // Combinar chunks
        const totalSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const combined = new Uint8Array(totalSize);
        let offset = 0;
        
        for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.length;
        }
        
        return combined.buffer;
    }
    
    async zipEntryToFile(zipEntry, path) {
        const fileData = await zipEntry.async('arraybuffer');
        return {
            filename: path.split('/').pop(),
            fullPath: path,
            data: fileData,
            size: fileData.byteLength,
            type: this.getFileType(path)
        };
    }
    
    getFileType(filename) {
        const lower = filename.toLowerCase();
        if (lower.endsWith('.bin')) return 'bin';
        if (lower.endsWith('.iso')) return 'iso';
        if (lower.endsWith('.img')) return 'img';
        if (lower.endsWith('.cue')) return 'cue';
        if (lower.endsWith('.pbp')) return 'pbp';
        if (lower.endsWith('.ecm')) return 'ecm';
        return 'other';
    }
    
    async saveGame(gameData) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.put(gameData);
            
            request.onsuccess = () => resolve(gameData.id);
            request.onerror = (event) => reject(event.target.error);
        });
    }
    
    async loadAllGames() {
        if (!this.initialized) {
            await this.initDB();
        }
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.getAll();
            
            request.onsuccess = (event) => {
                const games = event.target.result || [];
                console.log(`[LocalGameManager] ${games.length} jogos carregados`);
                resolve(games);
            };
            
            request.onerror = (event) => reject(event.target.error);
        });
    }
    
    async loadGame(gameId) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(gameId);
            
            request.onsuccess = (event) => resolve(event.target.result);
            request.onerror = (event) => reject(event.target.error);
        });
    }
    
    async loadInstalledGames() {
        try {
            const games = await this.loadAllGames();
            const container = document.getElementById('gamesContainer');
            
            if (!container) {
                console.warn('[LocalGameManager] Container não encontrado');
                return;
            }
            
            // Ordenar por último jogado/data de instalação
            games.sort((a, b) => {
                if (a.lastPlayed && b.lastPlayed) {
                    return new Date(b.lastPlayed) - new Date(a.lastPlayed);
                }
                return new Date(b.installedDate) - new Date(a.installedDate);
            });
            
            if (games.length === 0) {
                container.innerHTML = '<div class="no-games">Nenhum jogo instalado no cache</div>';
                return;
            }
            
            let html = '';
            
            games.forEach(game => {
                const date = new Date(game.installedDate);
                const dateStr = date.toLocaleDateString();
                
                let lastPlayedStr = '';
                if (game.lastPlayed) {
                    const lastPlayed = new Date(game.lastPlayed);
                    lastPlayedStr = `• Última vez: ${lastPlayed.toLocaleDateString()}`;
                }
                
                const fileCount = game.files ? game.files.length : 0;
                const fileSizeMB = Math.round((game.fileSize || 0) / (1024 * 1024));
                const fileSizeGB = Math.round((game.fileSize || 0) / (1024 * 1024 * 1024) * 100) / 100;
                
                const sizeStr = fileSizeMB > 1000 ? `${fileSizeGB}GB` : `${fileSizeMB}MB`;
                
                html += `
                    <div class="game-item" data-game-id="${game.id}">
                        <div class="game-info">
                            <div class="game-title">${game.name}</div>
                            <div class="game-meta">
                                ${game.region} • ${dateStr} ${lastPlayedStr}<br>
                                ${sizeStr} • ${fileCount} arquivo${fileCount !== 1 ? 's' : ''}
                                ${game.useChunks ? '• (Grande)' : ''}
                                ${game.playCount ? `• Jogado ${game.playCount} vezes` : ''}
                            </div>
                        </div>
                        <div class="game-actions">
                            <button class="btn-game-action btn-play" data-game-id="${game.id}">
                                <i class="fas fa-play"></i> Jogar
                            </button>
                            <button class="btn-game-action btn-delete" data-game-id="${game.id}">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                    </div>
                `;
            });
            
            container.innerHTML = html;
            
            // Adicionar event listeners aos botões
            container.querySelectorAll('.btn-play').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const gameId = btn.dataset.gameId;
                    this.playGame(gameId);
                });
            });
            
            container.querySelectorAll('.btn-delete').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const gameId = btn.dataset.gameId;
                    const gameItem = btn.closest('.game-item');
                    const gameName = gameItem.querySelector('.game-title').textContent;
                    
                    if (confirm(`Remover "${gameName}" do cache?`)) {
                        await this.removeGame(gameId);
                        if (window.showNotification) {
                            window.showNotification(`"${gameName}" removido`, 'success');
                        }
                        this.loadInstalledGames();
                    }
                });
            });
            
            // Clicar no item também executa o jogo
            container.querySelectorAll('.game-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    if (!e.target.closest('.btn-game-action')) {
                        const gameId = item.dataset.gameId;
                        this.playGame(gameId);
                    }
                });
            });
            
        } catch (error) {
            console.error('[LocalGameManager] Erro ao carregar jogos:', error);
            const container = document.getElementById('gamesContainer');
            if (container) {
                container.innerHTML = '<div class="no-games" style="color:#ff4444">Erro ao carregar jogos</div>';
            }
        }
    }
    
    async playGame(gameId) {
        try {
            console.log('[LocalGameManager] Executando jogo:', gameId);
            
            const game = await this.loadGame(gameId);
            
            if (!game || !game.files || game.files.length === 0) {
                throw new Error('Jogo não encontrado ou corrompido');
            }
            
            if (window.showNotification) {
                window.showNotification(`Carregando ${game.name}...`, 'loading');
            }
            
            let mainFileData = null;
            let mainFileName = null;
            
            // Verificar se é um arquivo chunked
            if (game.useChunks && game.files[0].isChunked) {
                const fileInfo = game.files[0];
                const chunkInfo = fileInfo.chunkInfo;
                
                if (window.showNotification) {
                    window.showNotification(`Montando ${game.name} a partir de ${chunkInfo.totalChunks} partes...`, 'loading');
                }
                
                // Carregar chunks e montar arquivo
                mainFileData = await this.loadChunkedFile(gameId, chunkInfo.totalChunks);
                mainFileName = fileInfo.filename;
                
            } else {
                // Arquivo normal
                // Encontrar arquivo principal (BIN, ISO ou PBP)
                let mainFile = null;
                
                // Prioridade: BIN > ISO > PBP > primeiro arquivo
                mainFile = game.files.find(f => f.type === 'bin') ||
                          game.files.find(f => f.type === 'iso') ||
                          game.files.find(f => f.type === 'pbp') ||
                          game.files[0];
                
                if (!mainFile) {
                    throw new Error('Nenhum arquivo executável encontrado');
                }
                
                mainFileData = mainFile.data;
                mainFileName = mainFile.filename;
            }
            
            if (!mainFileData) {
                throw new Error('Falha ao carregar dados do jogo');
            }
            
            console.log('[LocalGameManager] Usando arquivo:', mainFileName);
            
            // Atualizar estatísticas
            game.lastPlayed = new Date().toISOString();
            game.playCount = (game.playCount || 0) + 1;
            await this.saveGame(game);
            
            // Fechar modal se estiver aberto
            const modalElement = document.getElementById('settingsModal');
            if (modalElement) {
                const modal = bootstrap.Modal.getInstance(modalElement);
                if (modal) {
                    modal.hide();
                }
            }
            
            // Criar um Blob e File simulado para usar com o sistema existente
            const blob = new Blob([mainFileData], { type: 'application/octet-stream' });
            const simulatedFile = new File([blob], mainFileName, {
                type: 'application/octet-stream',
                lastModified: Date.now()
            });
            
            // Executar usando o sistema existente
            if (window.openFile) {
                window.openFile(simulatedFile);
            } else {
                throw new Error('Sistema de execução não disponível');
            }
            
            console.log('[LocalGameManager] Jogo executado com sucesso');
            
        } catch (error) {
            console.error('[LocalGameManager] Erro ao executar jogo:', error);
            if (window.showNotification) {
                window.showNotification(`Erro: ${error.message}`, 'error');
            }
        }
    }
    
    async removeGame(gameId) {
        return new Promise(async (resolve, reject) => {
            try {
                // Primeiro, remover os chunks se existirem
                const game = await this.loadGame(gameId);
                if (game && game.useChunks) {
                    await this.removeChunks(gameId);
                }
                
                // Depois, remover os metadados
                const transaction = this.db.transaction([this.storeName], 'readwrite');
                const store = transaction.objectStore(this.storeName);
                const request = store.delete(gameId);
                
                request.onsuccess = () => resolve(true);
                request.onerror = (event) => reject(event.target.error);
                
            } catch (error) {
                reject(error);
            }
        });
    }
    
    async removeChunks(gameId) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.chunkStoreName], 'readwrite');
            const store = transaction.objectStore(this.chunkStoreName);
            const index = store.index('gameId');
            const range = IDBKeyRange.only(gameId);
            
            const request = index.openCursor(range);
            
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                } else {
                    resolve(true);
                }
            };
            
            request.onerror = (event) => reject(event.target.error);
        });
    }
    
    async clearAllGames() {
        return new Promise(async (resolve, reject) => {
            try {
                const transaction = this.db.transaction([this.storeName, this.chunkStoreName], 'readwrite');
                
                // Limpar store de jogos
                const gameStore = transaction.objectStore(this.storeName);
                gameStore.clear();
                
                // Limpar store de chunks
                const chunkStore = transaction.objectStore(this.chunkStoreName);
                chunkStore.clear();
                
                transaction.oncomplete = () => {
                    console.log('[LocalGameManager] Todos os jogos removidos');
                    resolve(true);
                };
                
                transaction.onerror = (event) => reject(event.target.error);
                
            } catch (error) {
                reject(error);
            }
        });
    }
    
    async getStorageInfo() {
        try {
            const games = await this.loadAllGames();
            let totalSize = 0;
            let fileCount = 0;
            let chunkedCount = 0;
            
            games.forEach(game => {
                totalSize += game.fileSize || 0;
                fileCount += game.files ? game.files.length : 0;
                if (game.useChunks) chunkedCount++;
            });
            
            const totalSizeGB = Math.round(totalSize / (1024 * 1024 * 1024) * 100) / 100;
            const totalSizeMB = Math.round(totalSize / (1024 * 1024));
            
            return {
                gameCount: games.length,
                totalSize: totalSize,
                totalSizeMB: totalSizeMB,
                totalSizeGB: totalSizeGB,
                fileCount: fileCount,
                chunkedCount: chunkedCount
            };
        } catch (error) {
            console.error('[LocalGameManager] Erro ao obter info:', error);
            return null;
        }
    }
}

// Inicializar e expor globalmente
window.localGameManager = new LocalGameManager();
console.log('[LocalGameManager] Sistema local pronto!');

// Função auxiliar para mostrar espaço usado
window.showStorageInfo = async function() {
    const info = await window.localGameManager.getStorageInfo();
    if (info) {
        const sizeStr = info.totalSizeGB >= 1 ? `${info.totalSizeGB}GB` : `${info.totalSizeMB}MB`;
        const msg = `Cache: ${info.gameCount} jogos, ${sizeStr}, ${info.fileCount} arquivos`;
        console.log('[StorageInfo]', msg);
        if (window.showNotification) {
            window.showNotification(msg, 'info');
        }
        return info;
    }
    return null;
};
