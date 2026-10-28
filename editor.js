/**
 * Sentence Editor
 *
 * Real waveform decoded from the imported media (peaks computed in a Worker),
 * draggable start/end handles with snap-to-silence, fine nudges, split/merge,
 * inline text editing, in/out marking for pasted transcripts, and autosave.
 */

const PEAKS_WORKER_SOURCE = `
self.onmessage = (event) => {
    const { samples, buckets } = event.data;
    const length = samples.length;
    const size = Math.max(1, Math.floor(length / buckets));
    const peaks = new Float32Array(buckets * 2);
    for (let bucket = 0; bucket < buckets; bucket++) {
        const start = bucket * size;
        const end = Math.min(length, start + size);
        let min = 1;
        let max = -1;
        for (let i = start; i < end; i++) {
            const v = samples[i];
            if (v < min) min = v;
            if (v > max) max = v;
        }
        if (end <= start) { min = 0; max = 0; }
        peaks[bucket * 2] = min;
        peaks[bucket * 2 + 1] = max;
    }
    self.postMessage(peaks, [peaks.buffer]);
};
`;

class SentenceEditor {
    constructor() {
        this.video = null;
        this.videoId = null;
        this.videoRecord = null;
        this.sentences = [];
        this.currentSentenceIndex = 0;
        this.audioBuffer = null;
        this.peaks = null;
        this.envelope = null;
        this.duration = 0;
        this.isDragging = false;
        this.dragType = null;
        this.dragPointerId = null;
        this.loopActive = false;
        this.stopAtEnd = false;
        this._listenersBound = false;
        this._saveTimer = null;
        this._raf = null;
        this._worker = null;
        this._loadToken = 0;
    }

    async init(videoId) {
        this.videoId = videoId;
        this.loopActive = false;
        this.stopAtEnd = false;
        this.audioBuffer = null;
        this.peaks = null;
        this.envelope = null;
        this._baseCanvas = null;
        this._deletedIds = new Set();
        this.video = document.getElementById('editor-video');
        this.videoRecord = await getVideo(videoId);
        if (!this.videoRecord) {
            showToast('This video could not be found. Import it again.');
            return;
        }

        this.video.src = getVideoURL(this.videoRecord);
        this.duration = Number.isFinite(this.videoRecord.duration) ? this.videoRecord.duration : 0;

        this.sentences = await getSentences(videoId);
        if (this.sentences.length === 0) {
            const transcript = await getTranscript(videoId);
            this.sentences = await sentenceEditor.seedFromTranscript(videoId, transcript);
        }
        this.currentSentenceIndex = Math.min(this.currentSentenceIndex, Math.max(0, this.sentences.length - 1));
        if (this.currentSentenceIndex < 0) this.currentSentenceIndex = 0;

        this.bindListeners();
        this.renderSentenceList();
        this.updateSelectionTime();
        this.updateLoopButton();
        this.drawWaveform();
        this.startPlayheadLoop();

        this.loadAudio().catch((err) => {
            console.warn('Waveform unavailable:', err);
            this.drawWaveform();
        });
    }

    async seedFromTranscript(videoId, transcript) {
        if (!transcript) return [];
        const sentences = buildSentencesFromTranscript(transcript);
        if (sentences.length === 0) return [];
        return replaceSentences(videoId, sentences);
    }

