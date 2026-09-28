// ============================================================================
// 1. RESOLUÇÃO INTERNA FIXA (PS1 nativo: 1024x512)
// ============================================================================
var qwf = 1;
var qhf = 1;
var qwidth = 1024;
var qheight = 512;

"use strict"

// ============================================================================
// Vertex Buffers (CPU -> GPU)
// ============================================================================
Uint32Array.prototype.addVertexDisp = function (x, y, u, v) {
    var xy = (y << 16) | (x & 0xffff);
    var uv = (v << 16) | (u & 0xffff);
    var index = this.index >>> 2;
    this[index + 0] = xy;
    this[index + 1] = uv;
    this.index += 8;
}

Uint32Array.prototype.addVertex = function (x, y, c) {
    x = x * 16;
    y = y * 16;
    var xy = (y << 16) | (x & 0xffff);
    var index = this.index >>> 2;
    // [FIEL] bit 9 do GPUSTAT (dither enable) vai pro bit 5 do byte de modo
    var dith = (gpu.status >> 9) & 1;
    // [FIEL] Cor 24-bit real, modo 3 (untextured)
    this[index + 0] = (c & 0xffffff) | ((0x03 | (dith << 5)) << 24);
    this[index + 1] = xy;
    this.index += 24;
}

Uint32Array.prototype.addVertexUV = function (x, y, c, tm, u, v, cx, cy) {
    x = x * 16;
    y = y * 16;
    var xy = (y << 16) | (x & 0xffff);
    var uv = (v << 16) | (u & 0xffff);
    var cxy = (cy << 16) | (cx & 0xffff);
    var txy = (gpu.ty << 16) | (gpu.tx & 0xffff);
    // [FIEL] bit 9 do GPUSTAT (dither enable) vai pro bit 5 do byte de modo
    var dith = (gpu.status >> 9) & 1;
    tm = tm | (dith << 5);
    var index = this.index >>> 2;
    this[index + 0] = (c & 0xffffff) | (tm << 24);
    this[index + 1] = xy;
    this[index + 2] = uv;
    this[index + 3] = cxy;
    this[index + 4] = txy;
    this[index + 5] = gpu.twin;
    this.index += 24;
}

Uint32Array.prototype.getNumberOfVertices = function () {
    return this.index / 24;
}

Uint32Array.prototype.canHold = function (cnt) {
    return this.index + (24 * cnt) < (this.length * 4);
}

Uint32Array.prototype.reset = function () {
    this.index = 0;
}

Uint32Array.prototype.view = function () {
    return new Uint32Array(this.buffer, 0, this.index >> 2);
}

// ============================================================================
// SHADERS - PS1 NATIVO (GLSL ES 3.00)
// ============================================================================

// ------------------------------------------------------------------------
// Vertex Shader de Display (Finalização de Tela)
// ------------------------------------------------------------------------
const vertexShaderDisplay = `#version 300 es
precision highp float;

const float INV_1024 = 1.0 / 1024.0;
const float INV_512  = 1.0 / 512.0;

in vec2 aVertexPosition;
in vec2 aVertexTexture;

uniform vec3 uTs;

out vec2 vTextureCoord;
out vec2 tx;

void main() {
    gl_Position = vec4(aVertexPosition, 0.0, 1.0);
    tx          = aVertexTexture;
    vTextureCoord = aVertexTexture * vec2(INV_1024, INV_512);
}`;

// ------------------------------------------------------------------------
// Fragment Shader 16bit Display - PS1 nativo (nearest-neighbor puro)
// ------------------------------------------------------------------------
const fragmentShader16bit = `#version 300 es
precision highp float;

uniform sampler2D uVRAM;

in vec2 vTextureCoord;
out vec4 fragColor;

void main() {
    fragColor = vec4(texture(uVRAM, vTextureCoord).rgb, 1.0);
}`;

// ------------------------------------------------------------------------
// Fragment Shader Texture (Debug/Load Image)
// ------------------------------------------------------------------------
const fragmentShaderTexture = `#version 300 es
precision highp float;

uniform sampler2D uVRAM;

in vec2 vTextureCoord;
out vec4 fragColor;

void main() {
    float a = texture(uVRAM, vTextureCoord).a;
    fragColor = vec4(a, a, a, 1.0);
}`;

// ------------------------------------------------------------------------
// Fragment Shader 24bit Display (Leitura real de bytes da VRAM)
// ------------------------------------------------------------------------
const fragmentShader24bit = `#version 300 es
precision highp float;

uniform sampler2D uVRAM;
uniform vec3 uTs;

in vec2 tx;
in vec2 vTextureCoord;

out vec4 fragColor;

void main() {
    float td = tx.x - uTs.x;
    float x  = 3.0 * floor(td) + 2.0 * uTs.x;
    float ty = floor(tx.y);

    int ix = int(floor(x));
    int iy = int(ty);

    int ix0 = clamp(ix,     0, 2047);
    int ix1 = clamp(ix + 1, 0, 2047);
    int ix2 = clamp(ix + 2, 0, 2047);

    iy = clamp(iy, 0, 511);

    // [FIEL] 24-bit do PS1 lê bytes consecutivos da VRAM
    float r = texelFetch(uVRAM, ivec2(ix0, iy), 0).a;
    float g = texelFetch(uVRAM, ivec2(ix1, iy), 0).a;
    float b = texelFetch(uVRAM, ivec2(ix2, iy), 0).a;

    fragColor = vec4(r, g, b, 1.0);
}`;

// ------------------------------------------------------------------------
// Vertex Shader de Desenho (Primitives) - PS1 Nativo
// ------------------------------------------------------------------------
const vertexShaderDraw = `#version 300 es
precision highp float;

const float INV_8192 = 1.0 / 8192.0;
const float INV_4096 = 1.0 / 4096.0;
const float INV_1024 = 1.0 / 1024.0;
const float INV_512  = 1.0 / 512.0;

in vec2 aVertexPosition;
in vec2 aVertexTexture;
in vec4 aVertexColor;
in vec4 aTextureWindow;
in vec2 aTexturePage;
in vec2 aTextureClut;

uniform float uBlendAlpha;

flat out int vTextureMode;
flat out int vSTP;
flat out int vDither;

out vec3 vColor255;
out vec2 vClut;

out float tmx;
out float tmy;
out float tox;
out float toy;
out float tcx;
out float tcy;
out float twin;

void main() {
    gl_Position = vec4(
        (aVertexPosition.x - 8192.0) * INV_8192,
        (aVertexPosition.y - 4096.0) * INV_4096,
        0.0, 1.0
    );

    vClut = aTextureClut * vec2(INV_1024, INV_512);

    twin = aTextureWindow.x + aTextureWindow.y;

    tmx = 256.0 - aTextureWindow.x;
    tmy = 256.0 - aTextureWindow.y;

    tox = aTexturePage.x + aTextureWindow.z;
    toy = aTexturePage.y + aTextureWindow.w;

    tcx = aVertexTexture.x;
    tcy = aVertexTexture.y;

    uint ca = uint(aVertexColor.a);

    vTextureMode = int(ca & 7u);
    vSTP         = int((ca >> 3u) & 3u);
    vDither      = int((ca >> 5u) & 1u);

    // [FIEL] Mode 7 é usado para blit raw VRAM -> framebuffer
    if (vTextureMode == 7) {
        tcx = aVertexPosition.x * INV_8192 * 0.5;
        tcy = aVertexPosition.y * INV_4096 * 0.5;
    }

    // [FIEL] Cor crua 0..255
    vColor255 = aVertexColor.rgb;
}`;

