/**
 * Audio recording, pitch/rhythm analysis, DTW alignment and latency calibration.
 *
 * Recordings are captured as 16-bit PCM WAV through an AudioWorklet when the
 * browser supports it, so the saved original is lossless. MediaRecorder is only
 * used as a fallback and the UI reports which format was saved.
 */

const RECORDER_WORKLET_SOURCE = `
class ShadowRecorderProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.chunks = [];
        this.length = 0;
        this.port.onmessage = (event) => {
            if (event.data === 'flush') this.flush();
        };
    }
    flush() {
        if (!this.length) return;
        const out = new Float32Array(this.length);
        let offset = 0;
        for (const chunk of this.chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        this.chunks = [];
        this.length = 0;
        this.port.postMessage(out, [out.buffer]);
    }
    process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (channel && channel.length) {
            this.chunks.push(new Float32Array(channel));
            this.length += channel.length;
            if (this.length >= 8192) this.flush();
        }
        return true;
    }
}
registerProcessor('shadow-recorder', ShadowRecorderProcessor);
`;

class AudioProcessor {
    constructor() {
        this.audioContext = null;
        this.mediaStream = null;
        this.mediaRecorder = null;
        this.workletNode = null;
        this.sourceNode = null;
        this.sinkNode = null;
        this.recordedChunks = [];
        this.workletReady = false;
        this.isRecording = false;
        this.recordingStartContextTime = 0;
        this.recordingSampleRate = 44100;
        this.recordingLossless = false;
        this.latencyOffsetMs = 0;
        this.onLevel = null;
        this._levelTimer = null;
        this._calibrationBuffer = null;
    }

    async initAudioContext() {
        if (!this.audioContext) {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            if (!Ctor) throw new Error('Web Audio is not supported in this browser.');
            this.audioContext = new Ctor();
        }
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
        return this.audioContext;
    }

    async ensureWorklet() {
        if (this.workletReady) return true;
        const ctx = await this.initAudioContext();
        if (!ctx.audioWorklet) return false;
        try {
            const url = URL.createObjectURL(new Blob([RECORDER_WORKLET_SOURCE], { type: 'application/javascript' }));
            await ctx.audioWorklet.addModule(url);
            URL.revokeObjectURL(url);
            this.workletReady = true;
            return true;
        } catch (err) {
            console.warn('AudioWorklet unavailable, falling back to MediaRecorder:', err);
            return false;
        }
    }