    bindListeners() {
        if (this._listenersBound) return;
        this._listenersBound = true;

        document.getElementById('btn-play-pause-editor').addEventListener('click', () => this.togglePlay());
        document.getElementById('btn-nudge-start-minus10').addEventListener('click', () => this.nudgeStart(-0.01));
        document.getElementById('btn-nudge-start-plus10').addEventListener('click', () => this.nudgeStart(0.01));
        document.getElementById('btn-nudge-start-minus100').addEventListener('click', () => this.nudgeStart(-0.1));
        document.getElementById('btn-nudge-start-plus100').addEventListener('click', () => this.nudgeStart(0.1));
        document.getElementById('btn-nudge-end-minus10').addEventListener('click', () => this.nudgeEnd(-0.01));
        document.getElementById('btn-nudge-end-plus10').addEventListener('click', () => this.nudgeEnd(0.01));
        document.getElementById('btn-nudge-end-minus100').addEventListener('click', () => this.nudgeEnd(-0.1));
        document.getElementById('btn-nudge-end-plus100').addEventListener('click', () => this.nudgeEnd(0.1));

        document.getElementById('btn-set-in').addEventListener('click', () => this.setInAtPlayhead());
        document.getElementById('btn-set-out').addEventListener('click', () => this.setOutAtPlayhead());
        document.getElementById('btn-split-sentence').addEventListener('click', () => this.splitSentence());
        document.getElementById('btn-merge-sentence').addEventListener('click', () => this.mergeSentence());
        document.getElementById('btn-loop-sentence').addEventListener('click', () => this.toggleLoop());

        document.getElementById('btn-editor-save').addEventListener('click', async () => {
            await this.saveNow();
            showToast('All changes saved');
        });

        const canvas = document.getElementById('waveform-canvas');
        canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
        canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
        canvas.addEventListener('pointerup', (event) => this.onPointerUp(event));
        canvas.addEventListener('pointercancel', (event) => this.onPointerUp(event));

        this.video.addEventListener('loadedmetadata', () => {
            if (Number.isFinite(this.video.duration) && this.video.duration > 0) {
                this.duration = this.video.duration;
                this.drawWaveform();
            }
        });

        this.video.addEventListener('timeupdate', () => this.drawPlayhead());
        this.video.addEventListener('play', () => {
            document.getElementById('btn-play-pause-editor').textContent = 'Pause';
        });
        this.video.addEventListener('pause', () => {
            document.getElementById('btn-play-pause-editor').textContent = 'Play';
        });
        this.video.addEventListener('ended', () => {
            this.loopActive = false;
            this.updateLoopButton();
        });

        document.addEventListener('keydown', (event) => this.onKeyDown(event));
    }

    onKeyDown(event) {
        if (!document.getElementById('screen-editor').classList.contains('active')) return;
        const tag = document.activeElement && document.activeElement.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (document.activeElement && document.activeElement.isContentEditable)) return;