// ------------------------------------------------------------------------
// Fragment Shader de Desenho - PS1 real / 15-bit / dither / STP
// ------------------------------------------------------------------------
const fragmentShaderDraw = `#version 300 es
precision highp float;

uniform sampler2D uTex8;
uniform float uBlendAlpha;
uniform float uMaskSet;

flat in int vTextureMode;
flat in int vSTP;
flat in int vDither;

in vec3 vColor255;
in vec2 vClut;

in float tmx;
in float tmy;
in float tox;
in float toy;
in float tcx;
in float tcy;
in float twin;

out vec4 fragColor;

// [FIEL] Matriz de dither 4x4 real do GPU do PS1
const int ditherTable[16] = int[16](
    -4,  0, -3,  1,
     2, -2,  3, -1,
    -3,  1, -4,  0,
     3, -1,  2, -2
);

int getByte(int x, int y) {
    x = x & 2047;
    y = y & 511;
    return int(texelFetch(uTex8, ivec2(x, y), 0).a * 255.0 + 0.5);
}

int get16(int x, int y) {
    int lo = getByte(x, y);
    int hi = getByte(x + 1, y);
    return (hi << 8) | lo;
}

ivec3 rgb5(int w) {
    return ivec3(
        w & 31,
        (w >> 5) & 31,
        (w >> 10) & 31
    );
}

int wrap(int v, int m) {
    if (m <= 0) return v;
    int r = v % m;
    if (r < 0) r += m;
    return r;
}

void main() {
    ivec2 fc = ivec2(gl_FragCoord.xy) & 3;
    int dith = ditherTable[fc.y * 4 + fc.x];

    float maskOut = (uMaskSet > 0.5) ? 1.0 : 0.0;

    // --------------------------------------------------------------------
    // Mode 7: blit raw da VRAM para o framebuffer
    // --------------------------------------------------------------------
    if (vTextureMode == 7) {
        int x = int(floor(tcx * 1024.0));
        int y = int(floor(tcy * 512.0));

        int w = get16(x * 2, y);

        fragColor = vec4(
            vec3(rgb5(w)) / 31.0,
            ((w & 0x8000) != 0) ? 1.0 : 0.0
        );

        return;
    }

    // --------------------------------------------------------------------
    // Mode 3: primitiva untextured / gouraud / flat
    // --------------------------------------------------------------------
    if (vTextureMode == 3) {
        ivec3 c = ivec3(floor(vColor255 + 0.5));

        // [FIEL] Dither somente quando GPUSTAT.9 está ligado
        if (vDither != 0) {
            c += ivec3(dith);
        }

        c = min(max(c, ivec3(0)), ivec3(255));

        // [FIEL] Conversão real 8-bit -> 5-bit por truncamento
        ivec3 c5 = c >> 3;

        fragColor = vec4(vec3(c5) / 31.0, maskOut);
        return;
    }

    // --------------------------------------------------------------------
    // Texture coordinates + texture window
    // --------------------------------------------------------------------
    int itcx = int(floor(tcx));
    int itcy = int(floor(tcy));

    int itox = int(tox);
    int itoy = int(toy);

    int itmx = int(tmx);
    int itmy = int(tmy);

    int ix, iy;

    if (twin != 0.0) {
        ix = itox + wrap(itcx, itmx);
        iy = itoy + wrap(itcy, itmy);
    } else {
        ix = itox + itcx;
        iy = itoy + itcy;
    }

    int word = 0;

    // --------------------------------------------------------------------
    // 4-bit CLUT
    // --------------------------------------------------------------------
    if (vTextureMode == 0) {
        int b = getByte(ix >> 1, iy);
        int nib = ((ix & 1) == 0) ? (b & 15) : (b >> 4);

        int clutX = int(floor(vClut.x * 1024.0)) + nib;
        int clutY = int(floor(vClut.y * 512.0));

        word = get16(clutX * 2, clutY);
    }

    // --------------------------------------------------------------------
    // 8-bit CLUT
    // --------------------------------------------------------------------
    else if (vTextureMode == 1) {
        int idx = getByte(ix, iy);

        int clutX = int(floor(vClut.x * 1024.0)) + idx;
        int clutY = int(floor(vClut.y * 512.0));

        word = get16(clutX * 2, clutY);
    }

    // --------------------------------------------------------------------
    // 15-bit direto
    // --------------------------------------------------------------------
    else if (vTextureMode == 2) {
        int byteX = ix * 2;
        word = get16(byteX, iy);
    }

    // 0x0000 é transparente
    if (word == 0) {
        discard;
    }

    bool stp = (word & 0x8000) != 0;

    // --------------------------------------------------------------------
    // STP / semi-transparência
    //
    // vSTP = 0: textura normal
    // vSTP = 1: somente pixels com STP=1 entram no passe semi-transparente
    // vSTP = 2: somente pixels com STP=0 entram no passe opaco
    // --------------------------------------------------------------------
    if (vSTP == 1 && !stp) {
        discard;
    }

    if (vSTP == 2 && stp) {
        discard;
    }

    // --------------------------------------------------------------------
    // Texture shading real do PS1
    // out5 = clamp((tex5 * color8 * 2) >> 8, 0, 31)
    // --------------------------------------------------------------------
    ivec3 tex5 = rgb5(word);
    ivec3 col8 = ivec3(floor(vColor255 + 0.5));

    ivec3 c5 = (tex5 * col8 * 2) >> 8;
    c5 = min(max(c5, ivec3(0)), ivec3(31));

    // Dither em textura
    if (vDither != 0) {
        ivec3 c8 = max((c5 << 3) + ivec3(dith), ivec3(0));
        c5 = min(c8 >> 3, ivec3(31));
    }

    fragColor = vec4(vec3(c5) / 31.0, maskOut);
}`;

