(function (scope) {
    'use strict';

    // ========================================================================
    // Helpers BCD
    // ========================================================================
    var itob = function (i) {
        return (Math.floor(i / 10) * 16 + Math.floor(i % 10));
    };
    var btoi = function (b) {
        return (Math.floor(b / 16) * 10 + Math.floor(b % 16));
    };

    // ========================================================================
    // Buffers de setor (compartilhados)
    // ========================================================================
    let sectorData8 = new Int8Array(0);
    let sectorData16 = new Int16Array(0);
    let sectorData32 = new Int32Array(0);

    // ========================================================================
    // Byte STAT (retornado nas respostas) — psx-spx "CDROM Drive"
    // ========================================================================
    const STAT_PLAY      = 0x80;
    const STAT_SEEK      = 0x40;
    const STAT_READ      = 0x20;
    const STAT_SHELLOPEN = 0x10;
    const STAT_IDERROR   = 0x08;
    const STAT_SEEKERROR = 0x04;
    const STAT_MOTORON   = 0x02;
    const STAT_ERROR     = 0x01;

    // ========================================================================
    // Registrador de STATUS (leitura 1F801800h, Index 0)
    // Espelha m_status_register em cdrom.c
    // ========================================================================
    const STATUS_INDEX_MASK = 0x03; // bit 0-1: Index
    const STATUS_ADPBUSY    = 0x04; // bit 2: XA-ADPCM FIFO ocupado
    const STATUS_PRMEMPT    = 0x08; // bit 3: Parameter FIFO vazia
    const STATUS_PRMWRDY    = 0x10; // bit 4: Parameter FIFO com espaço
    const STATUS_RSLRRDY    = 0x20; // bit 5: Response FIFO não vazia
    const STATUS_DRQSTS     = 0x40; // bit 6: Data FIFO não vazia
    const STATUS_BUSYSTS    = 0x80; // bit 7: transmissão de comando ocupada

    // ========================================================================
    // Objeto principal do CDROM
    // ========================================================================
    var cdr = {
        cdImage: new Uint32Array(0),
        cdRomFile: undefined,
        currLoc: 0,
        filter: {},
        hasCdFile: false,
        dataOffset: 0, // [VCD SUPPORT] offset para pular headers (ex: 1MB do POPSTARTER VCD)
        irq: 0,
        irqEnable: 0xff,
        mode: 0,
        ncmdctrl: 0,
        ncmdread: 0,
        params: new Array(16),   // Parameter FIFO (parameter_fifo.c)
        pcm: new Float32Array(8064 * 44100 / 18900),
        pcmidx: 0,
        pcmmax: 0,
        results: new Array(16),  // Response FIFO (response_fifo.c)
        sectorEnd: 0,
        sectorIndex: 0,
        sectorOffset: 0,
        sectorSize: 0,
        seekLoc: 0,
        currTrack: {},
        // Power-on: Parameter FIFO vazia + com espaço (espelha m_cdrom_setup)
        status: (STATUS_PRMEMPT | STATUS_PRMWRDY),
        statusCode: 0x00,
        xa: new Float32Array(8064),
        playIndex: 0,
        lastCommand: 0,
        tracks: [],
        volCdLeft2SpuLeft: 1.0,
        volCdLeft2SpuRight: 0.0,
        volCdRight2SpuLeft: 0.0,
        volCdRight2SpuRight: 1.0,
        config: {
            volCdLeft2SpuLeft: 1.0,
            volCdLeft2SpuRight: 0.0,
            volCdRight2SpuLeft: 0.0,
            volCdRight2SpuRight: 1.0,
        },
        mute: false,
        adpcmMute: false,
        region: 'A', // 'A'=América(NTSC), 'E'=Europa(PAL), 'I'=Japão(NTSC)

        // ====================================================================
        // FIFO de Parâmetros — espelha parameter_fifo.c
        // ====================================================================
        paramPush: function (p) {
            if (cdr.params.length < 16) {
                cdr.params.push(p);
                // FIFO deixou de estar vazia
                cdr.status &= ~STATUS_PRMEMPT;
                // PRMWRDY = 1 enquanto houver espaço (< 16)
                if (cdr.params.length >= 16) {
                    cdr.status &= ~STATUS_PRMWRDY;
                } else {
                    cdr.status |= STATUS_PRMWRDY;
                }
            } else {
                console.warn('[CDROM] paramPush: FIFO de parâmetros estourou (16), valor descartado');
            }
        },

        resetparams: function () {
            cdr.params.length = 0;
            cdr.status |= STATUS_PRMEMPT;  // vazia
            cdr.status |= STATUS_PRMWRDY;  // com espaço
        },

        // ====================================================================
        // FIFO de Respostas — espelha response_fifo.c
        // ====================================================================
        responsePush: function (byte) {
            if (cdr.results.length < 16) {
                cdr.results.push(byte & 0xff);
                // Bufferizamos uma resposta -> FIFO não vazia (RSLRRDY = 1)
                cdr.status |= STATUS_RSLRRDY;
            } else {
                console.warn('[CDROM] responsePush: FIFO de respostas estourou (16), abortando push');
            }
        },

        responsePop: function () {
            var r = 0;
            if (cdr.results.length > 0) {
                r = cdr.results.shift(); // FIFO real (frente), mais fiel que o pop LIFO do C
                if (cdr.results.length === 0) {
                    // Última resposta retirada -> FIFO vazia (RSLRRDY = 0)
                    cdr.status &= ~STATUS_RSLRRDY;
                }
            } else {
                r = 0;
            }
            return r;
        },

        // ====================================================================
        // Reset / power-on — espelha m_cdrom_setup() em cdrom.c
        // ====================================================================
        resetState: function () {
            cdr.status = (STATUS_PRMEMPT | STATUS_PRMWRDY);
            cdr.params.length = 0;
            cdr.results.length = 0;
            cdr.irq = 0;
            cdr.mode = 0;
            cdr.filter = {};
            cdr.mute = false;
            cdr.adpcmMute = false;
            cdr.ncmdread = 0;
            cdr.ncmdctrl = 0;
        },

        // ====================================================================
        // STAT byte — espelha get_stat() em cdrom.c
        // ====================================================================
        getStat: function () {
            // Motor tratado como sempre ligado; flags Read/Seek/Play refletidas
            return (cdr.statusCode | STAT_MOTORON) & 0xff;
        },

        // ====================================================================
        // Registradores (espelham m_cdrom_read / m_cdrom_write em cdrom.c)
        // ====================================================================
        rd08r1800: function () {
            return cdr.status;
        },

        rd08r1801: function () {
            // Index 1: Response FIFO (m_cdrom_read case 1)
            if (((cdr.status & STATUS_INDEX_MASK) === 0x01) && (cdr.status & STATUS_RSLRRDY)) {
                if (cdr.results.length === 1) {
                    // Ao esvaziar, também limpa DRQSTS (comportamento original)
                    cdr.status &= ~STATUS_DRQSTS;
                }
                return cdr.responsePop();
            }
            return 0x00;
        },

        rd08r1802: function () {
            if (cdr.status & STATUS_DRQSTS) {
                return sectorData8[cdr.sectorOffset + cdr.sectorIndex++];
            }
            return 0x00;
        },

        rd08r1803: function () {
            switch (cdr.status & STATUS_INDEX_MASK) {
                case 0: return 0xE0 | cdr.irqEnable;
                case 1: return cdr.irq;
                default: abort('unimplemented index mode:' + (cdr.status & STATUS_INDEX_MASK));
            }
        },

        wr08r1800: function (data) {
            cdr.status = (cdr.status & ~STATUS_INDEX_MASK) | (data & STATUS_INDEX_MASK);
        },

        wr08r1801: function (data) {
            switch (cdr.status & STATUS_INDEX_MASK) {
                case 0: cdr.command(data); break;
                case 3: cdr.config.volCdRight2SpuRight = ((data & 0xff) >>> 0) / 0x80; break;
                default: abort('unimplemented index mode:' + (cdr.status & STATUS_INDEX_MASK));
            }
        },

        wr08r1802: function (data) {
            switch (cdr.status & STATUS_INDEX_MASK) {
                case 0: cdr.paramPush(data); break;              // parameter_fifo.c
                case 1: cdr.irqEnable = data; break;
                case 2: cdr.config.volCdLeft2SpuLeft = ((data & 0xff) >>> 0) / 0x80; break;
                case 3: cdr.config.volCdRight2SpuLeft = ((data & 0xff) >>> 0) / 0x80; break;
                default: abort('unimplemented index mode:' + (cdr.status & STATUS_INDEX_MASK));
            }
        },

        wr08r1803: function (data) {
            switch (cdr.status & STATUS_INDEX_MASK) {
                case 0:
                    if (data === 0x80) {
                        cdr.status |= STATUS_DRQSTS;
                    }
                    break;
                case 1:
                    if (data & (0x1F & cdr.irqEnable)) {
                        cdr.acknowledgeInterrupt(data);
                    }
                    if (data & 0x40) {
                        cdr.resetparams();
                    }
                    break;
                case 2: cdr.config.volCdLeft2SpuRight = ((data & 0xff) >>> 0) / 0x80; break;
                case 3:
                    cdr.adpcmMute = (data & 0x01) !== 0;
                    if (data & 0x20) {
                        cdr.volCdLeft2SpuLeft = cdr.config.volCdLeft2SpuLeft;
                        cdr.volCdLeft2SpuRight = cdr.config.volCdLeft2SpuRight;
                        cdr.volCdRight2SpuLeft = cdr.config.volCdRight2SpuLeft;
                        cdr.volCdRight2SpuRight = cdr.config.volCdRight2SpuRight;
                    }
                    break;
                default: abort('unimplemented index mode:' + (cdr.status & STATUS_INDEX_MASK));
            }
        },

        // ====================================================================
        // [HLE] CD Seek Timing
        // ====================================================================
        // A implementação original simulava a latência mecânica do pickup real
        // de um CD (curva MIN_MS..MAX_MS escalada por sqrt(distância)).
        //
        // Nenhum software de PS1 consegue observar essa curva — o que o jogo
        // vê é: "emiti um seek, depois recebi um INT3(seek-complete)". O número
        // exato de ciclos entre esses dois pontos não faz parte do contrato;
        // é só quanto tempo o emulador decidiu gastar.
        //
        // Emitir uma latência fixa curta elimina o sqrt e a matemática de
        // float por chamada, e também corresponde ao comportamento de "um
        // drive de CD mais rápido", que todo jogo já tolera porque drives
        // reais de PS1 variavam bastante em velocidade de seek.
        //
        // 0x4000 ciclos ≈ 0.3ms de tempo PSX.
        estimateSeekCycles: function (distanceSectors) {
            return 0x4000;
        },

        acknowledgeInterrupt: function (data) {
            cdr.irq &= ~(data & (0x1F & cdr.irqEnable));
        },

        // Atualiza statusCode garantindo que Play/Seek/Read sejam mutuamente exclusivos
        setStat: function (setBits, clearBits) {
            clearBits = clearBits || 0;
            if (setBits & (STAT_PLAY | STAT_SEEK | STAT_READ)) {
                clearBits |= (STAT_PLAY | STAT_SEEK | STAT_READ);
            }
            cdr.statusCode = (cdr.statusCode & ~clearBits) | setBits;
            return cdr.statusCode;
        },

        // ====================================================================
        // Dispatch de comandos (espelha m_cdrom_exec_cmd em cdrom.c)
        // ====================================================================
        command: function (data) {
            let nevtctrl = 0x0200;
            cdr.setIrq(0);
            cdr.results.length = 0;
            cdr.status &= ~STATUS_RSLRRDY;
            cdr.status |= STATUS_BUSYSTS;
            cdr.ncmdctrl = data;
            switch (data) {
                case 0x01:  //- CdlNop
                    nevtctrl = 0xc4e1;
                    break;
                case 0x03:  //- CdlPlay
                case 0x0b:  //- CdlMute
                case 0x0c:  //- CdlDemute
                case 0x0d:  //- CdlSetFilter
                case 0x0e:  //- CdlSetmode
                case 0x0f:  //- CdlGetparam
                case 0x10:  //- CdlGetLocL
                case 0x11:  //- CdlGetLocP
                case 0x13:  //- CdlGetTN
                case 0x14:  //- CdlGetTD
                case 0x19:  //- CdlTest
                case 0x1a:  //- CdlID
                case 0x1e:  //- CdlReadTOC
                    break;
                case 0x04:  //- CdlForward
                case 0x05:  //- CdlBackward
                    break;
                case 0x0a:  //- CdlInit
                    nevtctrl = 0x13cce;
                    // fallthrough intencional: Init também interrompe leitura
                case 0x02:  //- CdlSetloc
                case 0x06:  //- CdlReadN
                case 0x07:  //- CdlStandby
                case 0x08:  //- CdlStop
                case 0x12:  //- CdlSetsession
                case 0x15:  //- CdlSeekL
                case 0x16:  //- CdlSeekP
                case 0x1B:  //- CdlReadS
                    cdr.stopReading();
                    break;
                case 0x09:  //- CdlPause
                    cdr.stopReading();
                    break;
                case 0x99:  //- CdlPause (auto)
                    break;
                case 0x1c:  //- CdlReset
                    break;
                default:
                    // Comandos inválidos: hardware real dispara INT5(11h,40h)
                    cdr.ncmdctrl = 0;
                    cdr.statusCode |= STAT_ERROR;
                    cdr.responsePush(cdr.statusCode);
                    cdr.responsePush(0x40);
                    cdr.status &= ~STATUS_BUSYSTS;
                    cdr.status |= STATUS_RSLRRDY;
                    cdr.setIrq(5);
                    return;
            }
            psx.setEvent(this.eventCmd, nevtctrl >>> 0);
        },

        setIrq: function (data) {
            cdr.irq = (cdr.irq & 0xE0) | (data & 0x1F);
            if (cdr.irq & (0x1F & cdr.irqEnable)) {
                cpu.istat |= 0x0004;
            }
        },

        // ====================================================================
        // Enfileira resposta (agora FIFO plana de bytes — corrige bug do push
        // de array e espelha response_fifo.c)
        // ====================================================================
        enqueueEvent: function (irq, ...params) {
            if (this.results.length) abort('not yet read all results');
            for (var i = 0; i < params.length; i++) {
                cdr.responsePush(params[i]);
            }
            cdr.status &= ~STATUS_BUSYSTS;
            // RSLRRDY já foi setado por responsePush
            cdr.setIrq(irq);
        },

        eventCmd: null,

        completeCmd: function (self, clock) {
            psx.unsetEvent(self);
            if (cdr.irq & 0x1F) {
                psx.setEvent(this.eventCmd, 64);
                return;
            }
            const readCycles = PSX_SPEED / ((cdr.mode & 0x80) ? 150 : 75);
            var currentCommand = cdr.ncmdctrl;
            cdr.ncmdctrl = 0;
            switch (currentCommand) {
                case 0x00: break;
                case 0x01: this.enqueueEvent(3, cdr.statusCode); break;
                case 0x02:
                    cdr.seekLoc = (btoi(cdr.params[0]) * (60 * 75)) +
                                  (btoi(cdr.params[1]) * (75)) +
                                  (btoi(cdr.params[2]));
                    this.enqueueEvent(3, cdr.statusCode);
                    break;
                case 0x03:
                    if (cdr.params.length === 0 || cdr.params[0] === 0) {
                        cdr.currLoc = cdr.seekLoc;
                    }
                    if (cdr.params.length === 1) {
                        cdr.currTrack = cdr.tracks[btoi(cdr.params[0])];
                        cdr.currLoc = cdr.seekLoc = cdr.currTrack.begin + 150;
                        console.log(`CdlPlay: ${btoi(cdr.params[0])} : ${cdr.currLoc}`);
                    }
                    psx.setEvent(this.eventRead, readCycles >>> 0);
                    cdr.ncmdread = 0x03;
                    this.enqueueEvent(3, cdr.setStat(STAT_PLAY | STAT_MOTORON));
                    break;
                case 0x04: // Forward
                case 0x05: // Backward
                    if (!(cdr.statusCode & STAT_PLAY)) {
                        cdr.statusCode |= STAT_ERROR;
                        this.enqueueEvent(5, cdr.statusCode, 0x80);
                        break;
                    }
                    cdr.ncmdread = currentCommand;
                    this.enqueueEvent(3, cdr.statusCode);
                    break;
                case 0x06:
                    psx.setEvent(this.eventRead, readCycles >>> 0);
                    cdr.ncmdread = 0x06;
                    this.enqueueEvent(3, cdr.setStat(STAT_SEEK | STAT_MOTORON));
                    cdr.currLoc = cdr.seekLoc;
                    break;
                case 0x07:
                    this.enqueueEvent(3, cdr.statusCode);
                    cdr.ncmdctrl = 0x70;
                    cdr.status |= STATUS_BUSYSTS;
                    break;
                case 0x70:
                    this.enqueueEvent(2, cdr.setStat(STAT_MOTORON, STAT_PLAY | STAT_SEEK | STAT_READ));
                    break;
                case 0x08:
                    this.enqueueEvent(3, cdr.setStat(0, STAT_READ));
                    psx.setEvent(this.eventCmd, ((cdr.mode & 0x80) ? 0x18a6076 : 0xd38aca) >>> 0);
                    cdr.ncmdctrl = 0x80;
                    cdr.status |= STATUS_BUSYSTS;
                    break;
                case 0x80:
                    this.enqueueEvent(2, cdr.setStat(0, STAT_MOTORON | STAT_PLAY | STAT_SEEK | STAT_READ));
                    cdr.currLoc = cdr.seekLoc = 150;
                    break;
                case 0x09:
                    cdr.responsePush(cdr.statusCode | STAT_READ);
                    psx.setEvent(this.eventCmd, ((cdr.mode & 0x80) ? 0x10bd93 : 0x21181c) >>> 0);
                    cdr.ncmdctrl = 0x90;
                    cdr.status |= STATUS_BUSYSTS;
                    cdr.status |= STATUS_RSLRRDY;
                    cdr.setIrq(3);
                    break;
                case 0x90:
                    cdr.statusCode = (cdr.statusCode & ~STAT_READ) | STAT_MOTORON;
                    cdr.responsePush(cdr.statusCode);
                    cdr.status &= ~STATUS_BUSYSTS;
                    cdr.status |= STATUS_RSLRRDY;
                    cdr.setIrq(2);
                    break;
                case 0x99:
                    cdr.statusCode = (cdr.statusCode & ~(STAT_READ | STAT_SEEK)) | STAT_MOTORON;
                    cdr.responsePush(cdr.statusCode);
                    cdr.status &= ~STATUS_BUSYSTS;
                    cdr.status |= STATUS_RSLRRDY;
                    cdr.setIrq(4);
                    break;
                case 0x0A:
                    this.enqueueEvent(3, cdr.statusCode);
                    psx.setEvent(this.eventCmd, 0x1000 >>> 0);
                    cdr.ncmdctrl = 0xA0;
                    cdr.status |= STATUS_BUSYSTS;
                    break;
                case 0xA0:
                    cdr.mode = 0x20;
                    this.enqueueEvent(2, cdr.setStat(STAT_MOTORON, STAT_PLAY | STAT_SEEK | STAT_READ));
                    break;
                case 0x0B:
                    this.enqueueEvent(3, cdr.statusCode);
                    this.mute = true;
                    break;
                case 0x0C:
                    this.enqueueEvent(3, cdr.statusCode);
                    this.mute = false;
                    break;
                case 0x0D:
                    this.filter = { file: cdr.params[0], chan: cdr.params[1] };
                    this.enqueueEvent(3, cdr.statusCode);
                    break;
                case 0x0E:
                    this.mode = cdr.params[0];
                    this.enqueueEvent(3, cdr.statusCode);
                    break;
                case 0x0F:
                    this.enqueueEvent(3, cdr.statusCode, cdr.mode, 0, cdr.filter.file, cdr.filter.chan);
                    break;
                case 0x10:
                    if (!cdr.hasCdFile || (cdr.currTrack && cdr.currTrack.audio)) {
                        cdr.statusCode |= STAT_ERROR;
                        cdr.responsePush(cdr.statusCode);
                        cdr.responsePush(0x80);
                        cdr.status &= ~STATUS_BUSYSTS;
                        cdr.status |= STATUS_RSLRRDY;
                        cdr.setIrq(5);
                        break;
                    }
                    cdr.responsePush(sectorData8[cdr.sectorOffset + 12 + 0]);
                    cdr.responsePush(sectorData8[cdr.sectorOffset + 12 + 1]);
                    cdr.responsePush(sectorData8[cdr.sectorOffset + 12 + 2]);
                    cdr.responsePush(sectorData8[cdr.sectorOffset + 12 + 3]);
                    cdr.responsePush(sectorData8[cdr.sectorOffset + 12 + 4]);
                    cdr.responsePush(sectorData8[cdr.sectorOffset + 12 + 5]);
                    cdr.responsePush(sectorData8[cdr.sectorOffset + 12 + 6]);
                    cdr.responsePush(sectorData8[cdr.sectorOffset + 12 + 7]);
                    cdr.status &= ~STATUS_BUSYSTS;
                    cdr.status |= STATUS_RSLRRDY;
                    cdr.setIrq(3);
                    break;
                case 0x11: {
                    let loc = (cdr.currLoc - 150 - cdr.currTrack.begin);
                    let mm = (loc / (60 * 75)) >> 0;
                    let ss = ((loc / (75)) >> 0) % 60;
                    let st = loc % 75;
                    cdr.responsePush(itob(cdr.currTrack.id));
                    cdr.responsePush(0x01);
                    cdr.responsePush(itob(mm));
                    cdr.responsePush(itob(ss));
                    cdr.responsePush(itob(st));
                    cdr.responsePush(itob((((cdr.currLoc - 150) / 75) / 60) % 60));
                    cdr.responsePush(itob((((cdr.currLoc - 150) / 75) % 60)));
                    cdr.responsePush(itob((((cdr.currLoc - 150) % 75))));
                    cdr.status &= ~STATUS_BUSYSTS;
                    cdr.status |= STATUS_RSLRRDY;
                    cdr.setIrq(3);
                } break;
                case 0x13:
                    console.log(`CdlGetTN`);
                    cdr.statusCode |= STAT_MOTORON;
                    cdr.responsePush(cdr.statusCode);
                    cdr.responsePush(0x01);
                    cdr.responsePush(itob(this.tracks.length - 1));
                    cdr.status &= ~STATUS_BUSYSTS;
                    cdr.status |= STATUS_RSLRRDY;
                    cdr.setIrq(3);
                    break;
                case 0x14: {
                    let mmss = 0;
                    let track = this.tracks[btoi(cdr.params[0])];
                    if (!track) {
                        cdr.statusCode |= STAT_ERROR;
                        cdr.responsePush(cdr.statusCode);
                        cdr.responsePush(0x10);
                        cdr.status &= ~STATUS_BUSYSTS;
                        cdr.status |= STATUS_RSLRRDY;
                        cdr.setIrq(5);
                        break;
                    }
                    if (cdr.params[0] === 0) {
                        mmss = Math.floor((track.end + 150) / 75);
                    } else {
                        mmss = Math.floor((track.begin + 150) / 75);
                    }
                    console.log(`CdlGetTD: ${cdr.params[0]}`, track);
                    cdr.statusCode |= STAT_MOTORON;
                    cdr.responsePush(cdr.statusCode);
                    cdr.responsePush(itob(Math.floor(mmss / 60)));
                    cdr.responsePush(itob(Math.floor(mmss % 60)));
                    cdr.status &= ~STATUS_BUSYSTS;
                    cdr.status |= STATUS_RSLRRDY;
                    cdr.setIrq(3);
                } break;
                case 0x15:
                    psx.setEvent(this.eventCmd, cdr.estimateSeekCycles(cdr.seekLoc - cdr.currLoc));
                    cdr.ncmdctrl = 0x150;
                    this.enqueueEvent(3, cdr.setStat(STAT_SEEK | STAT_MOTORON));
                    cdr.status |= STATUS_BUSYSTS;
                    break;
                case 0x150:
                    this.enqueueEvent(2, cdr.setStat(STAT_MOTORON, STAT_PLAY | STAT_SEEK | STAT_READ));
                    cdr.currLoc = cdr.seekLoc;
                    break;
                case 0x16:
                    psx.setEvent(this.eventCmd, cdr.estimateSeekCycles(cdr.seekLoc - cdr.currLoc));
                    cdr.ncmdctrl = 0x160;
                    this.enqueueEvent(3, cdr.setStat(STAT_SEEK | STAT_MOTORON));
                    cdr.status |= STATUS_BUSYSTS;
                    break;
                case 0x160:
                    this.enqueueEvent(2, cdr.setStat(STAT_MOTORON, STAT_PLAY | STAT_SEEK | STAT_READ));
                    cdr.currLoc = cdr.seekLoc;
                    break;
                case 0x19:
                    switch (cdr.params[0]) {
                        case 0x20: cdr.responsePush(0x97, 0x01, 0x10, 0xC2); break;
                        case 0x21: cdr.responsePush(0x01); break;
                        case 0x22: for (const c of 'for US/AEP') cdr.responsePush(c.charCodeAt(0)); break;
                        case 0x23: for (const c of 'CXD2940Q') cdr.responsePush(c.charCodeAt(0)); break;
                        case 0x24: for (const c of 'CXD2510Q') cdr.responsePush(c.charCodeAt(0)); break;
                        case 0x25: for (const c of 'CXD1815Q') cdr.responsePush(c.charCodeAt(0)); break;
                        default: cdr.responsePush(cdr.statusCode); break;
                    }
                    cdr.status &= ~STATUS_BUSYSTS;
                    cdr.status |= STATUS_RSLRRDY;
                    cdr.setIrq(3);
                    break;
                case 0x1A:
                    psx.setEvent(this.eventCmd, 0x4a00 >>> 0);
                    cdr.responsePush(cdr.statusCode);
                    cdr.ncmdctrl = 0x1A0;
                    cdr.status |= STATUS_RSLRRDY;
                    cdr.setIrq(3);
                    break;
                case 0x1A0:
                    if (cdr.hasCdFile) {
                        cdr.responsePush(0x02, 0x00, 0x20, 0x00);
                        for (const c of 'SCE' + cdr.region) cdr.responsePush(c.charCodeAt(0));
                        cdr.status &= ~STATUS_BUSYSTS;
                        cdr.status |= STATUS_RSLRRDY;
                        cdr.setIrq(2);
                    } else {
                        cdr.statusCode = (cdr.statusCode & ~STAT_MOTORON) | STAT_SHELLOPEN;
                        cdr.responsePush(0x08, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
                        cdr.status &= ~STATUS_BUSYSTS;
                        cdr.status |= STATUS_RSLRRDY;
                        cdr.setIrq(5);
                    }
                    break;
                case 0x1B:
                    psx.setEvent(this.eventRead, readCycles >>> 0);
                    cdr.ncmdread = 0x1B;
                    this.enqueueEvent(3, cdr.setStat(STAT_SEEK | STAT_MOTORON));
                    cdr.currLoc = cdr.seekLoc;
                    break;
                case 0x12: {
                    let session = cdr.params[0];
                    if (session === 0) {
                        cdr.statusCode |= STAT_ERROR;
                        cdr.responsePush(cdr.statusCode);
                        cdr.responsePush(0x10);
                        cdr.status &= ~STATUS_BUSYSTS;
                        cdr.status |= STATUS_RSLRRDY;
                        cdr.setIrq(5);
                        break;
                    }
                    this.enqueueEvent(3, cdr.setStat(STAT_SEEK | STAT_MOTORON));
                    cdr.ncmdctrl = 0x120;
                    cdr.status |= STATUS_BUSYSTS;
                    psx.setEvent(this.eventCmd, 0x1000 >>> 0);
                    break;
                }
                case 0x120:
                    this.enqueueEvent(2, cdr.setStat(STAT_MOTORON, STAT_PLAY | STAT_SEEK | STAT_READ));
                    break;
                case 0x1C: // Reset — reinicia o HC05 (espelha m_cdrom_setup)
                    this.enqueueEvent(3, cdr.statusCode);
                    cdr.mode = 0;
                    cdr.filter = {};
                    cdr.mute = false;
                    cdr.adpcmMute = false;
                    cdr.ncmdread = 0;
                    psx.unsetEvent(cdr.eventRead);
                    break;
                case 0x1E:
                    psx.setEvent(this.eventCmd, 0x1000 >>> 0);
                    cdr.ncmdctrl = 0x1E0;
                    this.enqueueEvent(3, cdr.setStat(STAT_SEEK | STAT_MOTORON));
                    break;
                case 0x1E0:
                    this.enqueueEvent(2, cdr.setStat(STAT_MOTORON, STAT_PLAY | STAT_SEEK | STAT_READ));
                    break;
                default:
                    cdr.statusCode |= STAT_ERROR;
                    cdr.responsePush(cdr.statusCode, 0x40);
                    cdr.status &= ~STATUS_BUSYSTS;
                    cdr.status |= STATUS_RSLRRDY;
                    cdr.setIrq(5);
                    break;
            }
            cdr.lastCommand = currentCommand;
            cdr.resetparams();
        },

        eventRead: null,

        completeRead: function (self, clock) {
            if (cdr.irq & 0x1F) {
                psx.updateEvent(self, 64);
                return;
            }
            let readCycles = 33868800 / ((cdr.mode & 0x80) ? 150 : 75);
            let loc = cdr.currLoc - 150;
            switch (cdr.ncmdread) {
                case 0x03:
                    cdr.playIndex = 0;
                    if (cdr.currLoc === cdr.currTrack.end) {
                        console.log('end-of-track:', cdr.currTrack);
                        if (cdr.mode & 0x02) {
                            console.log('- autopause:');
                            psx.unsetEvent(self);
                            return cdr.command(0x99);
                        }
                    }
                    if ((cdr.mode & 0x05) == 0x05) {
                        switch (loc % 75) {
                            case 0:
                            case 20:
                            case 40:
                            case 60: {
                                let amm = (loc / (60 * 75)) >> 0;
                                let ass = ((loc / (75)) >> 0) % 60;
                                let ast = loc % 75;
                                cdr.responsePush(0x82, itob(cdr.currTrack.id), 1, itob(amm), itob(ass), itob(ast), 0, 0);
                                cdr.status &= ~STATUS_BUSYSTS;
                                cdr.status |= STATUS_DRQSTS;
                                cdr.status |= STATUS_RSLRRDY;
                                cdr.setIrq(1);
                            } break;
                            case 10:
                            case 30:
                            case 50:
                            case 70: {
                                let loc2 = (cdr.currLoc - cdr.currTrack.begin);
                                let amm = (loc2 / (60 * 75)) >> 0;
                                let ass = ((loc2 / (75)) >> 0) % 60;
                                let ast = loc2 % 75;
                                cdr.responsePush(0x82, itob(cdr.currTrack.id), 1, itob(amm), 0x80 | itob(ass), itob(ast), 0, 0);
                                cdr.status &= ~STATUS_BUSYSTS;
                                cdr.status |= STATUS_DRQSTS;
                                cdr.status |= STATUS_RSLRRDY;
                                cdr.setIrq(1);
                            } break;
                        }
                        cdr.readSector(cdr.currLoc);
                        psx.updateEvent(self, readCycles);
                        cdr.currLoc++;
                        break;
                    }
                case 0x04: // Forward
                case 0x05: { // Backward
                    const FFWD_STEP = 8;
                    cdr.currLoc += (cdr.ncmdread === 0x04) ? FFWD_STEP : -FFWD_STEP;
                    if (cdr.currLoc <= cdr.tracks[1].begin + 150) {
                        cdr.currLoc = cdr.tracks[1].begin + 150;
                        psx.unsetEvent(self);
                        return cdr.command(0x03);
                    }
                    const lastTrack = cdr.tracks[cdr.tracks.length - 1];
                    if (lastTrack && cdr.currLoc >= lastTrack.end) {
                        cdr.currLoc = lastTrack.end;
                        cdr.setStat(0, STAT_PLAY | STAT_SEEK | STAT_READ | STAT_MOTORON);
                        cdr.responsePush(cdr.statusCode);
                        cdr.status |= STATUS_RSLRRDY;
                        cdr.setIrq(4);
                        psx.unsetEvent(self);
                        return;
                    }
                    if ((cdr.mode & 0x04) !== 0) {
                        let loc2 = cdr.currLoc - 150;
                        let amm = (loc2 / (60 * 75)) >> 0;
                        let ass = ((loc2 / (75)) >> 0) % 60;
                        let ast = loc2 % 75;
                        cdr.responsePush(cdr.statusCode, itob(cdr.currTrack.id || 1), 1, itob(amm), itob(ass), itob(ast), 0, 0);
                        cdr.status &= ~STATUS_BUSYSTS;
                        cdr.status |= STATUS_DRQSTS;
                        cdr.status |= STATUS_RSLRRDY;
                        cdr.setIrq(1);
                    }
                    psx.updateEvent(self, readCycles);
                    break;
                }
                case 0x06:
                case 0x1b:
                    cdr.responsePush(cdr.setStat(STAT_READ | STAT_MOTORON));
                    cdr.status &= ~STATUS_BUSYSTS;
                    cdr.status |= STATUS_DRQSTS;
                    cdr.status |= STATUS_RSLRRDY;
                    cdr.setIrq(1);
                    cdr.readSector(cdr.currLoc);
                    psx.updateEvent(self, readCycles);
                    cdr.currLoc++;
                    break;
                case 0x00:
                    // Estado ocioso antes do primeiro Play/ReadN/ReadS
                    psx.unsetEvent(this.eventRead);
                    break;
                default:
                    console.log('unimplemented async read: $' + hex(cdr.ncmdread, 2));
                    psx.unsetEvent(this.eventRead);
            }
        },

        readSector: function (readLoc) {
            if (cdr.cdImage === undefined) return;
            for (let i = 1; i < cdr.tracks.length; ++i) {
                let track = cdr.currTrack = cdr.tracks[i];
                if ((track.begin < readLoc) && (readLoc < track.end)) break;
            }
            // [VCD SUPPORT] aplica dataOffset para pular headers
            cdr.sectorOffset = cdr.dataOffset + (readLoc - 150) * 2352;
            switch (cdr.mode & 0x30) {
                case 0x00: cdr.sectorIndex = 24; cdr.sectorSize = 2048; break;
                case 0x10: cdr.sectorIndex = 24; cdr.sectorSize = 2328; break;
                case 0x20:
                case 0x30: cdr.sectorIndex = 12; cdr.sectorSize = 2340; break;
            }
            cdr.sectorEnd = cdr.sectorIndex + cdr.sectorSize;
            if ((cdr.mode & 0x48) !== 0) {
                var mode = sectorData8[cdr.sectorOffset + 0x0f];
                if (mode !== 2) return;
                if ((cdr.mode & 0x48) === 0x48) {
                    var file = sectorData8[cdr.sectorOffset + 0x10];
                    if (file !== cdr.filter.file) return;
                    var chan = sectorData8[cdr.sectorOffset + 0x11];
                    if (chan !== cdr.filter.chan) return;
                }
                var sub = sectorData8[cdr.sectorOffset + 0x12];
                if ((sub & 0x44) !== 0x44) return;
                var nfo = sectorData8[cdr.sectorOffset + 0x13];
                switch ((nfo >>> 0) & 3) {
                    case 0: var ms = 'mono'; break;
                    case 1: var ms = 'stereo'; break;
                }
                switch ((nfo >>> 2) & 1) {
                    case 0: var sr = 37800; break;
                    case 1: var sr = 18900; break;
                }
                switch ((nfo >>> 4) & 3) {
                    case 0: var bs = '4bit'; break;
                    case 1: var bs = '8bit'; break;
                }
                switch ((nfo >>> 6) & 1) {
                    case 0: var em = 'normal'; break;
                    case 1: var em = 'emphasis'; break;
                }
                cdr.pcmidx = 0;
                cdr.xa.fill(0);
                cdr.pcm.fill(0);
                if (ms === 'stereo') {
                    var ix = cdr.decodeStereo();
                }
                if (ms === 'mono') {
                    var ix = cdr.decodeMono();
                }
                var samples = (44100 * ix) / sr;
                var i = 0;
                var upscaleFreq = 0;
                var xa = cdr.xa;
                var ix = -1;
                var pcm = cdr.pcm;
                for (var s = 0; s < samples; s += 2) {
                    pcm[++ix] = xa[i + 0];
                    pcm[++ix] = xa[i + 1];
                    upscaleFreq += sr;
                    if (upscaleFreq >= 44100) {
                        upscaleFreq -= 44100;
                        i += 2;
                    }
                }
                cdr.pcmmax = ix;
            }
        },

        nextpcm: function (buf) {
            if (cdr.mute) {
                buf[0] = 0.0;
                buf[1] = 0.0;
                if (cdr.ncmdread === 0x03) cdr.playIndex += 4;
                else if ((cdr.mode & 0x48) !== 0) cdr.pcmidx += 2;
                return;
            }
            if (cdr.ncmdread === 0x03) {
                if (cdr.currTrack.audio) {
                    const offset = (cdr.sectorOffset + cdr.playIndex) >> 1;
                    let sampleL = sectorData16[offset + 0] / 32768.0;
                    let sampleR = sectorData16[offset + 1] / 32768.0;
                    let sL = sampleL * cdr.volCdLeft2SpuLeft + sampleR * cdr.volCdRight2SpuLeft;
                    let sR = sampleR * cdr.volCdRight2SpuRight + sampleL * cdr.volCdLeft2SpuRight;
                    buf[0] = sL;
                    buf[1] = sR;
                }
                if (cdr.currTrack.data) {
                    buf[0] = 0.0;
                    buf[1] = 0.0;
                }
                cdr.playIndex += 4;
                return;
            }
            if (cdr.adpcmMute) {
                buf[0] = 0.0;
                buf[1] = 0.0;
                return;
            }
            if ((cdr.mode & 0x48) !== 0) {
                if (cdr.pcmidx >= (cdr.pcmmax - 1)) cdr.pcmidx = cdr.pcmmax - 1;
                let sampleL = cdr.pcm[cdr.pcmidx + 0];
                let sampleR = cdr.pcm[cdr.pcmidx + 1];
                let sL = sampleL * cdr.volCdLeft2SpuLeft + sampleR * cdr.volCdRight2SpuLeft;
                let sR = sampleR * cdr.volCdRight2SpuRight + sampleL * cdr.volCdLeft2SpuRight;
                buf[0] = sL;
                buf[1] = sR;
                cdr.pcmidx += 2;
            }
        },

        decodeMono: function () {
            var ix = 0;
            var sl = this.sl;
            var xa = cdr.xa;
            for (var sg = 0; sg < 18; ++sg) {
                var sectorOffset = cdr.sectorOffset + 24 + (sg * 128);
                for (var su = 0; su < 8; ++su) {
                    var shiftFilter = sectorData8[sectorOffset + 4 + su];
                    var shift = (shiftFilter & 0x0f) >>> 0;
                    var filter = (shiftFilter & 0xf0) >>> 3;
                    var k0 = xa2flt[filter + 0];
                    var k1 = xa2flt[filter + 1];
                    for (var sd = 0; sd < 28; ++sd) {
                        const offset = (sectorOffset + 16 + (sd * 4) + (su / 2)) >>> 0;
                        var data = sectorData8[offset] & 0xff;
                        var index = (shift * 256 + data) * 2;
                        var s = (sl[1] * k0) + (sl[0] * k1) + xa2pcm[index + (su & 1)];
                        sl[0] = sl[1];
                        sl[1] = s;
                        xa[ix++] = s;
                        xa[ix++] = s;
                    }
                }
            }
            return ix;
        },

        sl: [0.0, 0.0],
        sr: [0.0, 0.0],

        decodeStereo: function () {
            var ix = 0;
            var sl = this.sl;
            var sr = this.sr;
            var xa = cdr.xa;
            for (var sg = 0; sg < 18; ++sg) {
                var sectorOffset = cdr.sectorOffset + 24 + (sg * 128);
                for (var su = 0; su < 8; su += 2) {
                    var shiftFilter = sectorData8[sectorOffset + 4 + su];
                    var shift = (shiftFilter & 0x0f) >>> 0;
                    var filter = (shiftFilter & 0xf0) >>> 3;
                    var k0 = xa2flt[filter + 0];
                    var k1 = xa2flt[filter + 1];
                    for (var sd = 0; sd < 28; ++sd) {
                        const offset = (sectorOffset + 16 + (sd * 4) + (su / 2)) >>> 0;
                        var data = sectorData8[offset] & 0xff;
                        var index = (shift * 256 + data) * 2;
                        var s = (sr[1] * k0) + (sr[0] * k1) + xa2pcm[index + 0];
                        sr[0] = sr[1];
                        sr[1] = s;
                        xa[ix + sd * 2 + 0] = s;
                    }
                    var shiftFilter = sectorData8[sectorOffset + 5 + su];
                    var shift = (shiftFilter & 0x0f) >>> 0;
                    var filter = (shiftFilter & 0xf0) >>> 3;
                    var k0 = xa2flt[filter + 0];
                    var k1 = xa2flt[filter + 1];
                    for (var sd = 0; sd < 28; ++sd) {
                        const offset = (sectorOffset + 16 + (sd * 4) + (su / 2)) >>> 0;
                        var data = sectorData8[offset] & 0xff;
                        var index = (shift * 256 + data) * 2;
                        var s = (sr[1] * k0) + (sr[0] * k1) + xa2pcm[index + 1];
                        sr[0] = sr[1];
                        sr[1] = s;
                        xa[ix + sd * 2 + 1] = s;
                    }
                    ix += 2 * 28;
                }
            }
            return ix;
        },

        stopReading: function () {
            psx.unsetEvent(cdr.eventRead);
            cdr.statusCode &= ~STAT_PLAY;
            cdr.statusCode &= ~STAT_READ;
            cdr.ncmdread = 0;
        },

        dmaTransferMode0000: function (addr, blck) {
            var transferSize = (blck & 0xFFFF) << 2;
            clearCodeCache(addr, transferSize);
            for (var i = 0; i < transferSize; i += 4) {
                map[(addr & 0x001fffff) >> 2] = sectorData32[(cdr.sectorOffset + cdr.sectorIndex) >> 2];
                cdr.sectorIndex += 4;
                addr += 4;
            }
            if (cdr.sectorIndex >= cdr.sectorEnd) {
                cdr.status &= ~STATUS_DRQSTS;
            }
            return transferSize;
        },

        setTOC: function (tracks) {
            this.tracks = tracks;
        },

        // [VCD SUPPORT] recebe offset opcional para pular headers no início do buffer
        setCdImage: function (data, offset = 0) {
            sectorData32 = new Int32Array(data.buffer);
            sectorData16 = new Int16Array(data.buffer);
            sectorData8 = new Int8Array(data.buffer);
            cdr.hasCdFile = true;
            cdr.cdImage = data;
            cdr.dataOffset = offset || 0;
        }
    };

    scope.cdr = Object.seal(cdr);
})(window);