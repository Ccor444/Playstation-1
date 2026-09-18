(scope => {

	const frameCount = (1.0 * 44100) >> 1;
	'use strict';

	var BLOCKSIZE = (28 * 0x1000) >>> 0;
	const CYCLES_PER_EVENT = 8;

	let left = null;
	let right = null;

	// MOBILE (aditivo): reaproveita RecompilerConfig.mobileMode quando presente,
	// lido em tempo de execução. Aqui o problema não é CPU, é alocação de lixo
	// (GC) dentro do laço de áudio em tempo real — pausas de GC em engines mais
	// fracas causam glitch audível. As mudanças abaixo só trocam de onde vem a
	// memória; nenhum valor calculado muda.
	function isMobileMode() {
		return (typeof scope.RecompilerConfig !== 'undefined') && !!scope.RecompilerConfig.mobileMode;
	}

	// Buffer reutilizável para evitar `new Array` a cada amostra em event().
	const cdxaBuf = [0.0, 0.0];

	function init() {
		const context = new AudioContext();
		const buffer = context.createBuffer(2, frameCount, context.sampleRate);
		const source = context.createBufferSource();

		left = buffer.getChannelData(0);
		left.fill(0);
		right = buffer.getChannelData(1);
		right.fill(0)

		source.playbackRate.value = 44100 / context.sampleRate;
		source.buffer = buffer;
		source.loop = true;
		source.connect(context.destination);
		source.start();
	}

	var spu = {
		totalSamples: 0,
		voices: [],
		index: 0,
		writeIndex: (44100 * 0.125) >> 0,

		data: new Uint8Array(512 * 1024),

		ENDX: 0x00ffffff,
		SPUCNT: 0x0000,
		SPUSTAT: 0x0000,
		SPUSTATm: 0x0000,
		mainVolumeLeft: 0.0,
		mainVolumeRight: 0.0,
		reverbVolumeLeft: 0.0,
		reverbVolumeRight: 0.0,
		cdVolumeLeft: 0.0,
		cdVolumeRight: 0.0,
		extVolumeLeft: 0.0,
		extVolumeRight: 0.0,
		irqOffset: 0,
		ramOffset: 0,
		reverbOffset: 0,

		// Voice bitmasks (24 voices packed into low 24 bits)
		EON: 0,   // echo/reverb-send enable per voice
		NON: 0,   // noise mode enable per voice
		PMON: 0,  // pitch-modulation enable per voice

		// Reverb (32 x 16-bit registers @ 1DC0h-1DFFh)
		reverbRegs: new Int16Array(32),
		reverbPos: 0,
		reverbOutL: 0.0,
		reverbOutR: 0.0,

		// Noise generator (single global generator shared by all NON-enabled voices).
		// NOTE: PS1's exact noise LFSR constants aren't reliably documented publicly;
		// this reproduces the documented *behavior* (frequency scales with SPUCNT
		// shift/step bits, full-band pseudo-random output) but is not a verified
		// cycle-exact port of the real silicon's tap/step table.
		noiseLevel: 0x0001,
		noiseCounter: 0,

		// last raw (pre-ADSR/volume) decoded sample per voice, used for pitch modulation
		prevVoiceSample: new Float32Array(24),

		silence: function () {
			if (left && right) {
				for (var i = 0; i < frameCount; ++i) {
					left[i] = right[i] = 0.0;
				}
			}
		},

		getVolume: function (data) {
			// if (data & 0x8000) return 0.75; // no sweep yet
			return ((data << 17) >> 16) / 0x8000;
		},

		getInt16: function (addr) {
			switch (addr) {
				case 0x1daa: return this.SPUCNT;
				case 0x1dae: return this.SPUSTAT;
				case 0x1d9c: return this.ENDX;
				default:
					if ((addr >= 0x1c00) && (addr < 0x1d80)) {
						const id = (addr - 0x1c00) >> 4;
						const voice = this.voices[id];

						return voice.getRegister(addr);
					}
					return map16[((0x01800000 + addr) & 0x01ffffff) >>> 1];
			}
		},

		setInt16: function (addr, data) {
			data &= 0xffff;

			switch (addr) {
				case 0x1d80: this.mainVolumeLeft = this.getVolume(data);
					break;
				case 0x1d82: this.mainVolumeRight = this.getVolume(data);
					break;
				case 0x1d84: this.reverbVolumeLeft = this.getVolume(data);
					break;
				case 0x1d86: this.reverbVolumeRight = this.getVolume(data);
					break;
				case 0x1d88: for (var i = 0; i < 16; ++i) {
					if ((data & (1 << i)) === 0) continue
					this.voices[i].keyOn()
					this.ENDX &= ~(1 << i);
				}
					break
				case 0x1d8a: for (var i = 0; i < 8; ++i) {
					if ((data & (1 << i)) === 0) continue
					this.voices[16 + i].keyOn()
					this.ENDX &= ~(1 << (16 + i));
				}
					break
				case 0x1d8c: for (var i = 0; i < 16; ++i) {
					if ((data & (1 << i)) === 0) continue
					this.voices[i].keyOff()
				}
					break
				case 0x1d8e: for (var i = 0; i < 8; ++i) {
					if ((data & (1 << i)) === 0) continue
					this.voices[16 + i].keyOff()
				}
					break
				case 0x1d90: this.PMON = ((this.PMON & 0xff0000) | data) >>> 0;
					break
				case 0x1d92: this.PMON = ((this.PMON & 0x00ffff) | ((data & 0xff) << 16)) >>> 0;
					break
				case 0x1d94: this.NON = ((this.NON & 0xff0000) | data) >>> 0;
					break
				case 0x1d96: this.NON = ((this.NON & 0x00ffff) | ((data & 0xff) << 16)) >>> 0;
					break
				case 0x1d98: this.EON = ((this.EON & 0xff0000) | data) >>> 0;
					break
				case 0x1d9a: this.EON = ((this.EON & 0x00ffff) | ((data & 0xff) << 16)) >>> 0;
					break
				case 0x1d9c:  // readonly Voice 0..15 on/off
					break
				case 0x1d9e:  // readonly Voice 16..23 on/off
					break
				case 0x1da0:  // ??? Legend of Dragoon
					break
				case 0x1da2: this.reverbOffset = data << 3;
					break
				case 0x1da4: this.irqOffset = data << 3;
					break
				case 0x1da6: this.ramOffset = data << 3;
					break
				case 0x1da8: this.data[this.ramOffset + 0] = (data >> 0) & 0xff;
					this.data[this.ramOffset + 1] = (data >> 8) & 0xff;
					this.ramOffset += 2;
					this.checkIrq();
					break
				case 0x1dac: break
				case 0x1daa: this.SPUCNT = data;
					if ((!left || !right) && this.SPUCNT & 0x8000) {
						init();
					}
					if (this.SPUCNT & (1 << 6)) {
						this.SPUSTAT &= ~(0x0040);
					}
					// todo: delayed application of bits 0-5
					this.SPUSTATm = (this.SPUCNT & 0x003F);
					break
				case 0x1dae:  // SPUSTAT (read-only)
					break
				case 0x1db0: this.cdVolumeLeft = data / 0x8000;
					break
				case 0x1db2: this.cdVolumeRight = data / 0x8000;
					break
				case 0x1db4: this.extVolumeLeft = data / 0x8000;
					break
				case 0x1db6: this.extVolumeRight = data / 0x8000;
					break
				case 0x1db8:  // ??? Legend of Dragoon
					break
				case 0x1dba:  // ??? Legend of Dragoon 
					break
				case 0x1dbc:  // ??? Legend of Dragoon 
					break
				case 0x1dbe:  // ??? Legend of Dragoon 
					break
				default: if ((addr >= 0x1c00) && (addr < 0x1d80)) {
					var id = ((addr - 0x1c00) / 16) | 0;
					var voice = this.voices[id];

					voice.setRegister(addr, data);
					break;
				}
					if ((addr >= 0x1dc0) && (addr < 0x1e00)) {
						this.setReverbRegister(addr, data);
						break;
					}
					abort("Unimplemented spu register:" + hex(addr, 4))
					break
			}
		},

		dmaTransferMode0200: function (addr, blck) {
			var transferSize = ((blck >> 16) * (blck & 0xFFFF) * 4) >>> 0;
			clearCodeCache(addr, transferSize);

			while (transferSize > 0) {
				var data = 0;
				data |= (this.data[this.ramOffset + 0] >>> 0) << 0;
				data |= (this.data[this.ramOffset + 1] >>> 0) << 8;
				map16[(addr & 0x001fffff) >>> 1] = data;
				this.ramOffset += 2;
				transferSize -= 2;
				addr += 2;
			}

			return (blck >> 16) * (blck & 0xFFFF);
		},

		dmaTransferMode0201: function (addr, blck) {
			var transferSize = ((blck >> 16) * (blck & 0xFFFF) * 4) >>> 0;

			while (transferSize > 0) {
				const data = map16[(addr & 0x001fffff) >>> 1];
				this.data[this.ramOffset + 0] = (data >> 0) & 0xff;
				this.data[this.ramOffset + 1] = (data >> 8) & 0xff;
				this.checkIrq();
				this.ramOffset += 2;
				transferSize -= 2;
				addr += 2;
			}

			return (blck >> 16) * (blck & 0xFFFF);
		},

		setReverbRegister: function (addr, data) {
			const idx = (addr - 0x1dc0) >> 1;
			if (idx >= 0 && idx < 32) this.reverbRegs[idx] = data;
		},

		// Circular reverb work-area addressing: mBASE (reverbOffset) .. end of SPU RAM (80000h),
		// position advances 2 bytes every reverb tick and wraps within that region.
		reverbAddr: function (dispBytes) {
			const base = this.reverbOffset;
			const size = (0x80000 - base);
			if (size <= 0) return base;
			let a = (dispBytes + this.reverbPos) % size;
			if (a < 0) a += size;
			return (base + a) & 0x7ffff;
		},

		reverbRead: function (dispBytes) {
			const addr = this.reverbAddr(dispBytes);
			let v = this.data[addr] | (this.data[(addr + 1) & 0x7ffff] << 8);
			if (v & 0x8000) v -= 0x10000;
			return v / 0x8000;
		},

		reverbWrite: function (dispBytes, sample) {
			const addr = this.reverbAddr(dispBytes);
			let v = (Math.max(-1, Math.min(1, sample)) * 0x7fff) | 0;
			this.data[addr] = v & 0xff;
			this.data[(addr + 1) & 0x7ffff] = (v >> 8) & 0xff;
		},

		// Real SPU reverb algorithm (same-side/different-side wall reflection IIR,
		// 4-tap early-echo comb filter, 2 cascaded all-pass filters). Matches the
		// formula documented for the CXD1837Q SPU. Runs at 22050Hz (half the audio
		// rate) - see call site in event().
		computeReverb: function (dryL, dryR) {
			const R = this.reverbRegs;
			const vol = idx => this.getVolume(R[idx]);
			const addr = idx => (R[idx] << 3) >>> 0;

			const Lin = vol(30) * dryL; // vLIN
			const Rin = vol(31) * dryR; // vRIN
			const vWALL = vol(7);
			const vIIR = vol(2);

			// Same Side Reflection (L->L, R->R)
			const mLSAMEold = this.reverbRead(addr(10));
			const mLSAME = (Lin + this.reverbRead(addr(16)) * vWALL - mLSAMEold) * vIIR + mLSAMEold;
			this.reverbWrite(addr(10), mLSAME);

			const mRSAMEold = this.reverbRead(addr(11));
			const mRSAME = (Rin + this.reverbRead(addr(17)) * vWALL - mRSAMEold) * vIIR + mRSAMEold;
			this.reverbWrite(addr(11), mRSAME);

			// Different Side Reflection (L->R, R->L)
			const mLDIFFold = this.reverbRead(addr(18));
			const mLDIFF = (Lin + this.reverbRead(addr(25)) * vWALL - mLDIFFold) * vIIR + mLDIFFold;
			this.reverbWrite(addr(18), mLDIFF);

			const mRDIFFold = this.reverbRead(addr(19));
			const mRDIFF = (Rin + this.reverbRead(addr(24)) * vWALL - mRDIFFold) * vIIR + mRDIFFold;
			this.reverbWrite(addr(19), mRDIFF);

			// Early echo (4-tap comb filter)
			let Lout = vol(3) * this.reverbRead(addr(12)) + vol(4) * this.reverbRead(addr(14)) +
				vol(5) * this.reverbRead(addr(20)) + vol(6) * this.reverbRead(addr(22));
			let Rout = vol(3) * this.reverbRead(addr(13)) + vol(4) * this.reverbRead(addr(15)) +
				vol(5) * this.reverbRead(addr(21)) + vol(6) * this.reverbRead(addr(23));

			// Late reverb, all-pass filter 1
			const vAPF1 = vol(8), dAPF1 = addr(0);
			const apf1L = this.reverbRead(addr(26) - dAPF1);
			Lout -= vAPF1 * apf1L;
			this.reverbWrite(addr(26), Lout);
			Lout = Lout * vAPF1 + apf1L;

			const apf1R = this.reverbRead(addr(27) - dAPF1);
			Rout -= vAPF1 * apf1R;
			this.reverbWrite(addr(27), Rout);
			Rout = Rout * vAPF1 + apf1R;

			// Late reverb, all-pass filter 2
			const vAPF2 = vol(9), dAPF2 = addr(1);
			const apf2L = this.reverbRead(addr(28) - dAPF2);
			Lout -= vAPF2 * apf2L;
			this.reverbWrite(addr(28), Lout);
			Lout = Lout * vAPF2 + apf2L;

			const apf2R = this.reverbRead(addr(29) - dAPF2);
			Rout -= vAPF2 * apf2R;
			this.reverbWrite(addr(29), Rout);
			Rout = Rout * vAPF2 + apf2R;

			this.reverbPos = (this.reverbPos + 2) % Math.max(1, (0x80000 - this.reverbOffset));
			this.reverbOutL = Lout;
			this.reverbOutR = Rout;
		},

		// MOBILE: mesmos dois helpers que computeReverb cria como closures locais
		// (vol/addr) a cada chamada, só que como métodos fixos do objeto spu —
		// nenhuma função nova é alocada em tempo de execução. Usados apenas por
		// computeReverbMobile logo abaixo; computeReverb continua intocado.
		reverbVol: function (idx) {
			return this.getVolume(this.reverbRegs[idx]);
		},

		reverbAddrOf: function (idx) {
			return (this.reverbRegs[idx] << 3) >>> 0;
		},

		// MOBILE: equivalente aditivo de computeReverb, matematicamente idêntico —
		// só troca as closures vol/addr (recriadas a cada chamada) pelos métodos
		// fixos acima, evitando alocação de função dentro do laço de áudio.
		computeReverbMobile: function (dryL, dryR) {
			const Lin = this.reverbVol(30) * dryL; // vLIN
			const Rin = this.reverbVol(31) * dryR; // vRIN
			const vWALL = this.reverbVol(7);
			const vIIR = this.reverbVol(2);

			// Same Side Reflection (L->L, R->R)
			const mLSAMEold = this.reverbRead(this.reverbAddrOf(10));
			const mLSAME = (Lin + this.reverbRead(this.reverbAddrOf(16)) * vWALL - mLSAMEold) * vIIR + mLSAMEold;
			this.reverbWrite(this.reverbAddrOf(10), mLSAME);

			const mRSAMEold = this.reverbRead(this.reverbAddrOf(11));
			const mRSAME = (Rin + this.reverbRead(this.reverbAddrOf(17)) * vWALL - mRSAMEold) * vIIR + mRSAMEold;
			this.reverbWrite(this.reverbAddrOf(11), mRSAME);

			// Different Side Reflection (L->R, R->L)
			const mLDIFFold = this.reverbRead(this.reverbAddrOf(18));
			const mLDIFF = (Lin + this.reverbRead(this.reverbAddrOf(25)) * vWALL - mLDIFFold) * vIIR + mLDIFFold;
			this.reverbWrite(this.reverbAddrOf(18), mLDIFF);

			const mRDIFFold = this.reverbRead(this.reverbAddrOf(19));
			const mRDIFF = (Rin + this.reverbRead(this.reverbAddrOf(24)) * vWALL - mRDIFFold) * vIIR + mRDIFFold;
			this.reverbWrite(this.reverbAddrOf(19), mRDIFF);

			// Early echo (4-tap comb filter)
			let Lout = this.reverbVol(3) * this.reverbRead(this.reverbAddrOf(12)) + this.reverbVol(4) * this.reverbRead(this.reverbAddrOf(14)) +
				this.reverbVol(5) * this.reverbRead(this.reverbAddrOf(20)) + this.reverbVol(6) * this.reverbRead(this.reverbAddrOf(22));
			let Rout = this.reverbVol(3) * this.reverbRead(this.reverbAddrOf(13)) + this.reverbVol(4) * this.reverbRead(this.reverbAddrOf(15)) +
				this.reverbVol(5) * this.reverbRead(this.reverbAddrOf(21)) + this.reverbVol(6) * this.reverbRead(this.reverbAddrOf(23));

			// Late reverb, all-pass filter 1
			const vAPF1 = this.reverbVol(8), dAPF1 = this.reverbAddrOf(0);
			const apf1L = this.reverbRead(this.reverbAddrOf(26) - dAPF1);
			Lout -= vAPF1 * apf1L;
			this.reverbWrite(this.reverbAddrOf(26), Lout);
			Lout = Lout * vAPF1 + apf1L;

			const apf1R = this.reverbRead(this.reverbAddrOf(27) - dAPF1);
			Rout -= vAPF1 * apf1R;
			this.reverbWrite(this.reverbAddrOf(27), Rout);
			Rout = Rout * vAPF1 + apf1R;

			// Late reverb, all-pass filter 2
			const vAPF2 = this.reverbVol(9), dAPF2 = this.reverbAddrOf(1);
			const apf2L = this.reverbRead(this.reverbAddrOf(28) - dAPF2);
			Lout -= vAPF2 * apf2L;
			this.reverbWrite(this.reverbAddrOf(28), Lout);
			Lout = Lout * vAPF2 + apf2L;

			const apf2R = this.reverbRead(this.reverbAddrOf(29) - dAPF2);
			Rout -= vAPF2 * apf2R;
			this.reverbWrite(this.reverbAddrOf(29), Rout);
			Rout = Rout * vAPF2 + apf2R;

			this.reverbPos = (this.reverbPos + 2) % Math.max(1, (0x80000 - this.reverbOffset));
			this.reverbOutL = Lout;
			this.reverbOutR = Rout;
		},

		// SPUCNT.10-13 = noise frequency shift, SPUCNT.8-9 = noise frequency step.
		// Higher shift = slower update (matches real hardware direction). See caveat
		// above `noiseLevel`: exact per-step increments are an approximation.
		updateNoise: function () {
			const shift = (this.SPUCNT >> 10) & 0xf;
			const step = (this.SPUCNT >> 8) & 0x3;
			const stepAdd = [4, 5, 6, 7][step];

			this.noiseCounter += stepAdd << (shift >= 11 ? 0 : (11 - shift));
			while (this.noiseCounter >= 0x8000) {
				this.noiseCounter -= 0x8000;
				const bit = ((this.noiseLevel >> 0) ^ (this.noiseLevel >> 2) ^ (this.noiseLevel >> 3) ^ (this.noiseLevel >> 5) ^ 1) & 1;
				this.noiseLevel = ((this.noiseLevel << 1) | bit) & 0xffff;
			}
		},

		getNoiseSample: function () {
			let v = this.noiseLevel;
			if (v & 0x8000) v -= 0x10000;
			return v / 0x8000;
		},

		checkIrq: function (voice) {
			if ((this.SPUCNT & 0x8040) !== 0x8040) return;

			const captureIndex = (this.totalSamples % 0x200) << 1;

			var irq = false;
			if (voice !== undefined) {
				if ((voice.blockAddress <= this.irqOffset) && (this.irqOffset < (voice.blockAddress + 16))) {
					irq = true;
				}
			}
			else {
				if (this.ramOffset === this.irqOffset) {
					irq = true;
				}
				if (captureIndex === this.irqOffset) {
					irq = true;
				}
			}


			if (irq) {
				cpu.istat |= 0x200;
				this.SPUSTAT |= 0x0040;
			}
		},

		event: function (self, clock) {
			psx.updateEvent(self, (PSX_SPEED / 44100 * CYCLES_PER_EVENT));
			if (!left || !right) return;

			this.SPUSTAT &= ~(0x003F);
			this.SPUSTAT |= (this.SPUSTATm & 0x003F);

			for (let tt = CYCLES_PER_EVENT; tt > 0; --tt) {
				++this.totalSamples;

				let l = 0, r = 0;
				let reverbInL = 0, reverbInR = 0;

				const captureIndex = (this.totalSamples % 0x200) << 1;
				this.checkIrq();
				this.updateNoise();
				const globalNoise = this.getNoiseSample();

				for (let i = 0; i <= 23; ++i) {
					let voice = this.voices[i];
					if (!voice.adsrState) { this.prevVoiceSample[i] = 0; continue; }

					// Pitch modulation: voice N's step is scaled by voice N-1's last raw
					// sample. NOTE: uses the previous *tick's* sample rather than a same-tick
					// value (the real chip processes voices 0..23 in order within one tick;
					// this mixer's structure makes a same-tick dependency impractical here),
					// and the exact scaling constants are a documented-shape approximation.
					let step = voice.pitchStep;
					if (i > 0 && ((this.PMON >>> i) & 1)) {
						const prev = this.prevVoiceSample[i - 1];
						let factor = 0x1000 + Math.round(prev * 0x1000);
						factor = Math.max(0, Math.min(0x1fff, factor));
						step = (step * factor) >> 12;
						if (step > 0x3fff) step = 0x3fff;
					}

					voice.pitchCounter += step;

					if (voice.pitchCounter >= BLOCKSIZE) {
						voice.pitchCounter -= BLOCKSIZE;

						voice.decodeBlock();
						this.checkIrq(voice);
					}

					const sampleIndex = voice.pitchCounter >>> 12;
					const rawSample = ((this.NON >>> i) & 1) ? globalNoise : voice.buffer[sampleIndex];
					this.prevVoiceSample[i] = rawSample;

					const adsrVolume = voice.mixADSR();
					const sampleL = (rawSample * adsrVolume * voice.volumeLeft);
					const sampleR = (rawSample * adsrVolume * voice.volumeRight);

					if ((this.EON >>> i) & 1) {
						reverbInL += sampleL;
						reverbInR += sampleR;
					}

					if (i === 3) {
						const mono = (sampleL * 0x8000) >>> 0;
						this.data[0x0C00 + captureIndex] = mono & 0xff;
						this.data[0x0C01 + captureIndex] = mono >> 8;
					}
					if (i === 1) {
						const mono = (sampleL * 0x8000) >>> 0;
						this.data[0x0800 + captureIndex] = mono & 0xff;
						this.data[0x0801 + captureIndex] = mono >> 8;
					}

					l += sampleL;
					r += sampleR;
				}

				var cdxa;
				if (isMobileMode()) {
					cdxaBuf[0] = 0.0; cdxaBuf[1] = 0.0;
					cdxa = cdxaBuf;
				} else {
					cdxa = [0.0, 0.0];
				}
				cdr.nextpcm(cdxa);

				let cdSampleL = (cdxa[0] * this.cdVolumeLeft);
				let cdSampleR = (cdxa[1] * this.cdVolumeRight);
				{
					const mono = (cdSampleL * 0x8000) >>> 0;
					this.data[0x0000 + captureIndex] = mono & 0xff;
					this.data[0x0001 + captureIndex] = mono >> 8;
				}
				{
					const mono = (cdSampleR * 0x8000) >>> 0;
					this.data[0x0400 + captureIndex] = mono & 0xff;
					this.data[0x0401 + captureIndex] = mono >> 8;
				}
				l += cdSampleL;
				r += cdSampleR;

				// CD audio only feeds the reverb unit when SPUCNT bit 2 (CD reverb) is set.
				if (this.SPUCNT & 0x0004) {
					reverbInL += cdSampleL;
					reverbInR += cdSampleR;
				}

				// Reverb runs at 22050Hz (half the output rate); master-enabled by SPUCNT.7.
				if (this.SPUCNT & 0x0080) {
					if ((this.totalSamples & 1) === 0) {
						if (isMobileMode()) { this.computeReverbMobile(reverbInL, reverbInR); }
						else { this.computeReverb(reverbInL, reverbInR); }
					}
					l += this.reverbOutL * this.reverbVolumeLeft;
					r += this.reverbOutR * this.reverbVolumeRight;
				}

				l = (l * this.mainVolumeLeft);
				r = (r * this.mainVolumeRight);

				left[this.writeIndex] = Math.max(Math.min(l, 1.0), -1.0);
				right[this.writeIndex] = Math.max(Math.min(r, 1.0), -1.0);
				this.writeIndex = (this.writeIndex + 1) % frameCount;

				if (captureIndex === 0x000) {
					this.SPUSTAT &= ~0x0800;
				}
				if (captureIndex === 0x200) {
					this.SPUSTAT |= 0x0800;
				}
			}
		}

	}

	function Voice(id) {
		this.id = id
		this.pitchCounter = 0
		this.repeatAddress = 0
		this.blockAddress = 0
		this.s0 = 0.0
		this.s1 = 0.0
		this.buffer = new Float32Array(28)

		this.volumeLeft = 0.0
		this.volumeRight = 0.0
		this.pitchStep = 0

		this.adsrLevel = 0;
		this.adsrState = 0;

		this.r1Cx0 = 0;
		this.r1Cx2 = 0;
		this.r1Cx4 = 0;
		this.r1Cx6 = 0;
		this.r1Cx8 = 0;
		this.r1CxA = 0;
		this.r1CxE = 0;
	}

	Voice.prototype.startAdsrAttack = function () {
		this.adsrState = 1;
		this.adsrLevel = 0;
	}

	Voice.prototype.startAdsrRelease = function () {
		this.adsrState = 4;
	}

	Voice.prototype.keyOn = function () {
		this.s0 = 0.0;
		this.s1 = 0.0;
		this.pitchCounter = BLOCKSIZE;
		this.blockAddress = this.r1Cx6 << 3;
		this.repeatAddress = this.r1CxE << 3;
		this.startAdsrAttack();
	}

	Voice.prototype.keyOff = function () {
		this.startAdsrRelease();
	}

	Voice.prototype.decodeBlock = function () {
		var blockAddress = this.blockAddress;
		let shiftFilter = spu.data[blockAddress + 0];
		let flags = spu.data[blockAddress + 1];

		var shift = (shiftFilter & 0x0f) >>> 0;
		var filter = (shiftFilter & 0xf0) >>> 3;

		var k0 = xa2flt[filter + 0];
		var k1 = xa2flt[filter + 1];
		var s0 = this.s0;
		var s1 = this.s1;

		var sample = 0;
		var output = this.buffer;
		let value;
		for (var offset = 2; offset < 16; ++offset) {
			var data = spu.data[blockAddress + offset]
			var index = ((shift << 8) + data) << 1;

			output[sample++] = value = (s0 * k0) + (s1 * k1) + xa2pcm[index + 0];
			s1 = s0; s0 = value;
			output[sample++] = value = (s0 * k0) + (s1 * k1) + xa2pcm[index + 1];
			s1 = s0; s0 = value;
		}

		this.s0 = s0;
		this.s1 = s1;

		if ((flags & 4) === 4) {
			this.repeatAddress = this.blockAddress;
		}

		this.blockAddress += 16;

		if ((flags & 1) === 1) {
			this.blockAddress = this.repeatAddress;
			spu.ENDX |= (1 << this.id);
			if ((flags & 2) === 0) {
				this.startAdsrRelease();
				this.adsrLevel = 0;
			}
		}
	}

	Voice.prototype.mixADSR = function () {
		switch (this.adsrState) {
			case 0x0: return 0.0;
			case 0x1: this.adsrAttack();
				break;
			case 0x2: this.adsrDecay();
				break;
			case 0x3: this.adsrSustain();
				break;
			case 0x4: this.adsrRelease();
				break;
			default: abort('not implemented');
		}
		if (this.adsrLevel > 0x7FFFFFFF) this.adsrLevel = 0x7FFFFFFF;
		if (this.adsrLevel < 0) {
			if (this.adsrState === 4) {
				if (this.id !== 1 && this.id !== 3) {
					this.adsrState = 0;
				}
			}
			this.adsrLevel = 0;
		}
		return (this.adsrLevel >> 16) / 0x8000;
	}

	Voice.prototype.adsrAttack = function () {
		if (this.adsrAttackMode) {
			// exponential attack
			if (this.adsrLevel < 0x60000000) {
				this.adsrLevel += rateTable[this.adsrAttackRate - 0x10 + 32];
			}
			else {
				this.adsrLevel += rateTable[this.adsrAttackRate - 0x18 + 32];
			}
		}
		else {
			// linear attack
			this.adsrLevel += rateTable[this.adsrAttackRate - 0x10 + 32];
		}
		if (this.adsrLevel >= 0x7FFFFFFF) {
			this.adsrState = 2; // decay
		}
	}

	Voice.prototype.adsrDecay = function () {
		if (this.adsrDecayMode) {
			// exponential decay
			switch ((this.adsrLevel >> 29) & 0x7) {
				case 0: this.adsrLevel -= rateTable[this.adsrDecayRate - 0x18 + 0 + 32]; break;
				case 1: this.adsrLevel -= rateTable[this.adsrDecayRate - 0x18 + 4 + 32]; break;
				case 2: this.adsrLevel -= rateTable[this.adsrDecayRate - 0x18 + 6 + 32]; break;
				case 3: this.adsrLevel -= rateTable[this.adsrDecayRate - 0x18 + 8 + 32]; break;
				case 4: this.adsrLevel -= rateTable[this.adsrDecayRate - 0x18 + 9 + 32]; break;
				case 5: this.adsrLevel -= rateTable[this.adsrDecayRate - 0x18 + 10 + 32]; break;
				case 6: this.adsrLevel -= rateTable[this.adsrDecayRate - 0x18 + 11 + 32]; break;
				case 7: this.adsrLevel -= rateTable[this.adsrDecayRate - 0x18 + 12 + 32]; break;
			}
		}
		if (((this.adsrLevel >> 28) & 0xF) <= this.adsrSustainLevel) {
			this.adsrState = 3; // sustain
		}
	}

	Voice.prototype.adsrSustain = function () {
		if (!this.adsrSustainMode) {
			this.adsrLevel += this.adsrLinearSustainRate;
			return;
		}

		if (this.adsrSustainDirection == 0) {
			if (this.adsrLevel < 0x60000000)
				this.adsrLevel += rateTable[this.adsrSustainRate - 0x10 + 32];
			else
				this.adsrLevel += rateTable[this.adsrSustainRate - 0x18 + 32];
		}
		else {
			switch ((this.adsrLevel >> 29) & 0x7) {
				case 0: this.adsrLevel -= rateTable[this.adsrSustainRate - 0x1B + 0 + 32]; break;
				case 1: this.adsrLevel -= rateTable[this.adsrSustainRate - 0x1B + 4 + 32]; break;
				case 2: this.adsrLevel -= rateTable[this.adsrSustainRate - 0x1B + 6 + 32]; break;
				case 3: this.adsrLevel -= rateTable[this.adsrSustainRate - 0x1B + 8 + 32]; break;
				case 4: this.adsrLevel -= rateTable[this.adsrSustainRate - 0x1B + 9 + 32]; break;
				case 5: this.adsrLevel -= rateTable[this.adsrSustainRate - 0x1B + 10 + 32]; break;
				case 6: this.adsrLevel -= rateTable[this.adsrSustainRate - 0x1B + 11 + 32]; break;
				case 7: this.adsrLevel -= rateTable[this.adsrSustainRate - 0x1B + 12 + 32]; break;
			}
		}
	}

	Voice.prototype.adsrRelease = function () {
		if (!this.adsrReleaseMode) {
			this.adsrLevel -= this.adsrLinearReleaseRate;
			return;
		}

		switch ((this.adsrLevel >> 29) & 0x7) {
			case 0: this.adsrLevel -= rateTable[this.adsrReleaseRate - 0x18 + 0 + 32]; break;
			case 1: this.adsrLevel -= rateTable[this.adsrReleaseRate - 0x18 + 4 + 32]; break;
			case 2: this.adsrLevel -= rateTable[this.adsrReleaseRate - 0x18 + 6 + 32]; break;
			case 3: this.adsrLevel -= rateTable[this.adsrReleaseRate - 0x18 + 8 + 32]; break;
			case 4: this.adsrLevel -= rateTable[this.adsrReleaseRate - 0x18 + 9 + 32]; break;
			case 5: this.adsrLevel -= rateTable[this.adsrReleaseRate - 0x18 + 10 + 32]; break;
			case 6: this.adsrLevel -= rateTable[this.adsrReleaseRate - 0x18 + 11 + 32]; break;
			case 7: this.adsrLevel -= rateTable[this.adsrReleaseRate - 0x18 + 12 + 32]; break;
		}
	}

	Voice.prototype.getRegister = function (addr, data) {
		switch (addr % 16) {
			case 0x0000: return this.r1Cx0;
			case 0x0002: return this.r1Cx2;
			case 0x0004: return this.r1Cx4;
			case 0x0006: return this.r1Cx6;
			case 0x0008: return this.r1Cx8;
			case 0x000a: return this.r1CxA;
			case 0x000c: return this.adsrLevel >>> 16;
			case 0x000e: return this.r1CxE;
			default: abort(`Unimplemented spu-voice register: ${((addr % 16) >>> 0).toString(16)}`)
				break
		}
	}

	Voice.prototype.setRegister = function (addr, data) {
		switch (addr % 16) {
			case 0x0000: this.volumeLeft = spu.getVolume(data);
				this.r1Cx0 = data;
				break
			case 0x0002: this.volumeRight = spu.getVolume(data)
				this.r1Cx2 = data;
				break
			case 0x0004: this.pitchStep = Math.min(data, 0x4000);
				this.r1Cx4 = data;
				break
			case 0x0006: this.blockAddress = data << 3;
				this.r1Cx6 = data;
				break
			case 0x0008: this.adsrAttackMode = (data & 0x8000) >>> 15;
				this.adsrAttackRate = (((data & 0x7F00) >>> 8) ^ 0x7F);
				this.adsrDecayMode = 1;
				this.adsrDecayRate = (((data & 0x00F0) >>> 4) ^ 0x1F) << 2;
				this.adsrSustainLevel = (data & 0x000F) >>> 0;
				this.r1Cx8 = data;
				break
			case 0x000a: this.adsrSustainMode = (data & 0x8000) >>> 15;
				this.adsrSustainDirection = (data & 0x4000) >>> 14;
				this.adsrSustainRate = (((data & 0x1FC0) >>> 6) ^ 0x7F);
				this.adsrReleaseMode = (data & 0x0020) >>> 5;
				this.adsrReleaseRate = (((data & 0x001F) >>> 0) ^ 0x1F) << 2;
				this.r1CxA = data;
				this.adsrLinearReleaseRate = rateTable[this.adsrReleaseRate - 0x0C + 32];
				if (this.adsrSustainDirection == 0) {
					this.adsrLinearSustainRate = rateTable[this.adsrSustainRate - 0x10 + 32];
				}
				else {
					this.adsrLinearSustainRate = -rateTable[this.adsrSustainRate - 0x0F + 32];
				}
				break
			case 0x000c: this.adsrLevel = data << 16;
				break
			case 0x000e: this.repeatAddress = data << 3;
				this.r1CxE = data;
				break
			default: abort("Unimplemented spu-voice register", hex(addr, 4));
				break
		}
	}

	//- init
	for (var i = 0; i < 24; ++i) {
		spu.voices[i] = new Voice(i)
	}

	//- lookup tables
	const xa2flt = new Float32Array(16 * 2);
	xa2flt.fill(0.0);

	xa2flt[2] = 60 / 64; xa2flt[3] = 0 / 64; //- [K0:+0.953125][K1:+0.000000]
	xa2flt[4] = 115 / 64; xa2flt[5] = -52 / 64; //- [K0:+1.796875][K1:-0.812500]
	xa2flt[6] = 98 / 64; xa2flt[7] = -55 / 64; //- [K0:+1.531250][K1:-0.859375]
	xa2flt[8] = 122 / 64; xa2flt[9] = -60 / 64; //- [K0:+1.906250][K1:-0.937500]

	const xa2pcm = new Float32Array(16 * 256 * 2);

	const factor = 32768.0;

	for (let shift = 0; shift < 16; ++shift) {
		for (let index = 0; index < 256; ++index) {
			const offset = ((shift << 8) + index) << 1;

			var sample = (index & 0xF0) << 8;
			if (sample & 0x8000) { sample |= 0xFFFF0000 };
			xa2pcm[offset + 1] = (sample >> shift) / factor;

			var sample = (index & 0x0F) << 12;
			if (sample & 0x8000) { sample |= 0xFFFF0000 };
			xa2pcm[offset + 0] = (sample >> shift) / factor;
		}
	}

	// ADSR
	const rateTable = new Uint32Array(160);

	function InitADSR() {
		let r, rs, rd;

		rateTable.fill(0.0);

		r = 3; rs = 1; rd = 0;

		for (let i = 32; i < 160; ++i) {
			if (r < 0x7FFFFFFF) {
				r += rs;
				rd++;
				if (rd === 5) {
					rd = 1;
					rs *= 2;
				}
			}
			if (r > 0x7FFFFFFF) r = 0x7FFFFFFF;

			rateTable[i] = r;
		}
	}

	InitADSR();

	scope.spu = spu;
	scope.xa2flt = xa2flt;
	scope.xa2pcm = xa2pcm;

})(window);