// ============================================================================
// WebGLRenderer Class
// ============================================================================
function WebGLRenderer(canvas) {
    this.gl = null
    this.programDisplay = null
    this.vertexBuffer = new Uint32Array(18 * 1024 >> 2)
    this.drawOffsetX = 0
    this.drawOffsetY = 0
    this.displaymode = 2
    this.vram = new Uint16Array(512 * 1024);
    this.vertexClip = false;
    this.drawAreaChange = false;
    this.seenRender = false;
    this.fpsRenderCounter = 0;
    this.fpsCounter = 0;

    // [FIEL] GP0(E6h) mask bits
    this.maskSet = 0;
    this.maskCheck = 0;

    try {
        const options = {
            alpha: false,
            antialias: false,
            preserveDrawingBuffer: false,
            premultipliedAlpha: false,
            depth: false,
            stencil: false,
            powerPreference: 'high-performance',
        };
        // [FIEL] PS1 exige pipeline WebGL2
        this.gl = canvas.getContext("webgl2", options);
    }
    catch (e) {
        alert("Error: Unable to get WebGL2 context");
        return;
    }

    if (this.gl) {
        this.initShaders();
        this.initTextures();
        this.setupBuffers();
        var gl = this.gl;
        this.setupWebGL(canvas);
        gl.useProgram(this.programDraw);
        gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.buf16draw);
        gl.activeTexture(this.gl.TEXTURE1);
        gl.bindTexture(this.gl.TEXTURE_2D, this.tex8vram);
        this.vertexBuffer.reset();
        this.setupProgramDraw();
    }
    else {
        alert("Error: Your browser does not appear to support WebGL.");
    }
}

WebGLRenderer.prototype.getClutInfo = function (cl, tm) {
    var cx = ((cl >>> 0) & 0x03f) * 16;
    var cy = ((cl >>> 6) & 0x1ff);
    if (tm === 2) return 3;
    if (tm === 1) var len = 256;
    if (tm === 0) var len = 16;
    var info = 0;
    var offs = 1024 * cy + cx;
    var vram = this.vram;
    while (--len >= 0) {
        var pixel = vram[offs++];
        if (pixel !== 0) {
            if (pixel <= 0x7fff) {
                info |= 1;
            }
            else {
                info |= 2;
            }
        }
    }
    return info;
}

WebGLRenderer.prototype.outsideDrawArea = function (x1, y1, x2, y2, x3, y3) {
    if ((x1 < this.drawAreaL) && (x2 < this.drawAreaL) && (x3 < this.drawAreaL)) return true;
    if ((x1 > this.drawAreaR) && (x2 > this.drawAreaR) && (x3 > this.drawAreaR)) return true;
    if ((y1 < this.drawAreaT) && (y2 < this.drawAreaT) && (y3 < this.drawAreaT)) return true;
    if ((y1 > this.drawAreaB) && (y2 > this.drawAreaB) && (y3 > this.drawAreaB)) return true;
    return false;
}

WebGLRenderer.prototype.largePrimitive = function (x1, y1, x2, y2, x3, y3) {
    if (Math.abs(x1 - x2) > 1023) return true;
    if (Math.abs(x2 - x3) > 1023) return true;
    if (Math.abs(x3 - x1) > 1023) return true;
    if (Math.abs(y1 - y2) > 511) return true;
    if (Math.abs(y2 - y3) > 511) return true;
    if (Math.abs(y3 - y1) > 511) return true;
    return false;
}

WebGLRenderer.prototype.setupWebGL = function (canvas) {
    var gl = this.gl;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DITHER);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.SAMPLE_COVERAGE);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    this.canvas = canvas;
}

WebGLRenderer.prototype.initShaders = function () {
    try {
        var gl = this.gl;

        // Program Draw
        this.programDraw = gl.createProgram();
        gl.attachShader(this.programDraw, this.makeShader(vertexShaderDraw, gl.VERTEX_SHADER));
        gl.attachShader(this.programDraw, this.makeShader(fragmentShaderDraw, gl.FRAGMENT_SHADER));
        gl.linkProgram(this.programDraw);
        if (!gl.getProgramParameter(this.programDraw, gl.LINK_STATUS)) {
            console.log("Unable to initialize the shader program Draw.");
            console.log(gl.getProgramInfoLog(this.programDraw));
        }
        gl.useProgram(this.programDraw);
        this.programDraw.uTex8 = gl.getUniformLocation(this.programDraw, "uTex8");
        gl.uniform1i(this.programDraw.uTex8, 1);
        this.programDraw.uMaskSet = gl.getUniformLocation(this.programDraw, "uMaskSet");
        gl.uniform1f(this.programDraw.uMaskSet, 0.0);

        // Program Display (16-bit)
        this.programDisplay = gl.createProgram();
        gl.attachShader(this.programDisplay, this.makeShader(vertexShaderDisplay, gl.VERTEX_SHADER));
        gl.attachShader(this.programDisplay, this.makeShader(fragmentShader16bit, gl.FRAGMENT_SHADER));
        gl.linkProgram(this.programDisplay);
        if (!gl.getProgramParameter(this.programDisplay, gl.LINK_STATUS)) {
            console.log("Unable to initialize the shader program Display.");
            console.log(gl.getProgramInfoLog(this.programDisplay));
        }
        gl.useProgram(this.programDisplay);
        this.programDisplay.vram = gl.getUniformLocation(this.programDisplay, "uVRAM");
        this.programDisplay.ts = gl.getUniformLocation(this.programDisplay, "uTs");
        gl.uniform1i(this.programDisplay.vram, 0);

        // Program 24-bit
        this.program24bit = gl.createProgram();
        gl.attachShader(this.program24bit, this.makeShader(vertexShaderDisplay, gl.VERTEX_SHADER));
        gl.attachShader(this.program24bit, this.makeShader(fragmentShader24bit, gl.FRAGMENT_SHADER));
        gl.linkProgram(this.program24bit);
        if (!gl.getProgramParameter(this.program24bit, gl.LINK_STATUS)) {
            console.log("Unable to initialize the shader program 24bit.");
            console.log(gl.getProgramInfoLog(this.program24bit));
        }
        gl.useProgram(this.program24bit);
        this.program24bit.vram = gl.getUniformLocation(this.program24bit, "uVRAM");
        this.program24bit.ts = gl.getUniformLocation(this.program24bit, "uTs");
        gl.uniform1i(this.program24bit.vram, 1);

        // Program Texture (Debug/CLUT)
        this.programTexture = gl.createProgram();
        gl.attachShader(this.programTexture, this.makeShader(vertexShaderDisplay, gl.VERTEX_SHADER));
        gl.attachShader(this.programTexture, this.makeShader(fragmentShaderTexture, gl.FRAGMENT_SHADER));
        gl.linkProgram(this.programTexture);
        if (!gl.getProgramParameter(this.programTexture, gl.LINK_STATUS)) {
            console.log("Unable to initialize the shader program Texture.");
            console.log(gl.getProgramInfoLog(this.programTexture));
        }
        gl.useProgram(this.programTexture);
        this.programTexture.vram = gl.getUniformLocation(this.programTexture, "uVRAM");
        gl.uniform1i(this.programTexture.vram, 0);
    }
    catch (e) {
        console.log("Failed to init shaders:\n\n" + e.stack);
    }
}