    async requestMicrophone(echoCancel = false) {
        const constraints = {
            audio: {
                echoCancellation: !!echoCancel,
                noiseSuppression: false,
                autoGainControl: false,
                channelCount: 1
            },
            video: false
        };

        if (this.mediaStream) {
            const track = this.mediaStream.getAudioTracks()[0];
            const settings = track ? track.getSettings() : {};
            if (track && track.readyState === 'live' && settings.echoCancellation === !!echoCancel) {
                return this.mediaStream;
            }
            this.mediaStream.getTracks().forEach((t) => t.stop());
            this.mediaStream = null;
        }

        try {
            this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (err) {
            const reason = err && err.name === 'NotAllowedError'
                ? 'Microphone access was blocked. Allow it in your browser settings, then try again.'
                : (err && err.name === 'NotFoundError'
                    ? 'No microphone was found on this device.'
                    : 'Microphone access failed: ' + (err && err.message ? err.message : 'unknown error'));
            throw new Error(reason);
        }

        await this.initAudioContext();
        return this.mediaStream;
    }

    async requestCamera() {
        try {
            return await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
                audio: false
            });
        } catch (err) {
            const reason = err && err.name === 'NotAllowedError'
                ? 'Camera access was blocked. Allow it in your browser settings, then try again.'
                : 'Camera access failed: ' + (err && err.message ? err.message : 'unknown error');
            throw new Error(reason);
        }
    }

    async startRecording() {
        if (this.isRecording) return;
        if (!this.mediaStream) {
            throw new Error('Microphone is not ready yet.');
        }

        const ctx = await this.initAudioContext();
        this.recordedChunks = [];
        this.recordingLossless = false;

        const useWorklet = await this.ensureWorklet();
        if (useWorklet) {
            try {
                this.sourceNode = ctx.createMediaStreamSource(this.mediaStream);
                this.workletNode = new AudioWorkletNode(ctx, 'shadow-recorder');
                this.sinkNode = ctx.createGain();
                this.sinkNode.gain.value = 0; // keep the graph pulled without monitoring

                this.workletNode.port.onmessage = (event) => {
                    const chunk = event.data;
                    if (chunk instanceof Float32Array && chunk.length) {
                        this.recordedChunks.push(chunk);
                    }
                };

                this.sourceNode.connect(this.workletNode);
                this.workletNode.connect(this.sinkNode);
                this.sinkNode.connect(ctx.destination);

                this.recordingSampleRate = ctx.sampleRate;
                this.recordingStartContextTime = ctx.currentTime;
                this.recordingLossless = true;
                this.isRecording = true;
                this._startLevelMeter();
                return { lossless: true, sampleRate: ctx.sampleRate };
            } catch (err) {
                console.warn('AudioWorklet recording failed, falling back to MediaRecorder:', err);
                this.workletNode = null;
                this.sourceNode = null;
                this.sinkNode = null;
            }
        }

        // Fallback: MediaRecorder (compressed, still never re-processed).
        const mimeCandidates = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/mp4',
            'audio/ogg;codecs=opus'
        ];
        const mimeType = mimeCandidates.find((type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type));
        if (!window.MediaRecorder || !mimeType) {
            throw new Error('This browser cannot record audio.');
        }

        this.mediaRecorder = new MediaRecorder(this.mediaStream, mimeType ? { mimeType } : undefined);
        this.mediaRecorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) this.recordedChunks.push(event.data);
        };
        this.mediaRecorder.start(250);
        this.recordingSampleRate = ctx.sampleRate;
        this.recordingStartContextTime = ctx.currentTime;
        this.recordingLossless = false;
        this.isRecording = true;
        this._startLevelMeter();
        return { lossless: false, sampleRate: ctx.sampleRate, mimeType };
    }

    async stopRecording() {
        if (!this.isRecording) return null;
        const ctx = await this.initAudioContext();
        const duration = Math.max(0, ctx.currentTime - this.recordingStartContextTime);
        this.isRecording = false;
        this._stopLevelMeter();

        let blob;
        let mimeType;
        let lossless = this.recordingLossless;

        if (this.workletNode) {
            try {
                this.workletNode.port.postMessage('flush');
                await new Promise((r) => setTimeout(r, 90));
            } catch {
                /* ignore */
            }
            const chunks = this.recordedChunks;
            this.recordedChunks = [];
            blob = encodeWAV(chunks, this.recordingSampleRate);
            mimeType = 'audio/wav';

            try { this.sourceNode.disconnect(); } catch { /* ignore */ }
            try { this.workletNode.disconnect(); } catch { /* ignore */ }
            try { this.sinkNode.disconnect(); } catch { /* ignore */ }
            this.sourceNode = null;
            this.workletNode = null;
            this.sinkNode = null;
        } else if (this.mediaRecorder) {
            const recorder = this.mediaRecorder;
            blob = await new Promise((resolve) => {
                if (recorder.state === 'inactive') {
                    resolve(new Blob(this.recordedChunks, { type: recorder.mimeType || 'audio/webm' }));
                    return;
                }
                recorder.onstop = () => {
                    resolve(new Blob(this.recordedChunks, { type: recorder.mimeType || 'audio/webm' }));
                };
                recorder.stop();
            });
            mimeType = blob.type || 'audio/webm';
            this.mediaRecorder = null;
            this.recordedChunks = [];
        } else {
            return null;
        }

        return { blob, duration, sampleRate: this.recordingSampleRate, mimeType, lossless };
    }

    _startLevelMeter() {
        const ctx = this.audioContext;
        if (!ctx || !this.mediaStream) return;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        const source = ctx.createMediaStreamSource(this.mediaStream);
        source.connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        this._levelTimer = setInterval(() => {
            analyser.getByteTimeDomainData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) {
                const v = (data[i] - 128) / 128;
                sum += v * v;
            }
            const rms = Math.sqrt(sum / data.length);
            if (this.onLevel) this.onLevel(Math.min(1, rms * 4));
        }, 60);
        this._levelAnalyser = analyser;
        this._levelSource = source;
    }

    _stopLevelMeter() {
        if (this._levelTimer) clearInterval(this._levelTimer);
        this._levelTimer = null;
        if (this._levelSource) {
            try { this._levelSource.disconnect(); } catch { /* ignore */ }
        }
        this._levelSource = null;
        this._levelAnalyser = null;
        if (this.onLevel) this.onLevel(0);
    }

    /**
     * Play one short click, record it, and measure the round-trip delay.
     * This is an estimate: it includes speaker + room + microphone input latency.
     * Returns { offsetMs, confidence, note }.
     */
    async calibrateLatency() {
        const ctx = await this.initAudioContext();
        if (!this.mediaStream) await this.requestMicrophone(false);

        await this.startRecording();

        const scheduledAt = ctx.currentTime + 0.45;
        const click = ctx.createOscillator();
        const clickGain = ctx.createGain();
        click.type = 'square';
        click.frequency.value = 1800;
        clickGain.gain.setValueAtTime(0, scheduledAt);
        clickGain.gain.linearRampToValueAtTime(0.5, scheduledAt + 0.002);
        clickGain.gain.exponentialRampToValueAtTime(0.0001, scheduledAt + 0.035);
        click.connect(clickGain);
        clickGain.connect(ctx.destination);
        click.start(scheduledAt);
        click.stop(scheduledAt + 0.05);

        await new Promise((r) => setTimeout(r, 1150));
        const result = await this.stopRecording();
        if (!result) throw new Error('Could not record the calibration click.');

        const buffer = await this.decodeBlob(result.blob, true);
        const envelope = computeLoudnessEnvelope(buffer, 512, 256);
        const peak = Math.max(...envelope.values);
        const threshold = Math.max(0.004, peak * 0.2);

        let onsetIndex = -1;
        let streak = 0;
        for (let i = 0; i < envelope.values.length; i++) {
            const t = i * envelope.hop / buffer.sampleRate;
            if (t < 0.15) continue; // ignore the recorder's own start transient
            if (envelope.values[i] >= threshold) {
                streak += 1;
                if (streak >= 2) { onsetIndex = i - 1; break; }
            } else {
                streak = 0;
            }
        }

        if (onsetIndex < 0 || peak < 0.01) {
            throw new Error('Could not hear the calibration click. Raise the speaker volume and try again.');
        }

        const heardAt = onsetIndex * envelope.hop / buffer.sampleRate;
        let offsetMs = (heardAt - (scheduledAt - this.recordingStartContextTime)) * 1000;
        offsetMs = Math.max(0, Math.min(600, offsetMs));

        // Confidence: strong isolated peak and a clean pre-click silence.
        const preClick = envelope.values.slice(0, Math.max(1, onsetIndex - 4));
        const preMax = preClick.length ? Math.max(...preClick) : 0;
        const confidence = peak > 0.05 && preMax < peak * 0.25 ? 'high' : 'low';

        this.latencyOffsetMs = Math.round(offsetMs);
        await saveSetting('latencyOffsetMs', this.latencyOffsetMs);
        return {
            offsetMs: this.latencyOffsetMs,
            confidence,
            note: 'Round-trip speaker + microphone delay (estimate, about ±15 ms).'
        };
    }

    async decodeBlob(blob, quiet = false) {
        const ctx = await this.initAudioContext();
        const arrayBuffer = await blob.arrayBuffer();
        try {
            return await ctx.decodeAudioData(arrayBuffer.slice(0));
        } catch (err) {
            if (!quiet) {
                throw new Error('Could not decode this audio. The file may use a codec the browser does not support.');
            }
            throw err;
        }
    }

    /** Extract [start, end] from an AudioBuffer into a new AudioBuffer. */
    extractSegment(buffer, start, end) {
        const sampleRate = buffer.sampleRate;
        const startSample = Math.max(0, Math.floor(start * sampleRate));
        const endSample = Math.min(buffer.length, Math.ceil(end * sampleRate));
        const length = Math.max(1, endSample - startSample);
        const ctx = this.audioContext;
        const segment = ctx.createBuffer(buffer.numberOfChannels, length, sampleRate);
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
            segment.copyToChannel(buffer.getChannelData(channel).subarray(startSample, startSample + length), channel);
        }
        return segment;
    }

    /**
     * Compare the user's recording with the original sentence.
     *
     * All numbers are measurements with a stated resolution (~12 ms per frame),
     * never a "score of correctness". Similarity values are explicitly labelled
     * estimates and are computed with DTW over loudness/pitch contours.
     */
    async analyzeAttempt({ originalBuffer, userBuffer, calibrationMs = 0, mode = 'sequential', playbackOffsetMs = 0 }) {
        if (!originalBuffer || !userBuffer) throw new Error('Nothing to compare yet.');

        // Analyse at 16 kHz: enough for pitch/rhythm and fast enough for phones.
        const originalAnalysis = await resampleForAnalysis(originalBuffer);
        const userAnalysis = await resampleForAnalysis(userBuffer);

        const originalEnvelope = computeLoudnessEnvelope(originalAnalysis, Math.max(256, Math.round(originalAnalysis.sampleRate * 0.032)), Math.max(64, Math.round(originalAnalysis.sampleRate * 0.01)));
        const userEnvelope = computeLoudnessEnvelope(userAnalysis, Math.max(256, Math.round(userAnalysis.sampleRate * 0.032)), Math.max(64, Math.round(userAnalysis.sampleRate * 0.01)));

        if (userEnvelope.peak < 0.008) {
            return {
                original: { duration: originalBuffer.duration, envelope: originalEnvelope },
                user: { duration: userBuffer.duration, envelope: userEnvelope },
                pitch: { original: [], user: [] },
                feedback: [
                    'No voice was detected in this recording.',
                    'Check that the right microphone is selected and that it is not muted, then try again.'
                ],
                similarities: {},
                frameMs: Math.round(1000 * userEnvelope.hop / userEnvelope.sampleRate),
                hasVoice: false
            };
        }

        const originalPitch = extractPitchTrack(originalAnalysis);
        const userPitch = extractPitchTrack(userAnalysis);

        const originalOnset = findOnset(originalEnvelope);
        const userOnset = findOnset(userEnvelope);

        const frameMs = 1000 * userEnvelope.hop / userEnvelope.sampleRate;
        const frameSeconds = frameMs / 1000;

        // Compare the spoken spans, not the silence the app pads recordings
        // with. Otherwise every take looks longer and later than it is.
        const originalBounds = voicedBounds(originalEnvelope);
        const userBounds = voicedBounds(userEnvelope);
        const originalVoicedStart = originalBounds.first >= 0 ? originalBounds.first * frameSeconds : 0;
        const originalVoicedEnd = originalBounds.last >= 0
            ? Math.min(originalBuffer.duration, (originalBounds.last + 1) * frameSeconds)
            : originalBuffer.duration;
        const userVoicedStart = userBounds.first >= 0 ? userBounds.first * frameSeconds : 0;
        const userVoicedEnd = userBounds.last >= 0
            ? Math.min(userBuffer.duration, (userBounds.last + 1) * frameSeconds)
            : userBuffer.duration;
        const originalVoicedDuration = Math.max(0.01, originalVoicedEnd - originalVoicedStart);
        const userVoicedDuration = Math.max(0.01, userVoicedEnd - userVoicedStart);

        // Align the voiced loudness envelopes; this also gives us timing drift.
        const loudnessDtw = dtwDistance(
            normaliseSeries(cropEnvelopeValues(originalEnvelope, originalBounds)),
            normaliseSeries(cropEnvelopeValues(userEnvelope, userBounds))
        );

        const voiced = originalPitch.values.filter((v) => v > 0);
        const userVoiced = userPitch.values.filter((v) => v > 0);
        const originalPitchHop = originalPitch.hop / originalPitch.sampleRate;
        const userPitchHop = userPitch.hop / userPitch.sampleRate;
        const originalPitchSpan = cropSeriesByTime(originalPitch.values, originalPitchHop, originalVoicedStart, originalVoicedEnd);
        const userPitchSpan = cropSeriesByTime(userPitch.values, userPitchHop, userVoicedStart, userVoicedEnd);
        const originalVoicedPitch = originalPitchSpan.filter((v) => v > 0);
        const userVoicedPitch = userPitchSpan.filter((v) => v > 0);

        // Compare intonation shape, not absolute pitch (voices differ).
        const pitchDtw = originalVoicedPitch.length > 4 && userVoicedPitch.length > 4
            ? dtwDistance(
                normaliseSeries(toSemitones(originalPitchSpan, median(originalVoicedPitch))),
                normaliseSeries(toSemitones(userPitchSpan, median(userVoicedPitch)))
            )
            : null;

        const pitchRangeOriginal = percentileRange(toSemitones(voiced, median(voiced)));
        const pitchRangeUser = percentileRange(toSemitones(userVoiced, median(userVoiced)));

        const calibration = Math.max(0, Number(calibrationMs) || 0) / 1000;
        const playbackOffset = Math.max(0, Number(playbackOffsetMs) || 0) / 1000;

        // Sequential: recording starts when the sentence ends, so the measured
        // onset plus the round-trip latency is the response delay.
        // Overlap: the original started `playbackOffset` after recording began.
        // The round-trip latency cannot be split into input/output halves, so it
        // is reported instead of applied here (never silently faked).
        const expectedOnset = mode === 'overlap' ? playbackOffset + (originalOnset * frameMs / 1000) : calibration;
        const onsetDiff = (userOnset * frameMs / 1000) - expectedOnset;
        const onsetMs = Math.round(onsetDiff * 1000);

        const feedback = [];
        if (userOnset < 0) {
            feedback.push('Could not find the start of your voice. Try speaking a little louder.');
        } else if (mode === 'sequential') {
            if (onsetMs > 60) {
                feedback.push(`You began speaking about ${onsetMs} ms after the sentence ended.`);
            } else if (onsetMs < -60) {
                feedback.push(`Your voice appears ${Math.abs(onsetMs)} ms before the sentence ended — the microphone may have picked up the original.`);
            } else {
                feedback.push('You began almost immediately after the sentence ended.');
            }
        } else {
            if (Math.abs(onsetMs) > 60) {
                feedback.push(`You started about ${Math.abs(onsetMs)} ms ${onsetMs > 0 ? 'after' : 'before'} the original.`);
            } else {
                feedback.push('Your start lined up with the original within about 60 ms.');
            }
        }

        const durationDiff = userVoicedDuration - originalVoicedDuration;
        if (Math.abs(durationDiff) > 0.15) {
            feedback.push(`Your voiced take is ${Math.abs(durationDiff).toFixed(2)} s ${durationDiff > 0 ? 'longer' : 'shorter'} than the original's voiced span (${originalVoicedDuration.toFixed(2)} s), measured from the first to the last voiced sound.`);
        }

        const originalRange = pitchRangeOriginal.high - pitchRangeOriginal.low;
        const userRange = pitchRangeUser.high - pitchRangeUser.low;
        if (Number.isFinite(originalRange) && Number.isFinite(userRange) && originalRange > 1.5) {
            const delta = userRange - originalRange;
            if (delta < -2) {
                feedback.push(`Your intonation is flatter: a ${userRange.toFixed(1)}-semitone range versus ${originalRange.toFixed(1)} in the original.`);
            } else if (delta > 2) {
                feedback.push(`Your intonation moves more: a ${userRange.toFixed(1)}-semitone range versus ${originalRange.toFixed(1)} in the original.`);
            } else {
                feedback.push(`Your pitch range is close to the original (${userRange.toFixed(1)} vs ${originalRange.toFixed(1)} semitones).`);
            }
        }

        // Rhythmic drift from the DTW path, reported as a median offset.
        let driftMs = null;
        if (Number.isFinite(loudnessDtw.cost) && loudnessDtw.path.length > 4) {
            const offsets = loudnessDtw.path.map(([i, j]) => (j - i) * frameMs / 1000);
            driftMs = Math.round(median(offsets) * 1000);
            if (Math.abs(driftMs) > 80) {
                feedback.push(`On average your rhythm runs ${Math.abs(driftMs)} ms ${driftMs > 0 ? 'behind' : 'ahead of'} the original once both voiced spans are aligned.`);
            }
        }

        if (feedback.length === 0) {
            feedback.push('Timing, rhythm and intonation all landed close to the original.');
        }

        const loudnessSimilarity = Number.isFinite(loudnessDtw.cost)
            ? Math.max(0, Math.min(100, Math.round(100 * Math.exp(-loudnessDtw.cost / 0.35))))
            : null;
        const pitchSimilarity = pitchDtw && Number.isFinite(pitchDtw.cost)
            ? Math.max(0, Math.min(100, Math.round(100 * Math.exp(-pitchDtw.cost / 0.5))))
            : null;

        return {
            original: {
                duration: originalBuffer.duration,
                envelope: originalEnvelope,
                onset: originalOnset * frameMs / 1000,
                voicedStart: originalVoicedStart,
                voicedDuration: originalVoicedDuration
            },
            user: {
                duration: userBuffer.duration,
                envelope: userEnvelope,
                onset: userOnset * frameMs / 1000,
                voicedStart: userVoicedStart,
                voicedDuration: userVoicedDuration
            },
            pitch: {
                original: originalPitch.values,
                user: userPitch.values,
                hop: originalPitch.hop / originalAnalysis.sampleRate
            },
            metrics: {
                onsetDifferenceMs: onsetMs,
                durationDifferenceMs: Math.round(durationDiff * 1000),
                driftMs,
                pitchRangeOriginal,
                pitchRangeUser,
                frameMs: Math.round(frameMs),
                originalVoicedDurationMs: Math.round(originalVoicedDuration * 1000),
                userVoicedDurationMs: Math.round(userVoicedDuration * 1000),
                loudnessDtwCost: loudnessDtw.cost,
                pitchDtwCost: pitchDtw ? pitchDtw.cost : null,
                calibrationUsedMs: Math.round(calibration * 1000),
                playbackOffsetMs: Math.round(playbackOffset * 1000)
            },
            similarities: {
                rhythm: loudnessSimilarity,
                pitch: pitchSimilarity
            },
            feedback,
            hasVoice: true
        };
    }
}

