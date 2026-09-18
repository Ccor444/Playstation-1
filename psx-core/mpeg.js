(scope => {
'use strict';

// ============================================================
// MPEG-1 Video Decoder para Video CD (SCPH-5903)
// ============================================================

// --- Bitstream Reader ---
class BitReader {
    constructor(data) {
        this.data = data;
        this.pos = 0;
        this.bitPos = 0;
        this.cache = 0;
        this.cacheBits = 0;
    }

    readBits(n) {
        if (n === 0) return 0;
        while (this.cacheBits < n) {
            if (this.pos >= this.data.length) {
                this.cache = (this.cache << 8) | 0xFF;
            } else {
                this.cache = (this.cache << 8) | this.data[this.pos++];
            }
            this.cacheBits += 8;
        }
        this.cacheBits -= n;
        const val = (this.cache >>> this.cacheBits) & ((1 << n) - 1);
        return val;
    }

    readBit() {
        return this.readBits(1);
    }

    // Lê bits até encontrar um '1' (usado em códigos Huffman)
    readHuffman(codeTable) {
        let code = 0;
        let len = 0;
        while (len < 32) {
            code = (code << 1) | this.readBit();
            len++;
            const entry = codeTable[len] ? codeTable[len][code] : undefined;
            if (entry !== undefined) return entry;
        }
        return -1;
    }

    skipBits(n) {
        for (let i = 0; i < n; i++) this.readBit();
    }

    alignToByte() {
        if (this.cacheBits > 0) {
            this.cacheBits = 0;
            this.cache = 0;
        }
    }

    bytesLeft() {
        return this.data.length - this.pos;
    }
}

// --- Tabelas de Huffman para MPEG-1 ---

// Tabela de macroblock type para I-frames
const MB_TYPE_I = {
    1: { 1: 0x01 },           // '1' -> Intra (0x01)
    2: { 1: 0x11 },           // '01' -> Intra + Quant (0x11)
};

// Tabela de macroblock type para P-frames
const MB_TYPE_P = {
    1: { 1: 0x0A },           // '1' -> Forward + Coded (0x0A)
    2: { 1: 0x02 },           // '01' -> Forward (0x02)
    3: { 1: 0x08, 0: 0x12 }, // '001' -> Coded (0x08), '000' -> Forward+Coded+Quant (0x12)
};

// Tabela de macroblock type para B-frames
const MB_TYPE_B = {
    2: { 2: 0x0C, 3: 0x0E }, // '10' -> Forward+Coded, '11' -> Backward+Coded
    3: { 2: 0x04, 3: 0x06 }, // '010' -> Interp+Coded, '011' -> Interp
    4: { 1: 0x1C, 0: 0x0A }, // '0010' -> Forward, '0011' -> Backward
    5: { 1: 0x02, 0: 0x1E }, // '00010' -> Interp+Quant, '00011' -> Forward+Coded+Quant
    6: { 0: 0x16, 1: 0x0D }, // '000010' -> Backward+Quant, '000011' -> Forward+Quant
    7: { 0: 0x05 },           // '0000010' -> Interp+Coded+Quant (não usado mas válido)
};

// Tabela de motion code (MPEG-1)
const MOTION_CODE = {};
(function() {
    MOTION_CODE[1] = { 0: 0 }; // '0' -> 0
    MOTION_CODE[2] = { 1: 1 }; // '01' -> +1
    MOTION_CODE[3] = { 1: -1 }; // '001' -> -1
    MOTION_CODE[4] = { 2: 2 }; // '00010' -> +2 (precisa de 5 bits na verdade)
    MOTION_CODE[5] = { 2: -2, 3: 3 }; // '00010' -> -2, '00011' -> +3
    MOTION_CODE[6] = { 2: -3, 3: 4 }; // '000010' -> -3, '000011' -> +4
    MOTION_CODE[7] = { 2: -4, 3: 5 }; // '0000010' -> -4, '0000011' -> +5
    MOTION_CODE[8] = { 2: -5, 3: 6 }; // ...
    MOTION_CODE[9] = { 2: -6, 3: 7 };
    MOTION_CODE[10] = { 2: -7, 3: 8 };
    MOTION_CODE[11] = { 2: -8, 3: 9 };
    MOTION_CODE[12] = { 2: -9, 3: 10 };
    MOTION_CODE[13] = { 2: -10, 3: 11 };
    MOTION_CODE[14] = { 2: -11, 3: 12 };
    MOTION_CODE[15] = { 2: -12, 3: 13 };
    MOTION_CODE[16] = { 2: -13, 3: 14 };
    MOTION_CODE[17] = { 2: -14, 3: 15 };
    MOTION_CODE[18] = { 2: -15, 3: 16 };
    MOTION_CODE[19] = { 2: -16, 3: 16 }; // overflow handled separately
})();

// Tabela de coded block pattern (CBP)
const CBP_TABLE = {};
(function() {
    // Simplificado - CBP completo tem 63 entradas
    CBP_TABLE[1] = { 1: 60, 0: 4 };
    CBP_TABLE[2] = { 0: 52, 1: 44 };
    CBP_TABLE[3] = { 0: 36, 1: 28, 2: 20, 3: 12 };
    CBP_TABLE[4] = { 0: 62, 1: 2, 2: 61, 3: 1, 4: 56, 5: 59, 6: 55, 7: 58 };
    // ... (tabela completa seria extensa)
})();

// Tabela de DCT coefficients (run/level)
const DCT_COEFF = {};
(function() {
    // EOB (End of Block)
    DCT_COEFF[2] = { 2: { run: 0xFF, level: 0 } }; // '10' -> EOB
    // Coeficientes comuns
    DCT_COEFF[2] = { 0: { run: 0, level: 1 } }; // '00' -> run=0, level=1 (precisa de bit de sign)
    DCT_COEFF[3] = { 1: { run: 1, level: 1 } }; // '001' -> run=1, level=1
    DCT_COEFF[4] = { 1: { run: 0, level: 2 } }; // '0001' -> run=0, level=2
    DCT_COEFF[5] = { 1: { run: 2, level: 1 } }; // '00001' -> run=2, level=1
    DCT_COEFF[6] = { 1: { run: 0, level: 3 } }; // '000001' -> run=0, level=3
    DCT_COEFF[6] = { 0: { run: 3, level: 1 } };
    DCT_COEFF[7] = { 1: { run: 1, level: 2 } };
    DCT_COEFF[7] = { 0: { run: 4, level: 1 } };
    DCT_COEFF[8] = { 1: { run: 0, level: 4 } };
    DCT_COEFF[8] = { 0: { run: 5, level: 1 } };
    // Mais coeficientes seriam adicionados aqui
})();

// --- Tabelas de quantização ---
const INTRA_QUANT_MATRIX = [
    8, 16, 19, 22, 26, 27, 29, 34,
    16, 16, 22, 24, 27, 29, 34, 37,
    19, 22, 26, 27, 29, 34, 34, 38,
    22, 22, 26, 27, 29, 34, 37, 40,
    22, 26, 27, 29, 32, 35, 40, 48,
    26, 27, 29, 32, 35, 40, 48, 58,
    26, 27, 29, 34, 38, 46, 56, 69,
    27, 29, 35, 38, 46, 56, 69, 83
];

const NON_INTRA_QUANT_MATRIX = [
    16, 16, 16, 16, 16, 16, 16, 16,
    16, 16, 16, 16, 16, 16, 16, 16,
    16, 16, 16, 16, 16, 16, 16, 16,
    16, 16, 16, 16, 16, 16, 16, 16,
    16, 16, 16, 16, 16, 16, 16, 16,
    16, 16, 16, 16, 16, 16, 16, 16,
    16, 16, 16, 16, 16, 16, 16, 16,
    16, 16, 16, 16, 16, 16, 16, 16
];

// --- IDCT (Inverse Discrete Cosine Transform) ---
// Implementação rápida usando separabilidade (1D IDCT em linhas e colunas)
const COS_TABLE = new Float64Array(64);
(function() {
    for (let i = 0; i < 8; i++) {
        for (let j = 0; j < 8; j++) {
            COS_TABLE[i * 8 + j] = Math.cos((2 * i + 1) * j * Math.PI / 16);
        }
    }
})();

function idct1d(input, output, offset, stride) {
    const tmp = new Float64Array(8);
    for (let i = 0; i < 8; i++) {
        let sum = 0;
        for (let j = 0; j < 8; j++) {
            const c = (j === 0) ? Math.SQRT1_2 : 1.0;
            sum += c * input[offset + j * stride] * COS_TABLE[i * 8 + j];
        }
        tmp[i] = sum * 0.5;
    }
    for (let i = 0; i < 8; i++) {
        output[offset + i * stride] = tmp[i];
    }
}

function idct8x8(block) {
    // IDCT nas linhas
    for (let row = 0; row < 8; row++) {
        idct1d(block, block, row * 8, 1);
    }
    // IDCT nas colunas
    for (let col = 0; col < 8; col++) {
        idct1d(block, block, col, 8);
    }
    // Round e clamp
    for (let i = 0; i < 64; i++) {
        block[i] = Math.max(-256, Math.min(255, Math.round(block[i] + 128)));
    }
}

// --- Zigzag scan order ---
const ZIGZAG = [
    0,  1,  8, 16,  9,  2,  3, 10,
    17, 24, 32, 25, 18, 11,  4,  5,
    12, 19, 26, 33, 40, 48, 41, 34,
    27, 20, 13,  6,  7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36,
    29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46,
    53, 60, 61, 54, 47, 55, 62, 63
];

// --- MPEG-1 Decoder ---
class MPEG1Decoder {
    constructor() {
        this.width = 0;
        this.height = 0;
        this.mbWidth = 0;
        this.mbHeight = 0;
        this.frameBuffer = null;
        this.forwardRef = null;
        this.backwardRef = null;
        this.currentFrame = null;
        this.intraQuantMatrix = new Int32Array(INTRA_QUANT_MATRIX);
        this.nonIntraQuantMatrix = new Int32Array(NON_INTRA_QUANT_MATRIX);
        this.frameCount = 0;
        this.onFrame = null; // callback(frameData, width, height)
    }

    // Decodifica um frame completo a partir do bitstream
    decode(data) {
        const reader = new BitReader(data);
        this.parseSequence(reader);
        return this.frameBuffer;
    }

    parseSequence(reader) {
        // Procura pelo Sequence Header Code (0x000001B3)
        while (reader.bytesLeft() > 4) {
            const code = this.findStartCode(reader);
            if (code === 0xB3) { // Sequence Header
                this.parseSequenceHeader(reader);
            } else if (code === 0x00) { // Picture Start
                this.parsePicture(reader);
            } else if (code === 0xB8) { // GOP
                this.parseGOP(reader);
            } else if (code === 0xB7) { // Sequence End
                break;
            } else if (code === 0xB5) { // Extension
                this.parseExtension(reader);
            } else if (code === 0xB2) { // User Data
                this.parseUserData(reader);
            }
        }
    }

    findStartCode(reader) {
        // Procura por 0x000001XX
        let zeros = 0;
        while (reader.bytesLeft() > 0) {
            const byte = reader.readBits(8);
            if (byte === 0) {
                zeros++;
            } else if (byte === 1 && zeros >= 2) {
                return reader.readBits(8); // Retorna o código do start code
            } else {
                zeros = 0;
            }
        }
        return -1;
    }

    parseSequenceHeader(reader) {
        this.width = reader.readBits(12);
        this.height = reader.readBits(12);
        const aspectRatio = reader.readBits(4);
        const frameRateCode = reader.readBits(4);
        const bitRate = reader.readBits(18);
        reader.readBit(); // marker bit
        const vbvBufferSize = reader.readBits(10);
        const constrainedFlag = reader.readBit();

        this.mbWidth = Math.ceil(this.width / 16);
        this.mbHeight = Math.ceil(this.height / 16);

        // Aloca buffers de frame
        const frameSize = this.width * this.height;
        this.frameBuffer = new Uint8ClampedArray(frameSize * 4); // RGBA
        this.forwardRef = new Float64Array(frameSize);
        this.backwardRef = new Float64Array(frameSize);
        this.currentFrame = new Float64Array(frameSize);

        console.log(`[MPEG-1] Sequence: ${this.width}x${this.height}, ` +
            `MB: ${this.mbWidth}x${this.mbHeight}, ` +
            `fps_code: ${frameRateCode}`);

        // Load intra quant matrix
        if (reader.readBit()) {
            for (let i = 0; i < 64; i++) {
                this.intraQuantMatrix[ZIGZAG[i]] = reader.readBits(8);
            }
        }
        // Load non-intra quant matrix
        if (reader.readBit()) {
            for (let i = 0; i < 64; i++) {
                this.nonIntraQuantMatrix[ZIGZAG[i]] = reader.readBits(8);
            }
        }
    }

    parseGOP(reader) {
        const dropFrame = reader.readBit();
        const timeCodeHours = reader.readBits(5);
        const timeCodeMinutes = reader.readBits(6);
        reader.readBit(); // marker
        const timeCodeSeconds = reader.readBits(6);
        const timeCodePictures = reader.readBits(6);
        const closedGOP = reader.readBit();
        const brokenLink = reader.readBit();
    }

    parsePicture(reader) {
        const temporalReference = reader.readBits(10);
        const pictureType = reader.readBits(3);
        const vbvDelay = reader.readBits(16);

        // Full pel forward vector (P-frames)
        if (pictureType === 3) { // P-frame
            const fullPelForward = reader.readBit();
            const forwardFCode = reader.readBits(3);
        }

        // Full pel backward vector (B-frames)
        if (pictureType === 4) { // B-frame
            const fullPelBackward = reader.readBit();
            const backwardFCode = reader.readBits(3);
        }

        // Extra bit information
        while (reader.readBit()) {
            reader.readBits(8); // extra information
        }

        // Decodifica slices
        this.decodePicture(reader, pictureType, temporalReference);
    }

    decodePicture(reader, pictureType, temporalRef) {
        // Limpa o frame atual
        this.currentFrame.fill(0);

        // Decodifica cada slice
        while (reader.bytesLeft() > 4) {
            const nextCode = this.peekStartCode(reader);
            if (nextCode >= 0x01 && nextCode <= 0xAF) {
                this.parseSlice(reader, nextCode, pictureType);
            } else {
                break;
            }
        }

        // Copia o frame atual para o buffer de saída
        this.frameToRGBA();

        // Atualiza referências
        if (pictureType === 1 || pictureType === 3) { // I ou P
            this.forwardRef.set(this.currentFrame);
        }

        this.frameCount++;
        if (this.onFrame) {
            this.onFrame(this.frameBuffer, this.width, this.height, this.frameCount);
        }
    }

    peekStartCode(reader) {
        // Salva posição, procura start code, restaura posição
        const savedPos = reader.pos;
        const savedBitPos = reader.bitPos;
        const savedCache = reader.cache;
        const savedCacheBits = reader.cacheBits;

        let zeros = 0;
        let code = -1;
        while (reader.bytesLeft() > 0) {
            const byte = reader.readBits(8);
            if (byte === 0) {
                zeros++;
            } else if (byte === 1 && zeros >= 2) {
                code = reader.readBits(8);
                break;
            } else {
                zeros = 0;
            }
        }

        reader.pos = savedPos;
        reader.bitPos = savedBitPos;
        reader.cache = savedCache;
        reader.cacheBits = savedCacheBits;
        return code;
    }

    parseSlice(reader, sliceCode, pictureType) {
        const quantizerScale = reader.readBits(5);

        // Extra bit slice information
        while (reader.readBit()) {
            reader.readBits(8);
        }

        // Decodifica macroblocos
        let mbAddr = (sliceCode - 1) * this.mbWidth;
        let prevMBAddr = mbAddr - 1;

        while (true) {
            // Verifica se é o fim do slice
            const nextByte = this.peekByte(reader);
            if (nextByte === 0) break;

            this.decodeMacroblock(reader, mbAddr, quantizerScale, pictureType);
            prevMBAddr = mbAddr;
            mbAddr++;

            if (mbAddr >= this.mbWidth * this.mbHeight) break;
        }
    }

    peekByte(reader) {
        const savedPos = reader.pos;
        const savedCache = reader.cache;
        const savedCacheBits = reader.cacheBits;
        const val = reader.readBits(8);
        reader.pos = savedPos;
        reader.cache = savedCache;
        reader.cacheBits = savedCacheBits;
        return val;
    }

    decodeMacroblock(reader, mbAddr, quantScale, pictureType) {
        const mbX = mbAddr % this.mbWidth;
        const mbY = Math.floor(mbAddr / this.mbWidth);

        // Decodifica macroblock type
        let mbType;
        if (pictureType === 1) { // I-frame
            mbType = this.readMBTypeI(reader);
        } else if (pictureType === 3) { // P-frame
            mbType = this.readMBTypeP(reader);
        } else if (pictureType === 4) { // B-frame
            mbType = this.readMBTypeB(reader);
        } else {
            mbType = 0x01; // default intra
        }

        const isIntra = (mbType & 0x01) !== 0;
        const isForward = (mbType & 0x08) !== 0;
        const isBackward = (mbType & 0x04) !== 0;
        const isInterpolated = (mbType & 0x02) !== 0;
        const isCoded = (mbType & 0x10) !== 0;
        const hasQuant = (mbType & 0x20) !== 0;

        let localQuantScale = quantScale;
        if (hasQuant) {
            localQuantScale = reader.readBits(5);
        }

        // Motion vectors
        let fwdH = 0, fwdV = 0, bwdH = 0, bwdV = 0;

        if (isForward || isInterpolated) {
            fwdH = this.readMotionVector(reader);
            fwdV = this.readMotionVector(reader);
        }
        if (isBackward || isInterpolated) {
            bwdH = this.readMotionVector(reader);
            bwdV = this.readMotionVector(reader);
        }

        // Coded Block Pattern
        let cbp;
        if (isIntra) {
            cbp = 0x3F; // Todos os 6 blocos são codificados em intra
        } else if (isCoded) {
            cbp = this.readCBP(reader);
        } else {
            cbp = 0;
        }

        // Decodifica os 6 blocos (4 Y + 1 Cb + 1 Cr)
        const blocks = new Array(6);
        for (let i = 0; i < 6; i++) {
            blocks[i] = new Float64Array(64);
            if (cbp & (0x20 >> i)) {
                this.decodeBlock(reader, blocks[i], isIntra, localQuantScale);
            }
        }

        // Reconstrói o macroblock
        this.reconstructMacroblock(mbX, mbY, blocks, isIntra,
            isForward, isBackward, isInterpolated,
            fwdH, fwdV, bwdH, bwdV, pictureType);
    }

    readMBTypeI(reader) {
        if (reader.readBit()) return 0x01; // '1' -> Intra
        if (reader.readBit()) return 0x11; // '01' -> Intra + Quant
        return 0x01;
    }

    readMBTypeP(reader) {
        if (reader.readBit()) return 0x0A; // '1' -> Forward + Coded
        if (reader.readBit()) return 0x02; // '01' -> Forward
        if (reader.readBit()) return 0x08; // '001' -> Coded
        return 0x12; // '000' -> Forward + Coded + Quant
    }

    readMBTypeB(reader) {
        if (reader.readBits(2) === 2) return 0x0C; // '10' -> Forward+Coded
        // Simplificado
        return 0x0C;
    }

    readMotionVector(reader) {
        // Lê o código de movimento usando Huffman
        let code = 0;
        let len = 0;
        while (len < 16) {
            code = (code << 1) | reader.readBit();
            len++;
            // Verifica se é zero
            if (len === 1 && code === 0) return 0;
            if (len === 2 && code === 1) return 1;
            if (len === 3 && code === 1) return -1;
            if (len === 4 && code === 3) return 2;
            if (len === 4 && code === 2) return -2;
            if (len === 5 && code === 3) return 3;
            if (len === 5 && code === 2) return -3;
            if (len === 6 && code === 3) return 4;
            if (len === 6 && code === 2) return -4;
            if (len === 7 && code === 3) return 5;
            if (len === 7 && code === 2) return -5;
            if (len === 8 && code === 3) return 6;
            if (len === 8 && code === 2) return -6;
            if (len === 9 && code === 3) return 7;
            if (len === 9 && code === 2) return -7;
        }
        return 0;
    }

    readCBP(reader) {
        // Simplificado - lê 6 bits diretamente
        let cbp = 0;
        for (let i = 0; i < 6; i++) {
            if (reader.readBit()) cbp |= (0x20 >> i);
        }
        return cbp;
    }

    decodeBlock(reader, block, isIntra, quantScale) {
        block.fill(0);

        let idx = 0;
        if (isIntra) {
            // DC coefficient (8 bits para intra)
            const dc = reader.readBits(8);
            block[0] = (dc - 128) * 8;
            idx = 1;
        }

        // AC coefficients
        while (idx < 64) {
            // Lê run/level
            let run = 0;
            let level = 0;

            // Simplificado: lê EOB ou coeficiente
            const bit = reader.readBit();
            if (bit === 1) {
                // EOB
                break;
            }

            // Lê run (6 bits) e level (8 bits) simplificado
            run = reader.readBits(6);
            level = reader.readBits(8);
            if (level === 0) break;

            // Aplica sign bit
            if (reader.readBit()) level = -level;

            idx += run + 1;
            if (idx < 64) {
                const pos = ZIGZAG[idx];
                const matrix = isIntra ? this.intraQuantMatrix : this.nonIntraQuantMatrix;
                if (isIntra) {
                    block[pos] = (level * quantScale * matrix[pos]) / 8;
                } else {
                    block[pos] = ((2 * level + 1) * quantScale * matrix[pos]) / 16;
                    if (level < 0) block[pos] = -block[pos];
                }
            }
        }

        // Aplica IDCT
        idct8x8(block);
    }

    reconstructMacroblock(mbX, mbY, blocks, isIntra,
        isForward, isBackward, isInterpolated,
        fwdH, fwdV, bwdH, bwdV, pictureType) {

        const baseX = mbX * 16;
        const baseY = mbY * 16;

        if (isIntra) {
            // Copia blocos diretamente
            for (let by = 0; by < 2; by++) {
                for (let bx = 0; bx < 2; bx++) {
                    const blockIdx = by * 2 + bx;
                    const block = blocks[blockIdx];
                    for (let y = 0; y < 8; y++) {
                        for (let x = 0; x < 8; x++) {
                            const px = baseX + bx * 8 + x;
                            const py = baseY + by * 8 + y;
                            if (px < this.width && py < this.height) {
                                this.currentFrame[py * this.width + px] = block[y * 8 + x];
                            }
                        }
                    }
                }
            }
        } else {
            // Motion compensation + residual
            for (let by = 0; by < 2; by++) {
                for (let bx = 0; bx < 2; bx++) {
                    const blockIdx = by * 2 + bx;
                    const block = blocks[blockIdx];
                    for (let y = 0; y < 8; y++) {
                        for (let x = 0; x < 8; x++) {
                            const px = baseX + bx * 8 + x;
                            const py = baseY + by * 8 + y;
                            if (px >= this.width || py >= this.height) continue;

                            let prediction = 0;

                            if (isForward) {
                                const refX = Math.min(this.width - 1, Math.max(0, px + fwdH));
                                const refY = Math.min(this.height - 1, Math.max(0, py + fwdV));
                                prediction += this.forwardRef[refY * this.width + refX];
                            }
                            if (isBackward) {
                                const refX = Math.min(this.width - 1, Math.max(0, px + bwdH));
                                const refY = Math.min(this.height - 1, Math.max(0, py + bwdV));
                                prediction += this.backwardRef[refY * this.width + refX];
                            }
                            if (isForward && isBackward) {
                                prediction /= 2;
                            }

                            this.currentFrame[py * this.width + px] =
                                prediction + block[y * 8 + x];
                        }
                    }
                }
            }
        }
    }

    frameToRGBA() {
        // Converte Y (luminance) para RGBA
        // Em VCD real, teríamos YCbCr completo, mas aqui usamos Y como grayscale
        for (let i = 0; i < this.width * this.height; i++) {
            const y = Math.max(0, Math.min(255, this.currentFrame[i]));
            this.frameBuffer[i * 4 + 0] = y;     // R
            this.frameBuffer[i * 4 + 1] = y;     // G
            this.frameBuffer[i * 4 + 2] = y;     // B
            this.frameBuffer[i * 4 + 3] = 255;   // A
        }
    }

    parseExtension(reader) {
        // Extension data - skip
        reader.readBits(4); // extension start code identifier
        // Skip remaining extension data
    }

    parseUserData(reader) {
        // User data - skip until next start code
    }
}

// --- VCD Parser (CD-ROM XA Mode 2 Form 2) ---
class VCDParser {
    constructor() {
        this.decoder = new MPEG1Decoder();
        this.mpegData = [];
    }

    // Parseia um arquivo .DAT de Video CD
    parseDAT(data) {
        this.mpegData = [];

        // Setores CD-ROM XA Mode 2 Form 2 têm 2324 bytes de dados úteis
        // Offset 24 no setor de 2352 bytes
        const SECTOR_SIZE = 2352;
        const DATA_OFFSET = 24;
        const DATA_SIZE = 2324;

        const numSectors = Math.floor(data.length / SECTOR_SIZE);

        for (let s = 0; s < numSectors; s++) {
            const sectorStart = s * SECTOR_SIZE + DATA_OFFSET;
            if (sectorStart + DATA_SIZE > data.length) break;

            // Extrai dados MPEG do setor
            for (let i = 0; i < DATA_SIZE; i++) {
                this.mpegData.push(data[sectorStart + i]);
            }
        }

        return new Uint8Array(this.mpegData);
    }

    // Decodifica o stream MPEG completo
    decode(mpegStream) {
        return this.decoder.decode(mpegStream);
    }

    // Define callback para frames decodificados
    onFrame(callback) {
        this.decoder.onFrame = callback;
    }
}

// --- Integração com o emulador ---
const mpeg = {
    decoder: new MPEG1Decoder(),
    vcdParser: new VCDParser(),
    isActive: false,
    canvas: null,
    ctx: null,

    init: function(canvasElement) {
        this.canvas = canvasElement;
        this.ctx = canvasElement.getContext('2d');
        this.decoder.onFrame = this.renderFrame.bind(this);
    },

    renderFrame: function(frameData, width, height, frameNum) {
        if (!this.ctx) return;

        this.canvas.width = width;
        this.canvas.height = height;

        const imageData = new ImageData(frameData, width, height);
        this.ctx.putImageData(imageData, 0, 0);
    },

    // Carrega e decodifica um arquivo .DAT
    loadDAT: function(arrayBuffer) {
        const data = new Uint8Array(arrayBuffer);
        const mpegStream = this.vcdParser.parseDAT(data);
        console.log(`[VCD] MPEG stream: ${mpegStream.length} bytes`);
        this.isActive = true;
        this.decoder.decode(mpegStream);
    },

    // Para a decodificação
    stop: function() {
        this.isActive = false;
    }
};

scope.mpeg = Object.seal(mpeg);
scope.MPEG1Decoder = MPEG1Decoder;
scope.VCDParser = VCDParser;
})(window);