        if (event.key === '[') {
            event.preventDefault();
            this.setInAtPlayhead();
        } else if (event.key === ']') {
            event.preventDefault();
            this.setOutAtPlayhead();
        } else if (event.code === 'Space') {
            event.preventDefault();
            this.togglePlay();
        } else if (event.code === 'ArrowLeft') {
            event.preventDefault();
            this.seekRelative(-1);
        } else if (event.code === 'ArrowRight') {
            event.preventDefault();
            this.seekRelative(1);
        }
    }

    seekRelative(seconds) {
        this.video.currentTime = Math.max(0, Math.min(this.duration, this.video.currentTime + seconds));
        this.drawPlayhead();
        this.updateSelectionTime();
    }

    togglePlay() {
        if (this.video.paused) {
            this.stopAtEnd = false;
            this.video.play().catch(() => showToast('Playback was blocked by the browser.'));
        } else {
            this.video.pause();
        }
    }

    current() {
        return this.sentences[this.currentSentenceIndex] || null;
    }

    hasTiming(sentence) {
        return sentence && Number.isFinite(sentence.start) && Number.isFinite(sentence.end) && sentence.end > sentence.start;
    }

    selectSentence(index, { seek = true } = {}) {
        if (index < 0 || index >= this.sentences.length) return;
        this.currentSentenceIndex = index;
        const sentence = this.current();
        if (seek && this.hasTiming(sentence)) {
            this.video.currentTime = sentence.start;
            this.drawPlayhead();
        }
        this.renderSentenceList();
        this.drawWaveform();
        this.updateSelectionTime();
    }

    /* ------------------------------------------------------------- timing */

    setInAtPlayhead() {
        const sentence = this.current();
        if (!sentence) return;
        const time = this.video.currentTime;
        sentence.start = Math.max(0, time);
        if (Number.isFinite(sentence.end) && sentence.end <= sentence.start) {
            sentence.end = Math.min(this.duration || sentence.start + 2, sentence.start + 1);
        }
        this.afterTimingChange(sentence, 'start');
    }

    setOutAtPlayhead() {
        const sentence = this.current();
        if (!sentence) return;
        const time = this.video.currentTime;
        if (!Number.isFinite(sentence.start)) {
            showToast('Set the start first (play to the right spot, then “Set In”).');
            return;
        }
        if (time <= sentence.start + 0.03) {
            showToast('The end must come after the start.');
            return;
        }
        sentence.end = Math.min(this.duration || time, time);
        this.afterTimingChange(sentence, 'end');
    }

    afterTimingChange(sentence, which) {
        sentence.words = buildUniformWords(sentence);
        this.renderSentenceList();
        this.drawWaveform();
        this.updateSelectionTime();
        this.scheduleSave();

        if (this.hasTiming(sentence)) {
            const nextUnmarked = this.sentences.findIndex((s) => !this.hasTiming(s));
            if (nextUnmarked !== -1 && which === 'end') {
                showToast('Timing set. Next sentence is ready.');
            }
        }
    }

    nudgeStart(delta) {
        const sentence = this.current();
        if (!sentence) return;
        if (!Number.isFinite(sentence.start)) {
            this.setInAtPlayhead();
            return;
        }
        let next = Math.max(0, sentence.start + delta);
        if (Number.isFinite(sentence.end)) next = Math.min(next, sentence.end - 0.02);
        sentence.start = Math.round(next * 1000) / 1000;
        sentence.words = buildUniformWords(sentence);
        this.renderSentenceList();
        this.drawWaveform();
        this.updateSelectionTime();
        this.scheduleSave();
    }

    nudgeEnd(delta) {
        const sentence = this.current();
        if (!sentence) return;
        if (!Number.isFinite(sentence.start)) {
            showToast('Set the start before adjusting the end.');
            return;
        }
        if (!Number.isFinite(sentence.end)) {
            this.setOutAtPlayhead();
            return;
        }
        let next = sentence.end + delta;
        next = Math.max(sentence.start + 0.02, next);
        if (this.duration) next = Math.min(this.duration, next);
        sentence.end = Math.round(next * 1000) / 1000;
        sentence.words = buildUniformWords(sentence);
        this.renderSentenceList();
        this.drawWaveform();
        this.updateSelectionTime();
        this.scheduleSave();
    }

    /** Snap a time to the quietest point within +/-120 ms, when audio is available. */
    snapToSilence(time) {
        if (!this.envelope || !this.envelope.values.length) return time;
        const hopSeconds = this.envelope.hop / this.envelope.sampleRate;
        const radius = Math.max(1, Math.round(0.12 / hopSeconds));
        const center = Math.round(time / hopSeconds);
        let bestIndex = -1;
        let bestValue = Infinity;
        for (let i = Math.max(0, center - radius); i <= Math.min(this.envelope.values.length - 1, center + radius); i++) {
            const value = this.envelope.values[i];
            if (value < bestValue) {
                bestValue = value;
                bestIndex = i;
            }
        }
        return bestIndex >= 0 ? bestIndex * hopSeconds : time;
    }

    splitSentence() {
        const sentence = this.current();
        if (!sentence) return;
        const timed = this.hasTiming(sentence);
        const splitTime = timed && this.video.currentTime > sentence.start && this.video.currentTime < sentence.end
            ? this.video.currentTime
            : (timed ? (sentence.start + sentence.end) / 2 : null);

        const words = sentence.text.trim().split(/\s+/).filter(Boolean);
        const ratio = timed ? (splitTime - sentence.start) / (sentence.end - sentence.start) : 0.5;
        const splitCount = Math.max(1, Math.min(words.length - 1, Math.round(words.length * ratio)));
        if (words.length < 2) {
            showToast('Add at least two words before splitting.');
            return;
        }

        const firstText = words.slice(0, splitCount).join(' ');
        const secondText = words.slice(splitCount).join(' ');

        const second = {
            videoId: this.videoId,
            start: timed ? splitTime : null,
            end: timed ? sentence.end : null,
            text: secondText,
            words: []
        };
        sentence.text = firstText;
        sentence.end = timed ? splitTime : null;
        sentence.words = buildUniformWords(sentence);

        this.sentences.splice(this.currentSentenceIndex + 1, 0, second);
        this.currentSentenceIndex += 1;
        this.renderSentenceList();
        this.drawWaveform();
        this.updateSelectionTime();
        this.scheduleSave();
    }

    mergeSentence() {
        if (this.currentSentenceIndex >= this.sentences.length - 1) {
            showToast('There is no next sentence to merge.');
            return;
        }
        const first = this.current();
        const second = this.sentences[this.currentSentenceIndex + 1];
        if (second && second.id) this._deletedIds.add(second.id);
        first.text = (first.text.trim() + ' ' + second.text.trim()).trim();
        if (this.hasTiming(first) && this.hasTiming(second)) {
            first.start = Math.min(first.start, second.start);
            first.end = Math.max(first.end, second.end);
        } else {
            first.start = null;
            first.end = null;
        }
        first.words = buildUniformWords(first);
        this.sentences.splice(this.currentSentenceIndex + 1, 1);
        this.renderSentenceList();
        this.drawWaveform();
        this.updateSelectionTime();
        this.scheduleSave();
    }

    toggleLoop() {
        const sentence = this.current();
        if (!this.hasTiming(sentence)) {
            showToast('Set the sentence timing before looping.');
            return;
        }
        this.loopActive = !this.loopActive;
        if (this.loopActive) {
            this.video.currentTime = sentence.start;
            this.video.play().catch(() => {});
            showToast('Looping the selected sentence');
        }
        this.updateLoopButton();
    }

    updateLoopButton() {
        const button = document.getElementById('btn-loop-sentence');
        if (button) button.textContent = this.loopActive ? 'Stop Loop' : 'Loop';
    }

    /* ------------------------------------------------------------ waveform */

    async loadAudio() {
        const token = ++this._loadToken;
        const blob = this.videoRecord && this.videoRecord.blob;
        if (!blob) {
            this.drawWaveform();
            return;
        }

        let buffer;
        try {
            buffer = await audioProcessor.decodeBlob(blob, true);
        } catch (err) {
            console.warn('Could not decode the media audio track:', err);
            this.drawWaveform();
            return;
        }
        if (token !== this._loadToken) return;

        this.audioBuffer = buffer;
        this.duration = buffer.duration;
        this.envelope = computeLoudnessEnvelope(buffer);

        try {
            this.peaks = await this.computePeaks(buffer);
        } catch (err) {
            console.warn('Peaks worker failed, computing inline:', err);
            this.peaks = computePeaksInline(buffer, 2000);
        }
        if (token !== this._loadToken) return;
        this.drawWaveform();
    }

    computePeaks(buffer, buckets = 2000) {
        return new Promise((resolve, reject) => {
            try {
                if (!this._worker) {
                    const url = URL.createObjectURL(new Blob([PEAKS_WORKER_SOURCE], { type: 'application/javascript' }));
                    this._worker = new Worker(url);
                    URL.revokeObjectURL(url);
                }
                const worker = this._worker;
                const samples = buffer.getChannelData(0).slice();
                worker.onmessage = (event) => resolve(event.data);
                worker.onerror = (event) => reject(new Error(event.message || 'Worker error'));
                worker.postMessage({ samples, buckets }, [samples.buffer]);
            } catch (err) {
                reject(err);
            }
        });
    }

    drawWaveform() {
        const canvas = document.getElementById('waveform-canvas');
        if (!canvas) return;
        const width = canvas.clientWidth || 320;
        const height = canvas.clientHeight || 120;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.round(width * dpr));
        canvas.height = Math.max(1, Math.round(height * dpr));
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);

        const styles = getComputedStyle(document.documentElement);
        const surface = styles.getPropertyValue('--surface-2').trim() || '#f5f5f7';
        const accent = styles.getPropertyValue('--accent').trim() || '#0071e3';
        const secondary = styles.getPropertyValue('--text-secondary').trim() || '#86868b';
        const border = styles.getPropertyValue('--border').trim() || 'rgba(0,0,0,0.08)';

        ctx.fillStyle = surface;
        ctx.fillRect(0, 0, width, height);

        const duration = this.duration || (this.video && this.video.duration) || 0;
        if (!duration) {
            ctx.fillStyle = secondary;
            ctx.font = '13px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Loading audio…', width / 2, height / 2);
            return;
        }

        // Sentence regions
        this.sentences.forEach((sentence, index) => {
            if (!this.hasTiming(sentence)) return;
            const x = sentence.start / duration * width;
            const w = Math.max(1.5, (sentence.end - sentence.start) / duration * width);
            const active = index === this.currentSentenceIndex;
            ctx.fillStyle = active ? hexToRgba(accent, 0.16) : hexToRgba(accent, 0.07);
            ctx.fillRect(x, 0, w, height);
            ctx.strokeStyle = active ? accent : hexToRgba(accent, 0.4);
            ctx.lineWidth = active ? 2 : 1;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            if (active) {
                ctx.moveTo(x + w, 0);
                ctx.lineTo(x + w, height);
            }
            ctx.stroke();
        });

        // Waveform peaks
        if (this.peaks && this.peaks.length) {
            const buckets = this.peaks.length / 2;
            const middle = height / 2;
            const amplitude = height * 0.42;
            ctx.fillStyle = hexToRgba(secondary, 0.85);
            for (let i = 0; i < width; i++) {
                const bucket = Math.min(buckets - 1, Math.floor(i / width * buckets));
                const min = this.peaks[bucket * 2];
                const max = this.peaks[bucket * 2 + 1];
                const y1 = middle + min * amplitude;
                const y2 = middle + max * amplitude;
                ctx.fillRect(i, y1, 1, Math.max(1, y2 - y1));
            }
        } else {
            ctx.strokeStyle = hexToRgba(secondary, 0.5);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, height / 2);
            ctx.lineTo(width, height / 2);
            ctx.stroke();
            ctx.fillStyle = secondary;
            ctx.font = '12px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Waveform unavailable — set timings by ear', width / 2, height / 2 - 12);
        }

        // Time ruler
        ctx.fillStyle = secondary;
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.strokeStyle = border;
        const step = niceTimeStep(duration);
        for (let t = 0; t <= duration; t += step) {
            const x = t / duration * width;
            ctx.fillText(formatClock(t), Math.min(width - 30, x + 3), height - 4);
        }

        // Handles
        const sentence = this.current();
        if (this.hasTiming(sentence)) {
            const startX = sentence.start / duration * width;
            const endX = sentence.end / duration * width;
            drawHandle(ctx, startX, height, accent);
            drawHandle(ctx, endX, height, accent);
        } else if (sentence) {
            ctx.fillStyle = secondary;
            ctx.font = '12px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Timing not set — use “Set In” / “Set Out” ( [ and ] )', width / 2, 18);
        }

        this.canvasWidth = width;
        this.canvasHeight = height;

        // Keep a cached base image so the playhead can be redrawn cheaply.
        if (!this._baseCanvas) this._baseCanvas = document.createElement('canvas');
        this._baseCanvas.width = canvas.width;
        this._baseCanvas.height = canvas.height;
        this._baseCanvas.getContext('2d').drawImage(canvas, 0, 0);

        this.drawPlayhead();
    }

    drawPlayhead() {
        const canvas = document.getElementById('waveform-canvas');
        if (!canvas || !this.canvasWidth || !this._baseCanvas) return;
        const width = this.canvasWidth;
        const height = this.canvasHeight || 120;
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== this._baseCanvas.width) return;

        const duration = this.duration || (this.video && this.video.duration) || 0;
        if (!duration) return;

        const context = canvas.getContext('2d');
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(this._baseCanvas, 0, 0);

        const x = Math.max(0, Math.min(width, this.video.currentTime / duration * width)) * dpr;
        context.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#000';
        context.lineWidth = Math.max(1, Math.round(dpr));
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, height * dpr);
        context.stroke();
    }

    startPlayheadLoop() {
        if (this._raf) cancelAnimationFrame(this._raf);
        const tick = () => {
            if (document.getElementById('screen-editor').classList.contains('active')) {
                const sentence = this.current();
                if (this.hasTiming(sentence)) {
                    if (this.loopActive && this.video.currentTime >= sentence.end) {
                        this.video.currentTime = sentence.start;
                        if (this.video.paused) this.video.play().catch(() => {});
                    } else if (this.stopAtEnd && this.video.currentTime >= sentence.end) {
                        this.video.pause();
                        this.stopAtEnd = false;
                    }
                }
                this.drawPlayhead();
            }
            this._raf = requestAnimationFrame(tick);
        };
        this._raf = requestAnimationFrame(tick);
    }

    /* ---------------------------------------------------------- pointer UI */

    canvasTimeFromEvent(event) {
        const canvas = document.getElementById('waveform-canvas');
        const rect = canvas.getBoundingClientRect();
        const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
        return { time: x / rect.width * (this.duration || 0), x }; // x is CSS pixels
    }

    onPointerDown(event) {
        const sentence = this.current();
        const { x } = this.canvasTimeFromEvent(event);
        const canvas = document.getElementById('waveform-canvas');
        const width = canvas.clientWidth;
        const duration = this.duration || 0;

        let dragType = null;
        if (sentence && this.hasTiming(sentence) && duration) {
            const startX = sentence.start / duration * width;
            const endX = sentence.end / duration * width;
            if (Math.abs(x - startX) <= 14) dragType = 'start';
            else if (Math.abs(x - endX) <= 14) dragType = 'end';
        }

        if (!dragType) {
            this.video.currentTime = this.canvasTimeFromEvent(event).time;
            this.drawPlayhead();
            this.updateSelectionTime();
            return;
        }

        event.preventDefault();
        this.isDragging = true;
        this.dragType = dragType;
        this.dragPointerId = event.pointerId;
        canvas.setPointerCapture(event.pointerId);
        this._dragSnap = !event.shiftKey;
    }

    onPointerMove(event) {
        const canvas = document.getElementById('waveform-canvas');
        if (!this.isDragging || event.pointerId !== this.dragPointerId) {
            // Cursor affordance
            const sentence = this.current();
            if (!sentence || !this.hasTiming(sentence) || !this.duration) return;
            const { x } = this.canvasTimeFromEvent(event);
            const width = canvas.clientWidth;
            const startX = sentence.start / this.duration * width;
            const endX = sentence.end / this.duration * width;
            canvas.style.cursor = (Math.abs(x - startX) <= 14 || Math.abs(x - endX) <= 14) ? 'ew-resize' : 'crosshair';
            return;
        }

        event.preventDefault();
        const sentence = this.current();
        let time = this.canvasTimeFromEvent(event).time;
        if (this._dragSnap) time = this.snapToSilence(time);

        if (this.dragType === 'start') {
            sentence.start = Math.max(0, Math.min(time, sentence.end - 0.02));
        } else {
            sentence.end = Math.min(this.duration || time, Math.max(time, sentence.start + 0.02));
        }
        this.drawWaveform();
        this.updateSelectionTime();
    }

    onPointerUp(event) {
        if (!this.isDragging) return;
        this.isDragging = false;
        this.dragType = null;
        this.dragPointerId = null;
        const sentence = this.current();
        if (sentence) {
            sentence.start = Math.round(sentence.start * 1000) / 1000;
            sentence.end = Math.round(sentence.end * 1000) / 1000;
            sentence.words = buildUniformWords(sentence);
        }
        this.renderSentenceList();
        this.drawWaveform();
        this.scheduleSave();
        if (event && event.pointerId !== undefined) {
            try { document.getElementById('waveform-canvas').releasePointerCapture(event.pointerId); } catch { /* ignore */ }
        }
    }

    /* ------------------------------------------------------------- sentence list */

    renderSentenceList() {
        const container = document.getElementById('sentence-list-editor');
        if (!container) return;
        container.innerHTML = '';

        if (this.sentences.length === 0) {
            container.innerHTML = '<p class="empty-state">No sentences yet. Import subtitles or paste a transcript to begin.</p>';
            return;
        }

        this.sentences.forEach((sentence, index) => {
            const item = document.createElement('div');
            item.className = 'sentence-item' + (index === this.currentSentenceIndex ? ' active' : '');

            const text = document.createElement('div');
            text.className = 'sentence-text';
            text.contentEditable = 'true';
            text.spellcheck = false;
            text.textContent = sentence.text;
            text.dataset.idx = String(index);

            const meta = document.createElement('div');
            meta.className = 'sentence-times';
            if (this.hasTiming(sentence)) {
                meta.textContent = `${formatClock(sentence.start)} → ${formatClock(sentence.end)}  (${(sentence.end - sentence.start).toFixed(2)}s)`;
            } else {
                meta.innerHTML = '<span class="timing-badge">Timing needed</span> tap to select, then play and press [ for in / ] for out';
            }

            item.appendChild(text);
            item.appendChild(meta);

            item.addEventListener('click', () => this.selectSentence(index));

            text.addEventListener('click', (event) => event.stopPropagation());
            text.addEventListener('focus', () => this.selectSentence(index));

            text.addEventListener('blur', () => {
                const value = text.textContent.replace(/\s+/g, ' ').trim();
                if (!value) {
                    text.textContent = sentence.text;
                    return;
                }
                if (value !== sentence.text) {
                    this.sentences[index].text = value;
                    this.sentences[index].words = buildUniformWords(this.sentences[index]);
                    this.scheduleSave();
                }
            });
            text.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    text.blur();
                }
                if (event.key === 'Escape') {
                    text.textContent = sentence.text;
                    text.blur();
                }
            });

            container.appendChild(item);
        });
    }

    updateSelectionTime() {
        const el = document.getElementById('editor-selection-time');
        if (!el) return;
        const sentence = this.current();
        if (!sentence) {
            el.textContent = 'No sentence selected';
            return;
        }
        el.textContent = this.hasTiming(sentence)
            ? `Selected ${this.currentSentenceIndex + 1} of ${this.sentences.length} · ${formatClock(sentence.start)} → ${formatClock(sentence.end)}`
            : `Selected ${this.currentSentenceIndex + 1} of ${this.sentences.length} · timing not set`;
    }

    scheduleSave() {
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => {
            this.saveNow().catch((err) => console.warn('Autosave failed:', err));
        }, 600);
    }

    async saveNow() {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        if (!this.videoId) return;
        if (this._deletedIds && this._deletedIds.size) {
            for (const id of this._deletedIds) {
                try { await deleteSentence(id); } catch (err) { console.warn('Could not delete a merged sentence:', err); }
            }
            this._deletedIds.clear();
        }
        if (!this.sentences.length) return;
        this.sentences = await saveSentences(this.sentences);
    }

    stopPlayback() {
        this.loopActive = false;
        this.stopAtEnd = false;
        if (this.video) this.video.pause();
        if (this._raf) {
            cancelAnimationFrame(this._raf);
            this._raf = null;
        }
    }
}