/* ------------------------------------------------------------- DSP helpers */

/** Resample to 16 kHz mono for analysis; falls back to the original buffer. */
async function resampleForAnalysis(buffer, targetRate = 16000) {
    if (!buffer || buffer.sampleRate <= targetRate) return buffer;
    const OfflineCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OfflineCtor) return buffer;
    try {
        const length = Math.max(1, Math.ceil(buffer.duration * targetRate));
        const offline = new OfflineCtor(1, length, targetRate);
        const source = offline.createBufferSource();
        source.buffer = buffer;
        source.connect(offline.destination);
        source.start(0);
        return await offline.startRendering();
    } catch (err) {
        console.warn('Resampling failed, analysing at native rate:', err);
        return buffer;
    }
}

function encodeWAV(chunks, sampleRate) {
    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    const buffer = new ArrayBuffer(44 + total * 2);
    const view = new DataView(buffer);
    const writeString = (offset, text) => {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + total * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);          // PCM chunk size
    view.setUint16(20, 1, true);           // PCM format
    view.setUint16(22, 1, true);           // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);           // block align
    view.setUint16(34, 16, true);          // bits per sample
    writeString(36, 'data');
    view.setUint32(40, total * 2, true);

    let offset = 44;
    for (const chunk of chunks) {
        for (let i = 0; i < chunk.length; i++) {
            const sample = Math.max(-1, Math.min(1, chunk[i]));
            view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
            offset += 2;
        }
    }
    return new Blob([buffer], { type: 'audio/wav' });
}