WebGLRenderer.prototype.initTextures = function () {
    var gl = this.gl;

    this.tex8vram = this.createTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, 2048, 512, 0, gl.ALPHA, gl.UNSIGNED_BYTE, null);
    this.buf8vram = this.createBuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.buf8vram);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex8vram, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.tex16draw = this.createTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1024, 512, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.buf16draw = this.createBuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.buf16draw);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex16draw, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.vramP2 = this.createTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1024, 512, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

WebGLRenderer.prototype.loadImage = function (x, y, w, h, buffer) {
    let o = 0;
    for (let j = 0; j < h; ++j) {
        const offsetY = ((y + j) % 512) * 1024;
        for (let i = 0; i < w; ++i) {
            buffer[o++] = this.vram[offsetY + ((x + i) % 1024)]
        }
    }
}

WebGLRenderer.prototype.moveImage = function (sx, sy, dx, dy, w, h) {
    var gl = this.gl;
    var o = 0;
    var img = gpu.img;
    img.x = dx;
    img.y = dy;
    img.w = w;
    img.h = h;
    img.pixelCount = w * h;
    var copy = img.buffer;
    var vram = this.vram;
    for (var j = h; j > 0; --j) {
        var x = sx;
        var oy = ((sy++) % 512) * 1024;
        for (var i = w; i > 0; --i) {
            copy[o++] = vram[oy + ((x++) % 1024)];
        }
    }
    this.storeImage(img)
}

WebGLRenderer.prototype.storeImage = function (img) {
    this.seenRender = true;
    var gl = this.gl;
    var o = 0;
    var data = img.buffer;
    var vram = this.vram;
    for (var j = 0; j < img.h; ++j) {
        const offsetY = ((img.y + j) % 512) * 1024;
        var x = img.x;
        for (var i = img.w; i > 0; --i) {
            vram[offsetY + ((x++) % 1024)] = data[o++];
        }
    }
    this.storeImageInTexture(img)
}

WebGLRenderer.prototype.storeImageInTexture = function (img) {
    const gl = this.gl;
    this.flushVertexBuffer(true);

    if ((img.x + img.w) > 1024) {
        let w1 = 1024 - img.x;
        let w2 = img.w - w1;
        let buf1 = new Uint16Array(w1 * img.h);
        let buf2 = new Uint16Array(w2 * img.h);
        let i1 = 0, i2 = 0;
        for (let y = 0; y < img.h; ++y) {
            const bo = y * img.w;
            for (let x = 0; x < w1; ++x) {
                buf1[i1++] = img.buffer[bo + x];
            }
            for (let x = 0; x < w2; ++x) {
                buf2[i2++] = img.buffer[bo + x + w1];
            }
        }
        this.storeImageInTexture({ x: img.x, y: img.y, w: w1, h: img.h, buffer: buf1, pixelCount: i1 });
        this.storeImageInTexture({ x: 0, y: img.y, w: w2, h: img.h, buffer: buf2, pixelCount: i2 });
        return;
    }

    if ((img.y + img.h) > 512) {
        let h1 = 512 - img.y;
        let h2 = img.h - h1;
        this.storeImageInTexture({ x: img.x, y: img.y, w: img.w, h: h1, buffer: new Uint16Array(img.buffer.buffer, 0, h1 * img.w), pixelCount: h1 * img.w });
        this.storeImageInTexture({ x: img.x, y: 0, w: img.w, h: h2, buffer: new Uint16Array(img.buffer.buffer, h1 * img.w * 2), pixelCount: h2 * img.w });
        return;
    }

    const view = new Uint8Array(img.buffer.buffer, 0, img.pixelCount << 1);
    gl.bindTexture(gl.TEXTURE_2D, this.tex8vram);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, img.x << 1, img.y, img.w << 1, img.h, gl.ALPHA, gl.UNSIGNED_BYTE, view);

    var x1 = img.x; var x2 = img.x + img.w;
    var y1 = img.y; var y2 = img.y + img.h;

    var buffer = this.getVertexBuffer(6, 0);
    buffer.addVertexUV(x1, y1, 0, 7, 0, 0, 0, 0);
    buffer.addVertexUV(x2, y1, 0, 7, 0, 0, 0, 0);
    buffer.addVertexUV(x1, y2, 0, 7, 0, 0, 0, 0);
    buffer.addVertexUV(x2, y1, 0, 7, 0, 0, 0, 0);
    buffer.addVertexUV(x1, y2, 0, 7, 0, 0, 0, 0);
    buffer.addVertexUV(x2, y2, 0, 7, 0, 0, 0, 0);

    this.flushVertexBuffer(false);
}

WebGLRenderer.prototype.makeShader = function (src, type) {
    var gl = this.gl;
    var shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error("Error compiling shader: " + gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
    }
    return shader;
}

WebGLRenderer.prototype.setupBuffers = function () {
    var gl = this.gl;

    this.programDraw.blendAlpha = gl.getUniformLocation(this.programDraw, "uBlendAlpha");
    this.programDraw.vertexPosition = gl.getAttribLocation(this.programDraw, "aVertexPosition");
    gl.enableVertexAttribArray(this.programDraw.vertexPosition);
    this.programDraw.vertexTexture = gl.getAttribLocation(this.programDraw, "aVertexTexture");
    gl.enableVertexAttribArray(this.programDraw.vertexTexture);
    this.programDraw.textureWindow = gl.getAttribLocation(this.programDraw, "aTextureWindow");
    gl.enableVertexAttribArray(this.programDraw.textureWindow);
    this.programDraw.texturePage = gl.getAttribLocation(this.programDraw, "aTexturePage");
    gl.enableVertexAttribArray(this.programDraw.texturePage);
    this.programDraw.vertexColor = gl.getAttribLocation(this.programDraw, "aVertexColor");
    gl.enableVertexAttribArray(this.programDraw.vertexColor);
    this.programDraw.aclut = gl.getAttribLocation(this.programDraw, "aTextureClut");
    gl.enableVertexAttribArray(this.programDraw.aclut);
    this.programDraw.vertexTexture = gl.getAttribLocation(this.programDraw, "aVertexTexture");
    gl.enableVertexAttribArray(this.programDraw.vertexTexture);

    this.programDisplay.vertexPosition = gl.getAttribLocation(this.programDisplay, "aVertexPosition");
    gl.enableVertexAttribArray(this.programDisplay.vertexPosition);
    this.programDisplay.vertexTexture = gl.getAttribLocation(this.programDisplay, "aVertexTexture");
    gl.enableVertexAttribArray(this.programDisplay.vertexTexture);

    this.program24bit.vertexTexture = gl.getAttribLocation(this.program24bit, "aVertexTexture");
    gl.enableVertexAttribArray(this.program24bit.vertexTexture);
    this.program24bit.vertexPosition = gl.getAttribLocation(this.program24bit, "aVertexPosition");
    gl.enableVertexAttribArray(this.program24bit.vertexPosition);

    this.programTexture.vertexPosition = gl.getAttribLocation(this.programTexture, "aVertexPosition");
    gl.enableVertexAttribArray(this.programTexture.vertexPosition);
    this.programTexture.vertexTexture = gl.getAttribLocation(this.programTexture, "aVertexTexture");
    gl.enableVertexAttribArray(this.programTexture.vertexTexture);

    this.canvasBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.canvasBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertexBuffer, gl.DYNAMIC_DRAW);
}

