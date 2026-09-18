// chd.js
// Decoder CHD v5 (MAME Compressed Hunks of Data) para uso em emuladores JS.
//
// CORRIGIDO em relação à versão anterior:
// 1. O header do mapa v5 tem 17 bytes, não 16. firstoffs é UINT64 (8 bytes), não 48 bits (6 bytes).
// 2. Adicionado suporte aos novos tipos de compressão v5.2+: COMPRESSION_SELF_HUNK (14) e COMPRESSION_PARENT_HUNK (15).
//
// Layout do header v5 (fonte: libchdr/include/libchdr/chd.h):
//   [ 0] char   tag[8]           'MComprHD'
//   [ 8] uint32 length
//   [12] uint32 version
//   [16] uint32 compressors[4]
//   [32] uint64 logicalbytes
//   [40] uint64 mapoffset
//   [48] uint64 metaoffset
//   [56] uint32 hunkbytes
//   [60] uint32 unitbytes
//   [64] uint8  rawsha1[20]
//   [84] uint8  sha1[20]
//   [104] uint8 parentsha1[20]
//   [124] fim do header v5
//
// Layout do header do mapa v5 (map_header):
//   [ 0] uint32 mapbytes       (tamanho do stream comprimido)
//   [ 4] uint64 firstoffs      (offset do primeiro hunk no arquivo)
//   [12] uint16 mapcrc         (CRC16 do mapa descomprimido)
//   [14] uint8  lengthbits     (bits usados para codificar length)
//   [15] uint8  selfbits       (bits usados para codificar offset SELF)
//   [16] uint8  parentbits     (bits usados para codificar offset PARENT)
//   [17] início do stream comprimido
//
(scope => {
'use strict';

const CHD_TAG = 'MComprHD';

// Tipos de entrada de mapa v5 (fonte: libchdr_chd.c, enum V5 compression types)
const COMPRESSION_TYPE_0 = 0;
const COMPRESSION_TYPE_1 = 1;
const COMPRESSION_TYPE_2 = 2;
const COMPRESSION_TYPE_3 = 3;
const COMPRESSION_NONE = 4;
const COMPRESSION_SELF = 5;
const COMPRESSION_PARENT = 6;
const COMPRESSION_RLE_SMALL = 7;
const COMPRESSION_RLE_LARGE = 8;
const COMPRESSION_SELF_0 = 9;
const COMPRESSION_SELF_1 = 10;
const COMPRESSION_PARENT_SELF = 11;
const COMPRESSION_PARENT_0 = 12;
const COMPRESSION_PARENT_1 = 13;
const COMPRESSION_SELF_HUNK = 14;      // v5.2+: referencia o hunk anterior (h-1)
const COMPRESSION_PARENT_HUNK = 15;    // v5.2+: referencia o mesmo LBA no CHD pai

function asUint8Array(x) {
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    throw new Error('CHD: buffer inválido');
}

function isChdBuffer(buffer) {
    try {
        const u8 = asUint8Array(buffer);
        if (u8.byteLength < 8) return false;
        return String.fromCharCode(u8[0], u8[1], u8[2], u8[3], u8[4], u8[5], u8[6], u8[7]) === CHD_TAG;
    } catch (e) {
        return false;
    }
}

function toArrayBuffer(u8) {
    if (u8 instanceof ArrayBuffer) return u8;
    if (u8.buffer instanceof ArrayBuffer && u8.byteOffset === 0 && u8.buffer.byteLength === u8.byteLength) {
        return u8.buffer;
    }
    return u8.slice().buffer;
}

function fourccToString(val) {
    if (val === 0) return 'none';
    return String.fromCharCode(
        (val >>> 24) & 0xff,
        (val >>> 16) & 0xff,
        (val >>> 8) & 0xff,
        val & 0xff
    );
}

// ---- leitura big-endian (CHD v5 é sempre big-endian) ----
function be32(dv, off) { return dv.getUint32(off, false) >>> 0; }

function be64AsNumber(dv, off) {
    const hi = dv.getUint32(off, false);
    const lo = dv.getUint32(off + 4, false);
    return hi * 4294967296 + lo;
}

function be48AsNumber(u8, off) {
    return (u8[off] * 0x10000000000) + (u8[off + 1] * 0x100000000) +
        (u8[off + 2] * 0x1000000) + (u8[off + 3] << 16) + (u8[off + 4] << 8) + u8[off + 5];
}

// ---- CRC16 (polinômio CCITT 0x1021) ----
const CRC16_TABLE = (() => {
    const table = new Uint16Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i << 8;
        for (let j = 0; j < 8; j++) {
            c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
        }
        table[i] = c;
    }
    return table;
})();

function crc16(data) {
    let crc = 0xffff;
    for (let i = 0; i < data.length; i++) {
        crc = (((crc << 8) & 0xffff) ^ CRC16_TABLE[((crc >> 8) ^ data[i]) & 0xff]) & 0xffff;
    }
    return crc;
}

// ---- leitor de bits MSB-first ----
class BitStreamIn {
    constructor(buf) {
        this.buf = buf;
        this.bitpos = 0;
        this.totalbits = buf.length * 8;
        this.overflow = false;
    }
    read(numbits) {
        let result = 0;
        for (let i = 0; i < numbits; i++) {
            result = (result << 1) | this._readBit();
        }
        return result >>> 0;
    }
    _readBit() {
        if (this.bitpos >= this.totalbits) {
            this.overflow = true;
            return 0;
        }
        const byteIndex = this.bitpos >> 3;
        const bitIndex = 7 - (this.bitpos & 7);
        const bit = (this.buf[byteIndex] >> bitIndex) & 1;
        this.bitpos++;
        return bit;
    }
}

// ---- decodificador Huffman canônico ----
class HuffmanDecoder {
    constructor(numCodes, maxBits) {
        this.numCodes = numCodes;
        this.maxBits = maxBits;
        this.lengths = new Uint8Array(numCodes);
        this.codes = new Uint16Array(numCodes);
        this.lookupBits = maxBits;
        this.lookup = null;
    }
    
    importTreeRLE(bs) {
        const numbits = 4;
        let curcode = 0;
        let lastLen = 0;
        while (curcode < this.numCodes) {
            if (bs.overflow) throw new Error('CHD: bitstream do mapa terminou antes do esperado (árvore Huffman)');
            const val = bs.read(numbits);
            if (val <= this.maxBits) {
                this.lengths[curcode++] = val;
                lastLen = val;
            } else {
                const repeatBits = bs.read(numbits);
                let repcount = repeatBits + (val - this.maxBits) * 16 + 2;
                while (repcount-- > 0 && curcode < this.numCodes) {
                    this.lengths[curcode++] = lastLen;
                }
            }
        }
        this._assignCanonicalCodesAndBuildLookup();
    }
    
    _assignCanonicalCodesAndBuildLookup() {
        const maxBits = this.maxBits;
        const countPerLength = new Array(maxBits + 1).fill(0);
        for (let i = 0; i < this.numCodes; i++) countPerLength[this.lengths[i]]++;
        let code = 0;
        const firstCode = new Array(maxBits + 1).fill(0);
        countPerLength[0] = 0;
        for (let len = 1; len <= maxBits; len++) {
            code = (code + countPerLength[len - 1]) << 1;
            firstCode[len] = code;
        }
        const nextCode = firstCode.slice();
        this.lookup = new Int16Array(1 << maxBits).fill(-1);
        for (let sym = 0; sym < this.numCodes; sym++) {
            const len = this.lengths[sym];
            if (len === 0) continue;
            const c = nextCode[len]++;
            this.codes[sym] = c;
            const shift = maxBits - len;
            const base = c << shift;
            const count = 1 << shift;
            for (let k = 0; k < count; k++) this.lookup[base + k] = sym;
        }
    }
    
    decodeOne(bs) {
        const maxBits = this.maxBits;
        let peekVal = 0;
        const savedPos = bs.bitpos;
        for (let i = 0; i < maxBits; i++) peekVal = (peekVal << 1) | bs._readBit();
        const sym = this.lookup[peekVal];
        if (sym < 0) throw new Error('CHD: código Huffman inválido no mapa');
        const used = this.lengths[sym];
        bs.bitpos = savedPos + used;
        return sym;
    }
}

// CORRIGIDO: O header do mapa tem 17 bytes. firstoffs é UINT64 (8 bytes).
function readMapHeader17(dv, u8, mapoffset) {
    const mapbytes = be32(dv, mapoffset);
    const firstoffs = be64AsNumber(dv, mapoffset + 4); // 8 bytes, não 6!
    const mapcrc = dv.getUint16(mapoffset + 12, false);
    const lengthbits = u8[mapoffset + 14];
    const selfbits = u8[mapoffset + 15];
    const parentbits = u8[mapoffset + 16];
    return { mapbytes, firstoffs, mapcrc, lengthbits, selfbits, parentbits };
}

function decompressV5Map(u8, dv, header) {
    const mh = readMapHeader17(dv, u8, header.mapoffset);
    const compBytesStart = header.mapoffset + 17; // CORRIGIDO: 17 bytes de header
    const compressed = u8.subarray(compBytesStart, compBytesStart + mh.mapbytes);
    const bs = new BitStreamIn(compressed);
    const decoder = new HuffmanDecoder(16, 8);
    decoder.importTreeRLE(bs);
    
    const rawTypes = new Uint8Array(header.totalhunks);
    let repcount = 0;
    let lastcomp = 0;
    for (let h = 0; h < header.totalhunks; h++) {
        if (repcount > 0) {
            rawTypes[h] = lastcomp;
            repcount--;
            continue;
        }
        if (bs.overflow) throw new Error('CHD: bitstream do mapa terminou antes do esperado (tipos)');
        const val = decoder.decodeOne(bs);
        if (val === COMPRESSION_RLE_SMALL) {
            rawTypes[h] = lastcomp;
            repcount = 2 + decoder.decodeOne(bs);
        } else if (val === COMPRESSION_RLE_LARGE) {
            rawTypes[h] = lastcomp;
            repcount = 2 + 16 + (decoder.decodeOne(bs) << 4);
            repcount += decoder.decodeOne(bs);
        } else {
            rawTypes[h] = lastcomp = val;
        }
    }
    
    const entries = new Array(header.totalhunks);
    let curoffset = mh.firstoffs;
    let lastSelf = 0;
    let lastParent = 0;
    const rawmapBytes = new Uint8Array(header.totalhunks * 12);
    
    for (let h = 0; h < header.totalhunks; h++) {
        let type = rawTypes[h];
        let offset = curoffset;
        let length = 0;
        let crc = 0;
        
        switch (type) {
            case COMPRESSION_TYPE_0:
            case COMPRESSION_TYPE_1:
            case COMPRESSION_TYPE_2:
            case COMPRESSION_TYPE_3:
                length = bs.read(mh.lengthbits);
                curoffset += length;
                crc = bs.read(16);
                break;
            case COMPRESSION_NONE:
                length = header.hunkbytes;
                curoffset += length;
                crc = bs.read(16);
                break;
            case COMPRESSION_SELF:
                offset = lastSelf = bs.read(mh.selfbits);
                break;
            case COMPRESSION_PARENT:
                offset = bs.read(mh.parentbits);
                lastParent = offset;
                break;
            case COMPRESSION_SELF_1:
                lastSelf++;
                type = COMPRESSION_SELF;
                offset = lastSelf;
                break;
            case COMPRESSION_SELF_0:
                type = COMPRESSION_SELF;
                offset = lastSelf;
                break;
            case COMPRESSION_PARENT_SELF:
                type = COMPRESSION_PARENT;
                offset = lastParent = Math.floor((h * header.hunkbytes) / header.unitbytes);
                break;
            case COMPRESSION_PARENT_1:
                lastParent += Math.floor(header.hunkbytes / header.unitbytes);
                type = COMPRESSION_PARENT;
                offset = lastParent;
                break;
            case COMPRESSION_PARENT_0:
                type = COMPRESSION_PARENT;
                offset = lastParent;
                break;
            // NOVOS TIPOS v5.2+
            case COMPRESSION_SELF_HUNK:
                type = COMPRESSION_SELF;
                offset = lastSelf = h - 1;
                break;
            case COMPRESSION_PARENT_HUNK:
                type = COMPRESSION_PARENT;
                offset = Math.floor((h * header.hunkbytes) / header.unitbytes);
                lastParent = offset;
                break;
            default:
                throw new Error(`CHD: tipo de entrada de mapa desconhecido (${type}) no hunk ${h}`);
        }
        
        entries[h] = { type, length, offset };
        
        const o = h * 12;
        rawmapBytes[o + 1] = (length >>> 16) & 0xff;
        rawmapBytes[o + 2] = (length >>> 8) & 0xff;
        rawmapBytes[o + 3] = length & 0xff;
        rawmapBytes[o + 4] = Math.floor(offset / 0x10000000000) & 0xff;
        rawmapBytes[o + 5] = Math.floor(offset / 0x100000000) & 0xff;
        rawmapBytes[o + 6] = (offset >>> 24) & 0xff;
        rawmapBytes[o + 7] = (offset >>> 16) & 0xff;
        rawmapBytes[o + 8] = (offset >>> 8) & 0xff;
        rawmapBytes[o + 9] = offset & 0xff;
        rawmapBytes[o + 10] = (crc >>> 8) & 0xff;
        rawmapBytes[o + 11] = crc & 0xff;
    }
    
    const computedCrc = crc16(rawmapBytes);
    if (computedCrc !== mh.mapcrc) {
        throw new Error(
            `CHD: CRC16 do mapa não confere (esperado 0x${mh.mapcrc.toString(16)}, obtido 0x${computedCrc.toString(16)}). ` +
            `Converta o CHD com: chdman extractcd -i arquivo.chd -o arquivo.cue`
        );
    }
    return entries;
}

async function inflateZlibOrRaw(data) {
    if (scope.pako && scope.pako.inflate) {
        try { return scope.pako.inflate(data); } catch (e) {}
    }
    if (scope.pako && scope.pako.inflateRaw) {
        try { return scope.pako.inflateRaw(data); } catch (e) {}
    }
    if (typeof DecompressionStream !== 'function') {
        throw new Error('DecompressionStream indisponível. Inclua pako.js no HTML.');
    }
    try {
        let end = data.length;
        let start = 0;
        if (data.length > 2 && (data[0] === 0x78 || (data[0] & 0x0f) === 0x08)) {
            start = 2;
            end = data.length - 4;
            if (end < start) end = data.length;
        }
        const ds = new DecompressionStream('deflate');
        const stream = new Blob([data.subarray(start, end)]).stream().pipeThrough(ds);
        const ab = await new Response(stream).arrayBuffer();
        return new Uint8Array(ab);
    } catch (e1) {
        try {
            const ds = new DecompressionStream('deflate-raw');
            const stream = new Blob([data]).stream().pipeThrough(ds);
            const ab = await new Response(stream).arrayBuffer();
            return new Uint8Array(ab);
        } catch (e2) {
            throw new Error('Falha na descompressão (zlib/deflate)');
        }
    }
}

function parseChdHeader(dv, u8, fileSize) {
    const tagBytes = u8.subarray(0, 8);
    const tag = String.fromCharCode(...tagBytes);
    if (tag !== CHD_TAG) throw new Error('Não é CHD');
    const headerLength = be32(dv, 8);
    const version = be32(dv, 12);
    if (version !== 5) {
        throw new Error(`CHD v${version} não suportado. Converta para v5 com chdman.`);
    }
    const compressors = [be32(dv, 0x10), be32(dv, 0x14), be32(dv, 0x18), be32(dv, 0x1C)];
    const logicalbytes = be64AsNumber(dv, 0x20);
    const mapoffset = be64AsNumber(dv, 0x28);
    const metaoffset = be64AsNumber(dv, 0x30);
    const hunkbytes = be32(dv, 0x38);
    const unitbytes = be32(dv, 0x3C);
    
    if (!hunkbytes || !unitbytes || !logicalbytes) {
        throw new Error('CHD: header v5 com campos inválidos.');
    }
    
    const totalhunks = Math.ceil(logicalbytes / hunkbytes);
    const unitcount = Math.ceil(logicalbytes / unitbytes);
    const codecNames = compressors.map(fourccToString);
    const hasFlac = codecNames.some(n => n.includes('fl'));
    const hasLzma = codecNames.some(n => n.includes('lz'));
    const isNoneCompressed = compressors[0] === 0;
    
    console.log(`[CHD] v5 header: logical=${logicalbytes}, hunkbytes=${hunkbytes}, totalhunks=${totalhunks}, unitbytes=${unitbytes}, codecs=[${codecNames.join(', ')}]`);
    
    return {
        headerLength, version, logicalbytes, mapoffset, metaoffset,
        hunkbytes, totalhunks, unitbytes, unitcount, compressors, codecNames,
        hasFlac, hasLzma, isNoneCompressed
    };
}

async function decompressHunk(comp, expectedSize, codecName) {
    if (comp.length === 0) return new Uint8Array(expectedSize);
    
    if (/^cd/.test(codecName)) {
        throw new Error(
            `Codec '${codecName}' (CD com split de subcanal/ECC) não é suportado por este decoder. ` +
            `Use core/chd-cd.js ou converta o CHD.`
        );
    }
    if (codecName.includes('flac')) {
        throw new Error('Codec FLAC não suportado em JS. Converta o CHD.');
    }
    if (codecName.includes('lzma')) {
        throw new Error('Codec LZMA não suportado em JS. Converta o CHD.');
    }
    if (codecName.includes('huff')) {
        throw new Error('Codec Huffman genérico não suportado em JS. Converta o CHD.');
    }
    if (codecName.includes('zstd')) {
        throw new Error('Codec Zstandard não suportado em JS. Converta o CHD.');
    }
    
    try {
        return await inflateZlibOrRaw(comp);
    } catch (e) {
        if (comp.length === expectedSize) {
            console.warn('[CHD] Falha na descompressão, usando dados crus.');
            return comp;
        }
        throw e;
    }
}

function stripSubchannel(data) {
    if (data.length % 2448 !== 0) return data;
    const sectors = data.length / 2448;
    const out = new Uint8Array(sectors * 2352);
    for (let i = 0; i < sectors; i++) {
        out.set(data.subarray(i * 2448, i * 2448 + 2352), i * 2352);
    }
    return out;
}

async function decodeChdToUint8Array(input, onProgress) {
    const u8all = asUint8Array(input);
    const ab = toArrayBuffer(u8all);
    const dv = new DataView(ab);
    const u8 = new Uint8Array(ab);
    const fileSize = ab.byteLength;
    
    if (!isChdBuffer(input)) throw new Error('Não é CHD');
    const header = parseChdHeader(dv, u8, fileSize);
    
    let mapEntries;
    if (header.isNoneCompressed) {
        mapEntries = new Array(header.totalhunks);
        for (let h = 0; h < header.totalhunks; h++) {
            const off = header.mapoffset + h * 12;
            const length = (u8[off + 1] << 16) | (u8[off + 2] << 8) | u8[off + 3];
            const offset = be48AsNumber(u8, off + 4);
            mapEntries[h] = { type: length === header.hunkbytes ? COMPRESSION_NONE : COMPRESSION_TYPE_0, length, offset };
        }
    } else {
        mapEntries = decompressV5Map(u8, dv, header);
    }
    
    let out = new Uint8Array(header.logicalbytes);
    
    for (let h = 0; h < header.totalhunks; h++) {
        const entry = mapEntries[h];
        const dst = h * header.hunkbytes;
        const dstLen = Math.min(header.hunkbytes, out.length - dst);
        if (dstLen <= 0) break;
        
        if (entry.type === COMPRESSION_NONE) {
            const src = u8.subarray(entry.offset, entry.offset + dstLen);
            out.set(src, dst);
        } else if (entry.type === COMPRESSION_SELF) {
            const srcOff = entry.offset * header.hunkbytes;
            out.copyWithin(dst, srcOff, srcOff + dstLen);
        } else if (entry.type === COMPRESSION_PARENT) {
            throw new Error(`CHD: hunk ${h} referencia um CHD pai, não suportado.`);
        } else {
            const codecIdx = entry.type;
            const codecName = header.codecNames[codecIdx] || 'unknown';
            const comp = u8.subarray(entry.offset, entry.offset + entry.length);
            try {
                const dec = await decompressHunk(comp, dstLen, codecName);
                if (dec.length >= dstLen) {
                    out.set(dec.subarray(0, dstLen), dst);
                } else {
                    out.set(dec, dst);
                    out.fill(0, dst + dec.length, dst + dstLen);
                }
            } catch (e) {
                console.error(`[CHD] Erro no hunk ${h} (${codecName}):`, e);
                throw e;
            }
        }
        
        if (onProgress && (h % 100 === 0 || h === header.totalhunks - 1)) {
            onProgress(h, header.totalhunks);
        }
        if (h % 500 === 0) await new Promise(r => setTimeout(r, 0));
    }
    
    if (header.unitbytes === 2448) {
        console.log('[CHD] Removendo subchannel (2448 -> 2352)...');
        out = stripSubchannel(out);
    }
    
    console.log(`[CHD] Decodificado com sucesso: ${out.length} bytes`);
    return out;
}

async function decodeChdToArrayBuffer(input, onProgress) {
    const u8 = await decodeChdToUint8Array(input, onProgress);
    return toArrayBuffer(u8);
}

scope.isChdBuffer = isChdBuffer;
scope.decodeChdToUint8Array = decodeChdToUint8Array;
scope.decodeChdToArrayBuffer = decodeChdToArrayBuffer;

})(typeof window !== 'undefined' ? window : globalThis);