function computeLoudnessEnvelope(audioBuffer, frameSize, hop) {
    const data = audioBuffer.getChannelData(0);
    const frame = frameSize || Math.max(256, Math.round(audioBuffer.sampleRate * 0.032));
    const step = hop || Math.max(64, Math.round(audioBuffer.sampleRate * 0.01));
    const values = [];
    for (let i = 0; i + frame <= data.length; i += step) {
        let sum = 0;
        for (let j = 0; j < frame; j++) {
            const v = data[i + j];
            sum += v * v;
        }
        values.push(Math.sqrt(sum / frame));
    }
    return {
        values,
        hop: step,
        frameSize: frame,
        sampleRate: audioBuffer.sampleRate,
        peak: values.length ? Math.max(...values) : 0
    };
}

function findOnset(envelope) {
    const threshold = Math.max(0.006, envelope.peak * 0.18);
    let streak = 0;
    for (let i = 0; i < envelope.values.length; i++) {
        if (envelope.values[i] >= threshold) {
            streak += 1;
            if (streak >= 3) return Math.max(0, i - 2);
        } else {
            streak = 0;
        }
    }
    return -1;
}

/**
 * First and last frame carrying audible sound. Used to compare the spoken
 * parts only — the app pads recordings with silence, and including that
 * padding would make every take look longer and later than it really is.
 */