WebGLRenderer.prototype.createBuffer = function () {
    var gl = this.gl;
    var buffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, buffer);
    return buffer;
}

WebGLRenderer.prototype.createTexture = function (mode) {
    var gl = this.gl;
    var texture = gl.createTexture();
    if (mode === undefined) mode = gl.NEAREST;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mode);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mode);
    return texture;
}

WebGLRenderer.prototype.setupProgramDraw = function () {
    var gl = this.gl;
    gl.viewport(0, 0, 1024, 512);
    gl.useProgram(this.programDraw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.buf16draw);
    gl.vertexAttribPointer(this.programDraw.vertexColor, 4, gl.UNSIGNED_BYTE, false, 24, 0);
    gl.vertexAttribPointer(this.programDraw.vertexPosition, 2, gl.SHORT, false, 24, 4);
    gl.vertexAttribPointer(this.programDraw.vertexTexture, 2, gl.SHORT, false, 24, 8);
    gl.vertexAttribPointer(this.programDraw.aclut, 2, gl.UNSIGNED_SHORT, false, 24, 12);
    gl.vertexAttribPointer(this.programDraw.texturePage, 2, gl.UNSIGNED_SHORT, false, 24, 16);
    gl.vertexAttribPointer(this.programDraw.textureWindow, 4, gl.UNSIGNED_BYTE, false, 24, 20);
    gl.enable(gl.SCISSOR_TEST);
}

WebGLRenderer.prototype.flushVertexBuffer = function (clip) {
    const gl = this.gl;

    if (this.vertexBuffer.index <= 0) {
        return;
    }

    if (this.vertexClip !== clip || !clip || this.drawAreaChange) {
        gl.enable(gl.SCISSOR_TEST);
        if (clip) {
            gl.scissor(
                this.drawAreaL,
                this.drawAreaT,
                (this.drawAreaR - this.drawAreaL + 1),
                (this.drawAreaB - this.drawAreaT + 1)
            );
        }
        else {
            gl.scissor(0, 0, 1024, 512);
        }
        this.vertexClip = clip;
    }

    const drawBuffer = this.vertexBuffer.view();
    const vertices = this.vertexBuffer.getNumberOfVertices();

    gl.bindBuffer(gl.ARRAY_BUFFER, this.canvasBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, drawBuffer, gl.STREAM_DRAW);

    // [FIEL] GP0(E6h) mask set
    if (this.programDraw.uMaskSet) {
        gl.uniform1f(this.programDraw.uMaskSet, this.maskSet ? 1.0 : 0.0);
    }

    // [FIEL] Fonte real: VRAM bruta em tex8vram
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.tex8vram);

    // [FIEL] Destino real: framebuffer 15-bit em tex16draw
    gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        this.tex16draw,
        0
    );

    gl.drawArrays(gl.TRIANGLES, 0, vertices);

    this.vertexBuffer.reset();
}

WebGLRenderer.prototype.setBlendMode = function (mode) {
    if (this.renderMode === mode) return;

    this.flushVertexBuffer(true);

    this.renderMode = mode;

    var gl = this.gl;

    gl.disable(gl.BLEND);

    switch (mode & 0xf) {
        // 0.5B + 0.5F
        case 0:
            gl.enable(gl.BLEND);
            gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
            gl.blendColor(0.0, 0.0, 0.0, 0.5);
            gl.blendFuncSeparate(
                gl.CONSTANT_ALPHA,
                gl.CONSTANT_ALPHA,
                gl.ZERO,
                gl.ONE
            );
            gl.uniform1f(this.programDraw.blendAlpha, 1.0);
            break;

        // B + F
        case 1:
            gl.enable(gl.BLEND);
            gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
            gl.blendFuncSeparate(
                gl.ONE,
                gl.ONE,
                gl.ZERO,
                gl.ONE
            );
            gl.uniform1f(this.programDraw.blendAlpha, 1.0);
            break;

        // B - F
        case 2:
            gl.enable(gl.BLEND);
            gl.blendEquationSeparate(gl.FUNC_REVERSE_SUBTRACT, gl.FUNC_ADD);
            gl.blendFuncSeparate(
                gl.ONE,
                gl.ONE,
                gl.ZERO,
                gl.ONE
            );
            gl.uniform1f(this.programDraw.blendAlpha, 1.0);
            break;

        // B + 0.25F
        case 3:
            gl.enable(gl.BLEND);
            gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
            gl.blendColor(0.0, 0.0, 0.0, 0.25);
            gl.blendFuncSeparate(
                gl.CONSTANT_ALPHA,
                gl.ONE,
                gl.ZERO,
                gl.ONE
            );
            gl.uniform1f(this.programDraw.blendAlpha, 1.0);
            break;

        // sem blend
        case 4:
        default:
            gl.disable(gl.BLEND);
            gl.uniform1f(this.programDraw.blendAlpha, 1.0);
            break;
    }
}

WebGLRenderer.prototype.getVertexBuffer = function (cnt, pid) {
    var select = (((pid || 0) & 0x02000000) ? ((gpu.status >> 5) & 3) : 4) | (gpu.tp << 4);
    if (!this.vertexBuffer.canHold(cnt)) {
        this.flushVertexBuffer(true);
    }
    this.setBlendMode(select);
    return this.vertexBuffer;
}

