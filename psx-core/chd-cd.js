// core/chd-cd.js
// Extensão do chd.js para suportar CDs (PS1, Saturn, etc.) em formato CHD v5.
// Implementa codecs CD (cdzl) + reconstrução de setores + ECC/EDC.
(scope => {
'use strict';

if (!scope.decodeChdToUint8Array && !scope.isChdBuffer) {
    throw new Error('chd-cd.js requer chd.js carregado primeiro');
}

const CHD_TAG = 'MComprHD';
const COMPRESSION_NONE = 4;
const COMPRESSION_SELF = 5;
const COMPRESSION_PARENT = 6;
const COMPRESSION_RLE_SMALL = 7;
const COMPRESSION_RLE_LARGE = 8;

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

const CRC16_TABLE = (() => {
    const table = new Uint16Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i << 8;
        for (let j = 0; j < 8; j++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
        table[i] = c;
    }
    return table;
})();
function crc16(data) {
    let crc = 0xffff;
    for (let i = 0; i < data.length; i++) crc = (((crc << 8) & 0xffff) ^ CRC16_TABLE[((crc >> 8) ^ data[i]) & 0xff]) & 0xffff;
    return crc;
}

class BitStreamIn {
    constructor(buf) { this.buf = buf; this.bitpos = 0; this.totalbits = buf.length * 8; this.overflow = false; }
    read(numbits) {
        let result = 0;
        for (let i = 0; i < numbits; i++) result = (result << 1) | this._readBit();
        return result >>> 0;
    }
    _readBit() {
        if (this.bitpos >= this.totalbits) { this.overflow = true; return 0; }
        const byteIndex = this.bitpos >> 3;
        const bitIndex = 7 - (this.bitpos & 7);
        const bit = (this.buf[byteIndex] >> bitIndex) & 1;
        this.bitpos++;
        return bit;
    }
}

class HuffmanDecoder {
    constructor(numCodes, maxBits) {
        this.numCodes = numCodes; this.maxBits = maxBits;
        this.lengths = new Uint8Array(numCodes); this.codes = new Uint16Array(numCodes);
        this.lookup = null;
    }
    importTreeRLE(bs) {
        const numbits = 4; let curcode = 0; let lastLen = 0;
        while (curcode < this.numCodes) {
            if (bs.overflow) throw new Error('CHD: bitstream do mapa terminou antes do esperado');
            const val = bs.read(numbits);
            if (val <= this.maxBits) { this.lengths[curcode++] = val; lastLen = val; }
            else {
                const repeatBits = bs.read(numbits);
                let repcount = repeatBits + (val - this.maxBits) * 16 + 2;
                while (repcount-- > 0 && curcode < this.numCodes) this.lengths[curcode++] = lastLen;
            }
        }
        this._assignCanonicalCodesAndBuildLookup();
    }
    _assignCanonicalCodesAndBuildLookup() {
        const maxBits = this.maxBits;
        const countPerLength = new Array(maxBits + 1).fill(0);
        for (let i = 0; i < this.numCodes; i++) countPerLength[this.lengths[i]]++;
        let code = 0; const firstCode = new Array(maxBits + 1).fill(0);
        countPerLength[0] = 0;
        for (let len = 1; len <= maxBits; len++) { code = (code + countPerLength[len - 1]) << 1; firstCode[len] = code; }
        const nextCode = firstCode.slice();
        this.lookup = new Int16Array(1 << maxBits).fill(-1);
        for (let sym = 0; sym < this.numCodes; sym++) {
            const len = this.lengths[sym]; if (len === 0) continue;
            const c = nextCode[len]++; this.codes[sym] = c;
            const shift = maxBits - len; const base = c << shift; const count = 1 << shift;
            for (let k = 0; k < count; k++) this.lookup[base + k] = sym;
        }
    }
    decodeOne(bs) {
        const maxBits = this.maxBits; let peekVal = 0; const savedPos = bs.bitpos;
        for (let i = 0; i < maxBits; i++) peekVal = (peekVal << 1) | bs._readBit();
        const sym = this.lookup[peekVal];
        if (sym < 0) throw new Error('CHD: código Huffman inválido no mapa');
        const used = this.lengths[sym]; bs.bitpos = savedPos + used;
        return sym;
    }
}

// CORRIGIDO: O header do mapa tem 17 bytes, não 16. firstoffs é UINT64 (8 bytes).
function readMapHeader(dv, u8, mapoffset) {
    const mapbytes = be32(dv, mapoffset);
    const firstoffs = be64AsNumber(dv, mapoffset + 4); // 8 bytes
    const mapcrc = dv.getUint16(mapoffset + 12, false); // 2 bytes
    const lengthbits = u8[mapoffset + 14];
    const selfbits = u8[mapoffset + 15];
    const parentbits = u8[mapoffset + 16];
    return { mapbytes, firstoffs, mapcrc, lengthbits, selfbits, parentbits };
}

function decompressV5Map(u8, dv, header) {
    const mh = readMapHeader(dv, u8, header.mapoffset);
    const compBytesStart = header.mapoffset + 17; // CORRIGIDO: 17 bytes de header
    const compressed = u8.subarray(compBytesStart, compBytesStart + mh.mapbytes);
    const bs = new BitStreamIn(compressed);
    const decoder = new HuffmanDecoder(16, 8);
    decoder.importTreeRLE(bs);
    
    const rawTypes = new Uint8Array(header.totalhunks);
    let repcount = 0; let lastcomp = 0;
    for (let h = 0; h < header.totalhunks; h++) {
        if (repcount > 0) { rawTypes[h] = lastcomp; repcount--; continue; }
        if (bs.overflow) throw new Error('CHD: bitstream do mapa terminou antes do esperado (tipos)');
        const val = decoder.decodeOne(bs);
        if (val === COMPRESSION_RLE_SMALL) { rawTypes[h] = lastcomp; repcount = 2 + decoder.decodeOne(bs); }
        else if (val === COMPRESSION_RLE_LARGE) {
            rawTypes[h] = lastcomp;
            repcount = 2 + 16 + (decoder.decodeOne(bs) << 4);
            repcount += decoder.decodeOne(bs);
        } else { rawTypes[h] = lastcomp = val; }
    }
    
    const entries = new Array(header.totalhunks);
    let curoffset = mh.firstoffs; let lastSelf = 0; let lastParent = 0;
    const rawmapBytes = new Uint8Array(header.totalhunks * 12);
    
    for (let h = 0; h < header.totalhunks; h++) {
        let type = rawTypes[h]; let offset = curoffset; let length = 0; let crc = 0;
        switch (type) {
            case 0: case 1: case 2: case 3:
                length = bs.read(mh.lengthbits); curoffset += length; crc = bs.read(16); break;
            case COMPRESSION_NONE:
                length = header.hunkbytes; curoffset += length; crc = bs.read(16); break;
            case COMPRESSION_SELF: offset = lastSelf = bs.read(mh.selfbits); break;
            case COMPRESSION_PARENT: offset = bs.read(mh.parentbits); lastParent = offset; break;
            case 9: lastSelf++; type = COMPRESSION_SELF; offset = lastSelf; break;
            case 10: type = COMPRESSION_SELF; offset = lastSelf; break;
            case 11: type = COMPRESSION_PARENT; offset = lastParent = Math.floor((h * header.hunkbytes) / header.unitbytes); break;
            case 12: lastParent += Math.floor(header.hunkbytes / header.unitbytes); type = COMPRESSION_PARENT; offset = lastParent; break;
            case 13: type = COMPRESSION_PARENT; offset = lastParent; break;
            default: throw new Error(`CHD: tipo de entrada de mapa desconhecido (${type}) no hunk ${h}`);
        }
        entries[h] = { type, length, offset };
        const o = h * 12;
        rawmapBytes[o + 1] = (length >>> 16) & 0xff; rawmapBytes[o + 2] = (length >>> 8) & 0xff; rawmapBytes[o + 3] = length & 0xff;
        rawmapBytes[o + 4] = Math.floor(offset / 0x10000000000) & 0xff; rawmapBytes[o + 5] = Math.floor(offset / 0x100000000) & 0xff;
        rawmapBytes[o + 6] = (offset >>> 24) & 0xff; rawmapBytes[o + 7] = (offset >>> 16) & 0xff;
        rawmapBytes[o + 8] = (offset >>> 8) & 0xff; rawmapBytes[o + 9] = offset & 0xff;
        rawmapBytes[o + 10] = (crc >>> 8) & 0xff; rawmapBytes[o + 11] = crc & 0xff;
    }
    
    const computedCrc = crc16(rawmapBytes);
    if (computedCrc !== mh.mapcrc) {
        throw new Error(`CHD: CRC16 do mapa não confere (esperado 0x${mh.mapcrc.toString(16)}, obtido 0x${computedCrc.toString(16)}).`);
    }
    return entries;
}

async function inflateZlibOrRaw(data) {
    if (scope.pako && scope.pako.inflate) { try { return scope.pako.inflate(data); } catch (e) {} }
    if (scope.pako && scope.pako.inflateRaw) { try { return scope.pako.inflateRaw(data); } catch (e) {} }
    if (typeof DecompressionStream !== 'function') throw new Error('DecompressionStream indisponível. Inclua pako.js no HTML.');
    try {
        let end = data.length, start = 0;
        if (data.length > 2 && (data[0] === 0x78 || (data[0] & 0x0f) === 0x08)) { start = 2; end = data.length - 4; if (end < start) end = data.length; }
        const ds = new DecompressionStream('deflate');
        const stream = new Blob([data.subarray(start, end)]).stream().pipeThrough(ds);
        return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e1) {
        const ds = new DecompressionStream('deflate-raw');
        const stream = new Blob([data]).stream().pipeThrough(ds);
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }
}

function parseChdHeader(dv, u8, fileSize) {
    const tag = String.fromCharCode(...u8.subarray(0, 8));
    if (tag !== CHD_TAG) throw new Error('Não é CHD');
    const version = be32(dv, 12);
    if (version !== 5) throw new Error(`CHD v${version} não suportado.`);
    const compressors = [be32(dv, 0x10), be32(dv, 0x14), be32(dv, 0x18), be32(dv, 0x1C)];
    const logicalbytes = be64AsNumber(dv, 0x20);
    const mapoffset = be64AsNumber(dv, 0x28);
    const hunkbytes = be32(dv, 0x38);
    const unitbytes = be32(dv, 0x3C);
    if (!hunkbytes || !unitbytes || !logicalbytes) throw new Error('CHD: header v5 com campos inválidos.');
    const totalhunks = Math.ceil(logicalbytes / hunkbytes);
    const fourccToString = (val) => val === 0 ? 'none' : String.fromCharCode((val>>>24)&0xff, (val>>>16)&0xff, (val>>>8)&0xff, val&0xff);
    const codecNames = compressors.map(fourccToString);
    return { logicalbytes, mapoffset, hunkbytes, totalhunks, unitbytes, codecNames, isNoneCompressed: compressors[0] === 0 };
}

const EDC_TABLE = new Uint32Array(256);
const ECC_F_TABLE = new Uint8Array(256);
(function initTables() {
    for (let i = 0; i < 256; i++) {
        let edc = i;
        for (let j = 0; j < 8; j++) edc = (edc >>> 1) ^ (edc & 1 ? 0xD8018001 : 0);
        EDC_TABLE[i] = edc;
        let ecc_f = i << 1; if (ecc_f & 0x100) ecc_f = (ecc_f ^ 0x11D) & 0xFF;
        ECC_F_TABLE[i] = ecc_f;
    }
})();

function edcCompute(data, offset, length) {
    let edc = 0;
    for (let i = 0; i < length; i++) edc = (edc >>> 8) ^ EDC_TABLE[(edc ^ data[offset + i]) & 0xFF];
    return edc;
}

function eccCompute(data, offset, majorCount, minorCount, majorMult, minorMult, eccOffset) {
    for (let major = 0; major < majorCount; major++) {
        let ecc_a = 0, ecc_b = 0;
        for (let minor = 0; minor < minorCount; minor++) {
            const idx = ((major * majorMult + minor * minorMult) % (majorCount * minorMult)) + offset;
            const temp = data[idx]; ecc_a = ECC_F_TABLE[ecc_a ^ temp]; ecc_b ^= temp;
        }
        data[eccOffset + major * 2] = ecc_a ^ ecc_b; data[eccOffset + major * 2 + 1] = ecc_b;
    }
    for (let major = 0; major < majorCount; major++) {
        let ecc_a = 0, ecc_b = 0;
        for (let minor = 0; minor < minorCount + 1; minor++) {
            const idx = (minor === minorCount) ? (eccOffset + major * 2) : (((major * majorMult + minor * minorMult) % (majorCount * minorCount)) + offset);
            const temp = data[idx]; ecc_a = ECC_F_TABLE[ecc_a ^ temp]; ecc_b ^= temp;
        }
        data[eccOffset + major * 2] = ecc_a ^ ecc_b; data[eccOffset + major * 2 + 1] = ecc_b;
    }
}

function lbaToMsf(lba) {
    const totalFrames = lba + 150;
    const minute = Math.floor(totalFrames / 4500);
    const second = Math.floor((totalFrames % 4500) / 75);
    const frame = totalFrames % 75;
    const toBcd = (val) => ((Math.floor(val / 10) << 4) | (val % 10));
    return { minute: toBcd(minute), second: toBcd(second), frame: toBcd(frame) };
}

function reconstructSector(hunk, sectorOffset, lba, mode, mainData, subData, unitbytes) {
    hunk[sectorOffset + 0] = 0x00; hunk[sectorOffset + 1] = 0xFF; hunk[sectorOffset + 2] = 0xFF;
    hunk[sectorOffset + 3] = 0xFF; hunk[sectorOffset + 4] = 0xFF; hunk[sectorOffset + 5] = 0xFF;
    hunk[sectorOffset + 6] = 0xFF; hunk[sectorOffset + 7] = 0xFF; hunk[sectorOffset + 8] = 0xFF;
    hunk[sectorOffset + 9] = 0xFF; hunk[sectorOffset + 10] = 0xFF; hunk[sectorOffset + 11] = 0x00;
    
    const msf = lbaToMsf(lba);
    hunk[sectorOffset + 12] = msf.minute; hunk[sectorOffset + 13] = msf.second;
    hunk[sectorOffset + 14] = msf.frame; hunk[sectorOffset + 15] = mode;
    
    hunk.set(mainData, sectorOffset + 16);
    
    if (mode === 0x01) {
        const edc = edcCompute(hunk, sectorOffset, 2064);
        hunk[sectorOffset + 2064] = edc & 0xFF; hunk[sectorOffset + 2065] = (edc >>> 8) & 0xFF;
        hunk[sectorOffset + 2066] = (edc >>> 16) & 0xFF; hunk[sectorOffset + 2067] = (edc >>> 24) & 0xFF;
        for (let i = 0; i < 12; i++) hunk[sectorOffset + 2068 + i] = 0x00;
        eccCompute(hunk, sectorOffset + 12, 86, 24, 2, 86, sectorOffset + 2076);
        eccCompute(hunk, sectorOffset + 12, 52, 43, 86, 52, sectorOffset + 2162);
    } else if (mode === 0x02) {
        const edc = edcCompute(hunk, sectorOffset + 16, 2056);
        hunk[sectorOffset + 2072] = edc & 0xFF; hunk[sectorOffset + 2073] = (edc >>> 8) & 0xFF;
        hunk[sectorOffset + 2074] = (edc >>> 16) & 0xFF; hunk[sectorOffset + 2075] = (edc >>> 24) & 0xFF;
    }
    
    if (subData && unitbytes === 2448) {
        hunk.set(subData, sectorOffset + 2352);
    }
}

async function decompressCdHunk(comp, hunkbytes, unitbytes, codecName) {
    if (comp.length < 8) throw new Error("CHD CD hunk too small");
    const dv = new DataView(comp.buffer, comp.byteOffset, comp.byteLength);
    const mainCompLen = dv.getUint32(0, false);
    const subCompLen = dv.getUint32(4, false);
    
    const mainCompData = comp.subarray(8, 8 + mainCompLen);
    const subCompData = comp.subarray(8 + mainCompLen, 8 + mainCompLen + subCompLen);
    
    let mainData;
    if (codecName === 'cdzl' || codecName === 'zlib' || codecName === 'none') {
        mainData = (codecName === 'none') ? mainCompData : await inflateZlibOrRaw(mainCompData);
    } else {
        throw new Error(`Codec CD '${codecName}' não suportado. Converta o CHD para cdzl.`);
    }
    
    let subData = null;
    if (subCompLen > 0) {
        try { subData = await inflateZlibOrRaw(subCompData); } catch (e) {}
    }
    
    const sectorsPerHunk = hunkbytes / unitbytes;
    const hunk = new Uint8Array(hunkbytes);
    let mainOffset = 0; let subOffset = 0;
    
    for (let i = 0; i < sectorsPerHunk; i++) {
        const sectorOffset = i * unitbytes;
        const mode = (unitbytes === 2352) ? 0x01 : 0x02;
        const sectorMain = mainData.subarray(mainOffset, mainOffset + 2048);
        mainOffset += 2048;
        
        let sectorSub = null;
        if (subData && subData.length >= subOffset + 96) {
            sectorSub = subData.subarray(subOffset, subOffset + 96);
            subOffset += 96;
        }
        
        reconstructSector(hunk, sectorOffset, i, mode, sectorMain, sectorSub, unitbytes);
    }
    return hunk;
}

function stripSubchannelFallback(data) {
    if (data.length % 2448 !== 0) return data;
    const sectors = data.length / 2448;
    const out = new Uint8Array(sectors * 2352);
    for (let i = 0; i < sectors; i++) out.set(data.subarray(i * 2448, i * 2448 + 2352), i * 2352);
    return out;
}

async function decodeChdCdToUint8Array(input, onProgress) {
    const u8all = new Uint8Array(input instanceof ArrayBuffer ? input : input.buffer);
    const ab = input instanceof ArrayBuffer ? input : u8all.buffer;
    const dv = new DataView(ab);
    const u8 = new Uint8Array(ab);
    
    const tag = String.fromCharCode(...u8.subarray(0, 8));
    if (tag !== CHD_TAG) throw new Error('Não é CHD');
    const header = parseChdHeader(dv, u8, ab.byteLength);
    
    if (header.unitbytes !== 2352 && header.unitbytes !== 2448) {
        throw new Error(`CHD não é um CD (unitbytes=${header.unitbytes}, esperado 2352 ou 2448)`);
    }
    
    let mapEntries;
    if (header.isNoneCompressed) {
        mapEntries = new Array(header.totalhunks);
        for (let h = 0; h < header.totalhunks; h++) {
            const off = header.mapoffset + h * 12;
            const length = (u8[off + 1] << 16) | (u8[off + 2] << 8) | u8[off + 3];
            const offset = be48AsNumber(u8, off + 4);
            mapEntries[h] = { type: length === header.hunkbytes ? COMPRESSION_NONE : 0, length, offset };
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
            out.set(u8.subarray(entry.offset, entry.offset + dstLen), dst);
        } else if (entry.type === COMPRESSION_SELF) {
            out.copyWithin(dst, entry.offset * header.hunkbytes, entry.offset * header.hunkbytes + dstLen);
        } else if (entry.type === COMPRESSION_PARENT) {
            throw new Error(`CHD: hunk ${h} referencia um CHD pai, não suportado.`);
        } else {
            const codecIdx = entry.type;
            const codecName = header.codecNames[codecIdx] || 'unknown';
            const comp = u8.subarray(entry.offset, entry.offset + entry.length);
            
            if (/^cd/.test(codecName) || codecName === 'zlib' || codecName === 'none') {
                const dec = await decompressCdHunk(comp, header.hunkbytes, header.unitbytes, codecName);
                if (dec.length >= dstLen) out.set(dec.subarray(0, dstLen), dst);
                else { out.set(dec, dst); out.fill(0, dst + dec.length, dst + dstLen); }
            } else {
                throw new Error(`Codec '${codecName}' não suportado para CD. Converta para cdzl.`);
            }
        }
        
        if (onProgress && (h % 100 === 0 || h === header.totalhunks - 1)) onProgress(h, header.totalhunks);
        if (h % 500 === 0) await new Promise(r => setTimeout(r, 0));
    }
    
    if (header.unitbytes === 2448) {
        console.log('[CHD-CD] Removendo subchannel (2448 -> 2352)...');
        out = stripSubchannelFallback(out);
    }
    
    console.log(`[CHD-CD] Decodificado com sucesso: ${out.length} bytes`);
    return out;
}

function parseIso9660(data) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const pvdOffset = 16 * 2048;
    if (data[pvdOffset] !== 0x01) throw new Error('ISO9660: Primary Volume Descriptor não encontrado');
    
    const systemIdentifier = String.fromCharCode(...data.subarray(pvdOffset + 8, pvdOffset + 40)).replace(/\0/g, '').trim();
    const volumeIdentifier = String.fromCharCode(...data.subarray(pvdOffset + 40, pvdOffset + 72)).replace(/\0/g, '').trim();
    const volumeSpaceSize = dv.getUint32(pvdOffset + 80, true);
    const logicalBlockSize = dv.getUint16(pvdOffset + 128, true);
    const rootDirectoryLocation = dv.getUint32(pvdOffset + 156, true);
    
    const files = [];
    const rootOffset = rootDirectoryLocation * logicalBlockSize;
    let offset = rootOffset;
    
    while (offset < data.length) {
        const recordLength = data[offset];
        if (recordLength === 0) break;
        const fileIdentifierLength = data[offset + 32];
        const fileIdentifier = String.fromCharCode(...data.subarray(offset + 33, offset + 33 + fileIdentifierLength)).replace(/\0/g, '');
        const dataLength = dv.getUint32(offset + 10, true);
        const extentLocation = dv.getUint32(offset + 2, true);
        
        if (fileIdentifier !== '\x00' && fileIdentifier !== '\x01' && fileIdentifier !== '') {
            files.push({ name: fileIdentifier, size: dataLength, sector: extentLocation, offset: extentLocation * logicalBlockSize });
        }
        offset += recordLength;
    }
    
    return { systemIdentifier, volumeIdentifier, volumeSpaceSize, logicalBlockSize, rootDirectoryLocation, files };
}

function extractFile(data, file) {
    return data.subarray(file.offset, file.offset + file.size);
}

scope.decodeChdCdToUint8Array = decodeChdCdToUint8Array;
scope.parseIso9660 = parseIso9660;
scope.extractFile = extractFile;

})(typeof window !== 'undefined' ? window : globalThis);