function voicedBounds(envelope) {
    const threshold = Math.max(0.012, envelope.peak * 0.08);
    let first = -1;
    let last = -1;
    for (let i = 0; i < envelope.values.length; i++) {
        if (envelope.values[i] >= threshold) {
            if (first < 0) first = i;
            last = i;
        }
    }
    return { first, last };
}

function cropEnvelopeValues(envelope, bounds) {
    if (bounds.first < 0 || bounds.last <= bounds.first) return envelope.values;
    return envelope.values.slice(bounds.first, bounds.last + 1);
}

function cropSeriesByTime(values, hopSeconds, startSeconds, endSeconds) {
    if (!values.length || !Number.isFinite(startSeconds) || endSeconds <= startSeconds) return values;
    const start = Math.max(0, Math.min(values.length - 1, Math.floor(startSeconds / hopSeconds)));
    const end = Math.max(start + 1, Math.min(values.length, Math.ceil(endSeconds / hopSeconds)));
    return values.slice(start, end);
}

function extractPitchTrack(audioBuffer, frameSize, hop) {
    const data = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const frame = frameSize || Math.max(512, Math.round(sampleRate * 0.064));
    const step = hop || Math.max(128, Math.round(sampleRate * 0.016));
    const values = [];
    const minTau = Math.max(2, Math.floor(sampleRate / 1000));
    const maxTau = Math.min(Math.floor(frame / 2), Math.floor(sampleRate / 70));

    for (let i = 0; i + frame <= data.length; i += step) {
        let rms = 0;
        for (let j = 0; j < frame; j++) rms += data[i + j] * data[i + j];
        rms = Math.sqrt(rms / frame);
        if (rms < 0.006) {
            values.push(0);
            continue;
        }
        const pitch = yinPitch(data, i, frame, sampleRate, minTau, maxTau);
        values.push(pitch && pitch >= 70 && pitch <= 1000 ? pitch : 0);
    }
    return { values, hop: step, frameSize: frame, sampleRate };
}