WebGLRenderer.prototype.drawLine = function (data, c1, xy1, c2, xy2) {
    this.seenRender = true;
    var x1 = this.drawOffsetX + ((data[xy1] << 21) >> 21);
    var y1 = this.drawOffsetY + ((data[xy1] << 5) >> 21);
    var x2 = this.drawOffsetX + ((data[xy2] << 21) >> 21);
    var y2 = this.drawOffsetY + ((data[xy2] << 5) >> 21);

    if (this.outsideDrawArea(x1, y1, x2, y2, x1, y1)) return;
    if (this.largePrimitive(x1, y1, x2, y2, x1, y1)) return;

    var w = Math.abs(x1 - x2);
    var h = Math.abs(y1 - y2);
    var buffer = this.getVertexBuffer(6, data[0]);

    if (x1 !== x2 || y1 !== y2) {
        if (w >= h) {
            buffer.addVertex(x1, y1 + 1, data[c1]);
            buffer.addVertex(x1, y1 + 0, data[c1]);
            buffer.addVertex(x2, y2 + 0, data[c2]);
            buffer.addVertex(x2, y2 + 0, data[c2]);
            buffer.addVertex(x2, y2 + 1, data[c2]);
            buffer.addVertex(x1, y1 + 1, data[c1]);
        }
        else {
            buffer.addVertex(x1 + 0, y1, data[c1]);
            buffer.addVertex(x1 + 1, y1, data[c1]);
            buffer.addVertex(x2 + 1, y2, data[c2]);
            buffer.addVertex(x2 + 1, y2, data[c2]);
            buffer.addVertex(x2 + 0, y2, data[c2]);
            buffer.addVertex(x1 + 0, y1, data[c1]);
        }
    }
    else {
        buffer.addVertex(x2 + 0, y2 + 0, data[c2]);
        buffer.addVertex(x2 + 1, y2 + 0, data[c2]);
        buffer.addVertex(x2 + 0, y2 + 1, data[c2]);
        buffer.addVertex(x2 + 0, y2 + 1, data[c2]);
        buffer.addVertex(x2 + 1, y2 + 0, data[c2]);
        buffer.addVertex(x2 + 1, y2 + 1, data[c2]);
    }
}

WebGLRenderer.prototype.drawTriangle = function (data, c1, xy1, c2, xy2, c3, xy3, tx, ty, uv1, uv2, uv3, cl) {
    this.seenRender = true;

    switch ((data[0] >> 24) & 0xF) {
        case 0x5:
        case 0x7:
        case 0xd:
        case 0xf:
            data[c1] = (data[c1] & 0xff000000) | 0x00808080;
            data[c2] = (data[c2] & 0xff000000) | 0x00808080;
            data[c3] = (data[c3] & 0xff000000) | 0x00808080;
            break;
    }

    var x1 = this.drawOffsetX + ((data[xy1] << 21) >> 21);
    var y1 = this.drawOffsetY + ((data[xy1] << 5) >> 21);
    var x2 = this.drawOffsetX + ((data[xy2] << 21) >> 21);
    var y2 = this.drawOffsetY + ((data[xy2] << 5) >> 21);
    var x3 = this.drawOffsetX + ((data[xy3] << 21) >> 21);
    var y3 = this.drawOffsetY + ((data[xy3] << 5) >> 21);

    if (this.outsideDrawArea(x1, y1, x2, y2, x3, y3)) return;
    if (this.largePrimitive(x1, y1, x2, y2, x3, y3)) return;

    var textured = (data[0] & 0x04000000) === 0x04000000;

    if (!textured) {
        var buffer = this.getVertexBuffer(3, data[0]);
        buffer.addVertex(x1, y1, data[c1] & 0xffffff);
        buffer.addVertex(x2, y2, data[c2] & 0xffffff);
        buffer.addVertex(x3, y3, data[c3] & 0xffffff);
        return;
    }

    if (gpu.txflip || gpu.tyflip) console.warn('texture flip with triangles');

    var u1 = (data[uv1] >>> 0) & 255;
    var v1 = (data[uv1] >>> 8) & 255;
    var u2 = (data[uv2] >>> 0) & 255;
    var v2 = (data[uv2] >>> 8) & 255;
    var u3 = (data[uv3] >>> 0) & 255;
    var v3 = (data[uv3] >>> 8) & 255;

    var cx = ((cl >>> 0) & 0x03f) * 16;
    var cy = ((cl >>> 6) & 0x1ff);

    var tm = Math.min(((gpu.status >> 7) & 3), 2);
    var semi_transparent = (data[0] & 0x02000000) === 0x02000000;

    if (!semi_transparent) {
        var buffer = this.getVertexBuffer(3, data[0]);
        buffer.addVertexUV(x1, y1, data[c1] & 0xffffff, tm, u1, v1, cx, cy);
        buffer.addVertexUV(x2, y2, data[c2] & 0xffffff, tm, u2, v2, cx, cy);
        buffer.addVertexUV(x3, y3, data[c3] & 0xffffff, tm, u3, v3, cx, cy);
    } else {
        var info = this.getClutInfo(cl, tm);

        // STP=1: semi-transparente (blend ligado)
        if (info & 2) {
            var buffer = this.getVertexBuffer(3, data[0]);
            buffer.addVertexUV(x1, y1, data[c1] & 0xffffff, tm | 8, u1, v1, cx, cy);
            buffer.addVertexUV(x2, y2, data[c2] & 0xffffff, tm | 8, u2, v2, cx, cy);
            buffer.addVertexUV(x3, y3, data[c3] & 0xffffff, tm | 8, u3, v3, cx, cy);
        }

        // STP=0: opaco (blend desligado)
        if (info & 1) {
            var buffer = this.getVertexBuffer(3, 0);
            buffer.addVertexUV(x1, y1, data[c1] & 0xffffff, tm | 16, u1, v1, cx, cy);
            buffer.addVertexUV(x2, y2, data[c2] & 0xffffff, tm | 16, u2, v2, cx, cy);
            buffer.addVertexUV(x3, y3, data[c3] & 0xffffff, tm | 16, u3, v3, cx, cy);
        }
    }
}