/* ------------------------------------------------------------------ helpers */

function computePeaksInline(buffer, buckets) {
    const samples = buffer.getChannelData(0);
    const size = Math.max(1, Math.floor(samples.length / buckets));
    const peaks = new Float32Array(buckets * 2);
    for (let bucket = 0; bucket < buckets; bucket++) {
        const start = bucket * size;
        const end = Math.min(samples.length, start + size);
        let min = 1;
        let max = -1;
        for (let i = start; i < end; i++) {
            if (samples[i] < min) min = samples[i];
            if (samples[i] > max) max = samples[i];
        }
        peaks[bucket * 2] = min;
        peaks[bucket * 2 + 1] = max;
    }
    return peaks;
}

function drawHandle(ctx, x, height, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, height - 14, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
}

function hexToRgba(color, alpha) {
    const value = (color || '').trim();
    if (value.startsWith('#')) {
        let hex = value.slice(1);
        if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
        const num = parseInt(hex, 16);
        if (Number.isNaN(num)) return `rgba(0,0,0,${alpha})`;
        return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
    }
    return value || `rgba(0,0,0,${alpha})`;
}

function niceTimeStep(duration) {
    if (duration <= 15) return 2;
    if (duration <= 60) return 10;
    if (duration <= 180) return 30;
    if (duration <= 600) return 60;
    return 120;
}