function yinPitch(data, offset, frameSize, sampleRate, minTau, maxTau) {
    const yin = new Float32Array(maxTau + 1);
    const limit = frameSize - maxTau;

    for (let tau = minTau; tau <= maxTau; tau++) {
        let sum = 0;
        for (let i = 0; i < limit; i++) {
            const delta = data[offset + i] - data[offset + i + tau];
            sum += delta * delta;
        }
        yin[tau] = sum;
    }

    let runningSum = 0;
    yin[0] = 1;
    for (let tau = minTau; tau <= maxTau; tau++) {
        runningSum += yin[tau];
        yin[tau] = runningSum === 0 ? 1 : yin[tau] * (tau - minTau + 1) / runningSum;
    }

    const threshold = 0.15;
    for (let tau = minTau + 1; tau < maxTau; tau++) {
        if (yin[tau] < threshold && yin[tau] <= yin[tau + 1]) {
            const s0 = yin[tau - 1];
            const s1 = yin[tau];
            const s2 = yin[tau + 1];
            const denominator = 2 * (2 * s1 - s2 - s0);
            const betterTau = denominator === 0 ? tau : tau + (s2 - s0) / denominator;
            return sampleRate / betterTau;
        }
    }
    return 0;
}

function toSemitones(values, reference) {
    const ref = reference || 1;
    return values.map((v) => (v > 0 ? 12 * Math.log2(v / ref) : 0));
}