WebGLRenderer.prototype.drawRectangle = function (data, tx, ty, cl) {
    this.seenRender = true;

    switch ((data[0] >> 24) & 0xF) {
        case 0x5:
        case 0x7:
        case 0xd:
        case 0xf:
            data[0] = (data[0] & 0xff000000) | 0x00808080;
            break;
    }

    var x = this.drawOffsetX + ((data[1] << 21) >> 21);
    var y = this.drawOffsetY + ((data[1] << 5) >> 21);
    var w = (data[2] << 16) >> 16;
    var h = (data[2] >> 16);

    if (!w || !h) return;

    var showT1 = !this.outsideDrawArea(x + 0, y + 0, x + w - 1, y + 0, x + 0, y + h - 1);
    var showT2 = !this.outsideDrawArea(x + 0, y + h - 1, x + w - 1, y + 0, x + w - 1, y + h - 1);

    if (!showT1 && !showT2) return;

    var textured = (data[0] & 0x04000000) === 0x04000000;

    // [FIEL] Retângulo texturizado usa shading neutro 0x808080.
    var c = textured ? 0x00808080 : (data[0] & 0xffffff);

    if (!textured) {
        var buffer = this.getVertexBuffer(6, data[0]);
        buffer.addVertex(x + 0, y + 0, c);
        buffer.addVertex(x + w, y + 0, c);
        buffer.addVertex(x + 0, y + h, c);
        buffer.addVertex(x + w, y + 0, c);
        buffer.addVertex(x + 0, y + h, c);
        buffer.addVertex(x + w, y + h, c);

        if (!c && w > 1 && h > 1) {
            this.flushVertexBuffer(true);
            this.clearVRAM(x, y, w, h, c, true);
        }
        return;
    }

    var cx = ((cl >>> 0) & 0x03f) * 16;
    var cy = ((cl >>> 6) & 0x1ff);
    var tm = Math.min(((gpu.status >> 7) & 3), 2);

    var tl = tx + 0;
    var tr = tx + w;
    if (gpu.txflip) {
        tl = tx + 0;
        tr = tx - w + 1;
    }

    var tt = ty + 0;
    var tb = ty + h;
    if (gpu.tyflip) {
        tt = ty + 0;
        tb = ty - h + 1;
    }

    var semi_transparent = (data[0] & 0x02000000) === 0x02000000;

    if (!semi_transparent) {
        var buffer = this.getVertexBuffer(6, data[0]);
        buffer.addVertexUV(x + 0, y + 0, c, tm, tl, tt, cx, cy);
        buffer.addVertexUV(x + w, y + 0, c, tm, tr, tt, cx, cy);
        buffer.addVertexUV(x + 0, y + h, c, tm, tl, tb, cx, cy);
        buffer.addVertexUV(x + w, y + 0, c, tm, tr, tt, cx, cy);
        buffer.addVertexUV(x + 0, y + h, c, tm, tl, tb, cx, cy);
        buffer.addVertexUV(x + w, y + h, c, tm, tr, tb, cx, cy);
    } else {
        var info = this.getClutInfo(cl, tm);

        // STP=1: semi-transparente
        if (info & 2) {
            var buffer = this.getVertexBuffer(6, data[0]);
            buffer.addVertexUV(x + 0, y + 0, c, tm | 8, tl, tt, cx, cy);
            buffer.addVertexUV(x + w, y + 0, c, tm | 8, tr, tt, cx, cy);
            buffer.addVertexUV(x + 0, y + h, c, tm | 8, tl, tb, cx, cy);
            buffer.addVertexUV(x + w, y + 0, c, tm | 8, tr, tt, cx, cy);
            buffer.addVertexUV(x + 0, y + h, c, tm | 8, tl, tb, cx, cy);
            buffer.addVertexUV(x + w, y + h, c, tm | 8, tr, tb, cx, cy);
        }

        // STP=0: opaco
        if (info & 1) {
            var buffer = this.getVertexBuffer(6, 0);
            buffer.addVertexUV(x + 0, y + 0, c, tm | 16, tl, tt, cx, cy);
            buffer.addVertexUV(x + w, y + 0, c, tm | 16, tr, tt, cx, cy);
            buffer.addVertexUV(x + 0, y + h, c, tm | 16, tl, tb, cx, cy);
            buffer.addVertexUV(x + w, y + 0, c, tm | 16, tr, tt, cx, cy);
            buffer.addVertexUV(x + 0, y + h, c, tm | 16, tl, tb, cx, cy);
            buffer.addVertexUV(x + w, y + h, c, tm | 16, tr, tb, cx, cy);
        }
    }
}

let clr = new Uint16Array(1024 * 512);
const clrState = {
    color: 0,
    c: 0,
    size: 1024 * 512
};
clr.fill(0);

WebGLRenderer.prototype.clearVRAM = function (x, y, w, h, color, clip) {
    var gl = this.gl;

    if (clip && !(gpu.status & (1 << 21))) {
        let l = x, r = l + w, t = y, b = y + h;
        l = (l <= gpu.drawAreaX1) ? gpu.drawAreaX1 : l;
        r = (r >= gpu.drawAreaX2) ? gpu.drawAreaX2 : r;
        t = (t <= gpu.drawAreaY1) ? gpu.drawAreaY1 : t;
        b = (b >= gpu.drawAreaY2) ? gpu.drawAreaY2 : b;
        x = l; w = r - l;
        y = t; h = b - t;
    }

    const size = (w * h) >>> 0;

    if ((clrState.color !== color) || (clrState.size < size)) {
        clrState.color = color;
        clrState.size = size;
        const r = (color >>> 3) & 0x1f;
        const g = (color >>> 11) & 0x1f;
        const b = (color >>> 19) & 0x1f;
        const c = (b << 10) | (g << 5) | r;
        clrState.c = c;
        clr.fill(c, 0, size);
    }

    for (let j = 0; j < h; ++j) {
        const offsetY = ((y + j) % 512) * 1024;
        for (let i = 0; i < w; ++i) {
            this.vram[offsetY + ((x + i) % 1024)] = clrState.c;
        }
    }

    gl.bindTexture(gl.TEXTURE_2D, this.tex8vram);
    const view = new Uint8Array(clr.buffer, 0, size << 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x << 1, y, w << 1, h, gl.ALPHA, gl.UNSIGNED_BYTE, view);
    gl.bindTexture(gl.TEXTURE_2D, null);
}

WebGLRenderer.prototype.fillRectangle = function (data) {
    this.seenRender = true;
    var gl = this.gl;

    var x = (data[1] << 16) >> 16;
    var y = (data[1] >> 16);
    var c = (data[0] & 0xf8f8f8);
    var w = (data[2] << 16) >>> 16;
    var h = (data[2] >> 16) >>> 0;

    x = (x & 0x3f0);
    y = (y & 0x1ff);
    w = ((w & 0x3ff) + 15) & ~15;
    h = (h & 0x1ff);

    if (!w || !h) return;

    if ((x + w) > 1024) {
        console.log('fillRectangle does not support x-wrap', x, w)
        return;
    }

    if ((y + h) > 512) {
        console.log('fillRectangle does not support y-wrap', h, y)
        return;
    }

    this.flushVertexBuffer(true);
    this.clearVRAM(x, y, w, h, c, false);

    var buffer = this.getVertexBuffer(6, 0);
    buffer.addVertex(x + 0, y + 0, c);
    buffer.addVertex(x + w, y + 0, c);
    buffer.addVertex(x + 0, y + h, c);
    buffer.addVertex(x + 0, y + h, c);
    buffer.addVertex(x + w, y + 0, c);
    buffer.addVertex(x + w, y + h, c);

    this.flushVertexBuffer(false);
}