function formatClock(seconds) {
    if (!Number.isFinite(seconds)) return '—';
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${secs.toFixed(2).padStart(5, '0')}`;
}

/**
 * Build sentence records from a stored transcript.
 * SRT/VTT cues keep their exact timings; pasted text has no timings yet.
 */
function buildSentencesFromTranscript(transcript) {
    if (!transcript) return [];
    if (Array.isArray(transcript.segments) && transcript.segments.length) {
        return transcript.segments.map((segment) => ({
            videoId: transcript.videoId,
            start: segment.start,
            end: segment.end,
            text: segment.text,
            words: segment.words || []
        }));
    }
    const text = transcript.text || transcript.content || '';
    return splitIntoSentences(text).map((sentence) => ({
        videoId: transcript.videoId,
        start: null,
        end: null,
        text: sentence,
        words: []
    }));
}

/** Split plain text into sentences without inventing timings. */
function splitIntoSentences(text) {
    const normalised = (text || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
    if (!normalised) return [];
    const rough = normalised
        .split(/\n{2,}|(?<=[.!?…])\s+(?=[A-Z0-9"'“”‘’(\[])/u)
        .map((part) => part.replace(/^\s*[-–—•]\s*/, '').trim())
        .filter(Boolean);

    const out = [];
    for (const part of rough) {
        if (part.length > 240) {
            // Very long unpunctuated text: break on commas/semicolons near the middle.
            const pieces = part.split(/(?<=[,;:])\s+/u);
            let buffer = '';
            for (const piece of pieces) {
                if ((buffer + ' ' + piece).trim().length > 200 && buffer) {
                    out.push(buffer.trim());
                    buffer = piece;
                } else {
                    buffer = (buffer + ' ' + piece).trim();
                }
            }
            if (buffer) out.push(buffer);
        } else {
            out.push(part);
        }
    }
    return out;
}

/**
 * Word timings are only generated when they are honest: if a transcript has no
 * word-level data we do not fabricate per-word timings. Sentence highlighting
 * is used instead (words array stays empty).
 */
function buildUniformWords() {
    return [];
}

const sentenceEditor = new SentenceEditor();