function normaliseSeries(values) {
    if (!values.length) return [];
    const finite = values.filter((v) => Number.isFinite(v));
    const max = Math.max(...finite.map(Math.abs), 1e-9);
    return values.map((v) => (Number.isFinite(v) ? v / max : 0));
}

/**
 * Dynamic time warping with a Sakoe–Chiba-style band to keep it fast.
 * Returns the normalised cost and the alignment path.
 */
function dtwDistance(a, b) {
    const n = a.length;
    const m = b.length;
    if (!n || !m) return { cost: Infinity, path: [] };
    const band = Math.max(24, Math.abs(n - m) + Math.ceil(Math.max(n, m) * 0.18));

    const inf = Number.POSITIVE_INFINITY;
    const cost = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(inf));
    const back = Array.from({ length: n + 1 }, () => new Int8Array(m + 1));
    cost[0][0] = 0;

    for (let i = 1; i <= n; i++) {
        const jStart = Math.max(1, i - band);
        const jEnd = Math.min(m, i + band);
        for (let j = jStart; j <= jEnd; j++) {
            const d = Math.abs(a[i - 1] - b[j - 1]);
            let best = cost[i - 1][j - 1];
            let dir = 0; // diagonal
            if (cost[i - 1][j] < best) { best = cost[i - 1][j]; dir = 1; }
            if (cost[i][j - 1] < best) { best = cost[i][j - 1]; dir = 2; }
            cost[i][j] = d + best;
            back[i][j] = dir;
        }
    }

    let i = n;
    let j = m;
    const path = [];
    while (i > 0 && j > 0) {
        path.push([i - 1, j - 1]);
        const dir = back[i][j];
        if (dir === 1) i -= 1;
        else if (dir === 2) j -= 1;
        else { i -= 1; j -= 1; }
    }
    path.reverse();

    return { cost: cost[n][m] / Math.max(n, m), path };
}

function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentileRange(values) {
    if (!values.length) return { low: NaN, high: NaN };
    const sorted = [...values].sort((a, b) => a - b);
    const at = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
    return { low: at(0.05), high: at(0.95) };
}

function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const total = Math.round(seconds);
    const minutes = Math.floor(total / 60);
    return minutes + ':' + String(total % 60).padStart(2, '0');
}

// Global instance used by the app
const audioProcessor = new AudioProcessor();