WebGLRenderer.prototype.setDrawAreaOF = function (x, y) {
    this.drawOffsetX = x;
    this.drawOffsetY = y;
}

WebGLRenderer.prototype.setDrawAreaTL = function (x, y) {
    this.flushVertexBuffer(true);
    this.drawAreaChange = true;
    this.drawAreaT = y;
    this.drawAreaL = x;
}

WebGLRenderer.prototype.setDrawAreaBR = function (x, y) {
    this.flushVertexBuffer(true);
    this.drawAreaChange = true;
    this.drawAreaB = y;
    this.drawAreaR = x;
}

WebGLRenderer.prototype.onVBlankEnd = function () {
}

WebGLRenderer.prototype.onVBlankBegin = function () {
    var gl = this.gl;
    this.flushVertexBuffer(true);

    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(this.programDisplay);

    this.vertexBuffer.addVertexDisp(-32768, +32767, 0, 0);
    this.vertexBuffer.addVertexDisp(+32767, +32767, 1024, 0);
    this.vertexBuffer.addVertexDisp(-32768, -32768, 0, 512);
    this.vertexBuffer.addVertexDisp(+32767, +32767, 1024, 0);
    this.vertexBuffer.addVertexDisp(-32768, -32768, 0, 512);
    this.vertexBuffer.addVertexDisp(+32767, -32768, 1024, 512);

    gl.disable(gl.BLEND);
    this.renderMode = 5;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.canvasBuffer);
    gl.vertexAttribPointer(this.programDisplay.vertexPosition, 2, gl.SHORT, true, 8, 0);
    gl.vertexAttribPointer(this.programDisplay.vertexTexture, 2, gl.SHORT, false, 8, 4);

    var drawBuffer = this.vertexBuffer.view();
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, drawBuffer);

    if (this.displaymode === 0) {
        gl.viewport(0, 0, this.canvas.width = 2048, this.canvas.height = 1024);
        display8bit(this, drawBuffer)
    }

    if (this.displaymode === 1) {
        gl.viewport(0, 0, this.canvas.width = 4096, this.canvas.height = 2048);
        display16bit(this, drawBuffer)
    }

    if (this.displaymode === 3) {
        gl.viewport(0, 0, this.canvas.width = 4096, this.canvas.height = 2048);
        display16bit(this, drawBuffer)
    }

    if (this.displaymode === 2) {
        var area = gpu.getDisplayArea();
        this.vertexBuffer.reset()

        var al = area.x
        var ar = area.x + area.w;
        var at = area.y;
        var ab = area.y + area.h;

        this.vertexBuffer.addVertexDisp(-32768, +32767, al, at);
        this.vertexBuffer.addVertexDisp(+32767, +32767, ar, at);
        this.vertexBuffer.addVertexDisp(-32768, -32768, al, ab);
        this.vertexBuffer.addVertexDisp(+32767, +32767, ar, at);
        this.vertexBuffer.addVertexDisp(-32768, -32768, al, ab);
        this.vertexBuffer.addVertexDisp(+32767, -32768, ar, ab);

        var drawBuffer = this.vertexBuffer.view()
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, drawBuffer);

        if (gpu.status & (1 << 23)) {
            gl.viewport(0, 0, this.canvas.width = area.w, this.canvas.height = area.h);
            gl.clearColor(0.0, 0.0, 0.0, 1.0);
            gl.clear(gl.COLOR_BUFFER_BIT);
        }
        else if (gpu.status & (1 << 21)) {
            gl.viewport(0, 0, this.canvas.width = area.w, this.canvas.height = area.h);
            display24bit(this, drawBuffer, al, at);
        }
        else {
            gl.viewport(0, 0, this.canvas.width = area.w, this.canvas.height = area.h);
            display16bit(this, drawBuffer, al, at);
        }
    }

    this.vertexBuffer.reset();
    this.setupProgramDraw();

    if (this.seenRender) {
        ++this.fpsRenderCounter;
    }
    ++this.fpsCounter;
    this.seenRender = false;
}

WebGLRenderer.prototype.setMode = function (mode) {
    switch (mode) {
        default:
        case 'disp': this.displaymode = 2; break
        case 'draw': this.displaymode = 1; break
        case 'clut4':
        case 'clut8': this.displaymode = 0; break
        case 'page2': this.displaymode = 3; break
    }
}

// ============================================================================
// Display Functions
// ============================================================================
function display8bit(self, drawBuffer) {
    var gl = self.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.useProgram(self.programTexture);
    gl.vertexAttribPointer(self.programTexture.vertexPosition, 2, gl.SHORT, true, 8, 0);
    gl.vertexAttribPointer(self.programTexture.vertexTexture, 2, gl.SHORT, false, 8, 4);
    gl.bindTexture(gl.TEXTURE_2D, self.tex8vram);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function display16bit(self, drawBuffer, al, at) {
    var gl = self.gl;
    if (al === undefined) al = 0;
    if (at === undefined) at = 0;

    var lace = ((gpu.status >> 22) & 1) ? 2.0 : 1.0;

    gl.activeTexture(gl.TEXTURE0);
    gl.useProgram(self.programDisplay);
    gl.uniform3f(self.programDisplay.ts, al, at, lace);
    gl.vertexAttribPointer(self.programDisplay.vertexPosition, 2, gl.SHORT, true, 8, 0);
    gl.vertexAttribPointer(self.programDisplay.vertexTexture, 2, gl.SHORT, false, 8, 4);

    const texture = self.displaymode === 3 ? self.vramP2 : self.tex16draw;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function display24bit(self, drawBuffer, al, at) {
    var gl = self.gl;
    var lace = ((gpu.status >> 22) & 1) ? 2.0 : 1.0;

    gl.activeTexture(gl.TEXTURE1);
    gl.useProgram(self.program24bit);
    gl.uniform3f(self.program24bit.ts, al, at, lace);
    gl.vertexAttribPointer(self.program24bit.vertexPosition, 2, gl.SHORT, true, 8, 0);
    gl.vertexAttribPointer(self.program24bit.vertexTexture, 2, gl.SHORT, false, 8, 4);

    // [FIEL] 24-bit lê bytes reais da VRAM (tex8vram), não o framebuffer renderizado
    gl.bindTexture(gl.TEXTURE_2D, self.tex8vram);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
}

// ============================================================================
// Mask Bit Hook
// ============================================================================
WebGLRenderer.prototype.setMaskBits = function (setMask, checkMask) {
    this.maskSet = setMask ? 1 : 0;
    this.maskCheck = checkMask ? 1 : 0;

    if (this.gl && this.programDraw && this.programDraw.uMaskSet) {
        this.gl.useProgram(this.programDraw);
        this.gl.uniform1f(this.programDraw.uMaskSet, this.maskSet ? 1.0 : 0.0);
    }
};