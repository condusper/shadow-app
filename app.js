/**
 * Shadow — main application logic
 *
 * Import flow (file → transcript → sentences), library, shadowing playback,
 * recording, review with measurements, and progress tracking.
 */

const state = {
    currentVideo: null,
    sentences: [],
    sentenceIndex: 0,
    mode: 'sequential',
    playbackRate: 1,
    hideTranscript: false,
    hideVideo: false,
    pipStream: null,
    recording: false,
    pendingShadow: false,
    recordTimer: null,
    stopAt: null,
    onSentenceEnd: null,
    loopActive: false,
    loopRemaining: 0,
    loopTotal: 0,
    recordingBlob: null,
    recordingMeta: null,
    attemptId: null,
    rating: 0,
    freePlayback: false,
    import: {
        file: null,
        video: null,
        transcript: null,
        metadata: null
    },
    mediaBuffer: null,
    mediaBufferVideoId: null
};

const ACCEPTED_EXTENSIONS = ['mp4', 'mov', 'webm', 'm4v', 'mp3', 'm4a', 'wav', 'ogg', 'oga', 'aac', 'flac'];

document.addEventListener('DOMContentLoaded', initApp);

async function initApp() {
    try {
        await initDB();
    } catch (err) {
        showToast('Storage is unavailable in this browser. Private mode may block it.', 6000);
        console.error(err);
        return;
    }

    setupNavigation();
    setupImportFlow();
    setupShadowing();
    setupReview();
    setupLoopSheet();
    setupPermissions();
    setupKeyboard();
    updateRecordingFormatStatus();

    const echo = await getSetting('echoCancellation');
    document.getElementById('chk-echo-cancel').checked = !!echo;

    const latency = await getSetting('latencyOffsetMs');
    if (Number.isFinite(latency) && latency > 0) {
        audioProcessor.latencyOffsetMs = latency;
        document.getElementById('calibration-result').textContent = `Saved latency: ${latency} ms (round-trip estimate).`;
    }

    await refreshLibrary();
    await updateProgressDisplay();

    window.addEventListener('error', (event) => {
        console.error(event.error || event.message);
    });
    window.addEventListener('unhandledrejection', (event) => {
        console.error(event.reason);
        showToast('Something went wrong: ' + (event.reason && event.reason.message ? event.reason.message : 'unknown error'));
    });
}

/* --------------------------------------------------------------- utilities */

let toastTimer = null;
function showToast(message, duration = 3200) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.hidden = false;
    toast.classList.add('visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => { toast.hidden = true; }, 200);
    }, duration);
}

function showScreen(name) {
    if (name !== 'editor') {
        if (typeof sentenceEditor !== 'undefined') sentenceEditor.stopPlayback();
    }
    if (name !== 'shadow') {
        stopShadowPlayback();
        if (state.recording) {
            audioProcessor.stopRecording().catch(() => {});
            state.recording = false;
            setRecordingUI(false);
        }
    }
    if (name !== 'shadow' && state.pipStream) {
        state.pipStream.getTracks().forEach((track) => track.stop());
        state.pipStream = null;
        const pip = document.getElementById('pip-camera');
        pip.hidden = true;
        pip.srcObject = null;
    }

    document.querySelectorAll('.screen').forEach((screen) => screen.classList.remove('active'));
    const target = document.getElementById('screen-' + name);
    if (target) target.classList.add('active');

    // Each screen starts at the top; otherwise a scrolled library leaves the
    // next screen mid-document.
    if (name === 'library' || name === 'progress' || name === 'shadow' || name === 'editor') {
        window.scrollTo(0, 0);
    }

    document.querySelectorAll('.nav-btn').forEach((button) => {
        button.classList.toggle('active', button.dataset.screen === name);
    });
}

function hasTiming(sentence) {
    return !!sentence && Number.isFinite(sentence.start) && Number.isFinite(sentence.end) && sentence.end > sentence.start;
}

function todayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function addDays(date, days) {
    const copy = new Date(date);
    copy.setDate(copy.getDate() + days);
    return copy;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
}

function isAudioFile(file) {
    return (file.type || '').startsWith('audio/') || /\.(mp3|m4a|wav|ogg|oga|aac|flac)$/i.test(file.name || '');
}

/* ------------------------------------------------------------- navigation */

function setupNavigation() {
    document.querySelectorAll('.nav-btn').forEach((button) => {
        button.addEventListener('click', () => {
            const screen = button.dataset.screen;
            if (screen === 'library') {
                closeAllSheets();
                showScreen('library');
                refreshLibrary();
                updateProgressDisplay();
            } else if (screen === 'progress') {
                closeAllSheets();
                showScreen('progress');
                renderProgressScreen();
            }
        });
    });

    document.getElementById('btn-progress-back').addEventListener('click', () => {
        showScreen('library');
        refreshLibrary();
    });

    document.getElementById('btn-editor-back').addEventListener('click', async () => {
        try { await sentenceEditor.saveNow(); } catch { /* ignore */ }
        sentenceEditor.stopPlayback();
        showScreen('library');
        await refreshLibrary();
    });

    document.getElementById('btn-shadow-back').addEventListener('click', () => {
        stopShadowPlayback();
        stopShadowLoop(true);
        showScreen('library');
        refreshLibrary();
    });
}

function closeAllSheets() {
    document.querySelectorAll('.bottom-sheet').forEach((sheet) => sheet.classList.remove('active'));
    document.getElementById('review-panel').classList.remove('active');
    abPlayer.stop();
    const playButton = document.getElementById('btn-ab-play');
    if (playButton) playButton.textContent = 'Play';
}

/* ------------------------------------------------------------ import flow */

function setupImportFlow() {
    document.getElementById('btn-import').addEventListener('click', () => openImportSheet());

    document.getElementById('import-close').addEventListener('click', closeImportSheet);
    document.getElementById('import-sheet-backdrop').addEventListener('click', closeImportSheet);

    document.getElementById('btn-select-file').addEventListener('click', () => {
        document.getElementById('file-input').click();
    });

    document.getElementById('file-input').addEventListener('change', async (event) => {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        await selectImportFile(file);
    });

    document.getElementById('btn-import-srt').addEventListener('click', () => {
        document.getElementById('srt-input').click();
    });

    document.getElementById('srt-input').addEventListener('change', async (event) => {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        await importSubtitleFile(file);
    });

    document.getElementById('btn-paste-transcript').addEventListener('click', () => {
        const section = document.getElementById('transcript-paste-section');
        section.hidden = !section.hidden;
        if (!section.hidden) document.getElementById('transcript-paste-area').focus();
    });

    document.getElementById('btn-confirm-paste').addEventListener('click', () => {
        const text = document.getElementById('transcript-paste-area').value.trim();
        if (!text) {
            setTranscriptStatus('Paste some text first.', true);
            return;
        }
        const count = splitIntoSentences(text).length;
        state.import.transcript = {
            videoId: state.import.video ? state.import.video.id : null,
            type: 'paste',
            text,
            segments: []
        };
        setTranscriptStatus(`${count} sentences. Timings are not known yet — you will mark them in the editor.`);
    });

    document.getElementById('btn-auto-transcribe').addEventListener('click', () => {
        const note = document.getElementById('auto-transcribe-note');
        note.hidden = false;
        showToast('Auto-transcription is not included: no offline model ships with this build.', 5000);
    });

    document.getElementById('btn-import-next').addEventListener('click', onImportNext);
    document.getElementById('btn-import-back').addEventListener('click', () => {
        const step = currentImportStep();
        if (step > 1) showImportStep(step - 1);
    });

    document.getElementById('btn-open-editor').addEventListener('click', openEditorFromImport);

    // If an existing video has no sentences, we reopen the import flow at step 2.
    document.getElementById('btn-open-editor-from-warning').addEventListener('click', () => {
        if (state.currentVideo) openEditorFor(state.currentVideo.id);
    });
}

function openImportSheet(video = null) {
    resetImportState();
    if (video) {
        state.import.video = video;
        document.getElementById('import-sheet-title').textContent = 'Add transcript';
        showImportStep(2);
        document.getElementById('file-error').textContent = '';
        document.getElementById('selected-file-info').hidden = false;
        document.getElementById('selected-file-info').textContent = `${video.title} · ${formatDuration(video.duration || 0)}`;
    } else {
        document.getElementById('import-sheet-title').textContent = 'Import';
        showImportStep(1);
    }
    document.getElementById('import-sheet').classList.add('active');
}

function closeImportSheet() {
    document.getElementById('import-sheet').classList.remove('active');
    if (state.import.video) refreshLibrary();
    resetImportState();
}

function resetImportState() {
    state.import = { file: null, video: null, transcript: null, metadata: null };
    document.getElementById('file-input').value = '';
    document.getElementById('srt-input').value = '';
    document.getElementById('selected-file-info').hidden = true;
    document.getElementById('selected-file-info').textContent = '';
    document.getElementById('file-error').textContent = '';
    document.getElementById('transcript-status').textContent = '';
    document.getElementById('transcript-paste-section').hidden = true;
    document.getElementById('transcript-paste-area').value = '';
    document.getElementById('auto-transcribe-note').hidden = true;
    document.getElementById('import-timing-note').textContent = '';
}

function showImportStep(step) {
    document.querySelectorAll('.import-step').forEach((section, index) => {
        section.classList.toggle('active', index === step - 1);
    });
    document.querySelectorAll('.step-dot').forEach((dot, index) => {
        dot.classList.toggle('active', index === step - 1);
    });
    document.getElementById('btn-import-back').hidden = step === 1;
    document.getElementById('btn-import-next').textContent = step === 3 ? 'Done' : 'Next';
}

function currentImportStep() {
    let step = 1;
    document.querySelectorAll('.import-step').forEach((section, index) => {
        if (section.classList.contains('active')) step = index + 1;
    });
    return step;
}

async function selectImportFile(file) {
    const extension = (file.name.split('.').pop() || '').toLowerCase();
    const typeOk = (file.type || '').startsWith('video/') || (file.type || '').startsWith('audio/') || ACCEPTED_EXTENSIONS.includes(extension);
    if (!typeOk) {
        document.getElementById('file-error').textContent = 'Please choose a video or audio file (mp4, mov, webm, m4v, mp3, m4a, wav).';
        return;
    }

    document.getElementById('file-error').textContent = '';
    state.import.file = file;
    const info = document.getElementById('selected-file-info');
    info.hidden = false;
    info.textContent = `${file.name} · ${formatBytes(file.size)} · reading duration…`;

    try {
        const metadata = await readMediaMetadata(file);
        state.import.metadata = metadata;
        const durationText = metadata.duration ? formatDuration(metadata.duration) : 'duration unknown';
        info.textContent = `${file.name} · ${formatBytes(file.size)} · ${durationText}`;
    } catch (err) {
        state.import.metadata = { duration: 0, thumbnail: null };
        info.textContent = `${file.name} · ${formatBytes(file.size)}`;
        showToast('Could not read the media metadata. The file may still import, but seek previews may not work.', 5000);
    }
}

function setTranscriptStatus(message, isError = false) {
    const el = document.getElementById('transcript-status');
    el.textContent = message;
    el.classList.toggle('error-text', !!isError);
}

async function importSubtitleFile(file) {
    if (!/\.(srt|vtt)$/i.test(file.name)) {
        setTranscriptStatus('Choose a .srt or .vtt subtitle file.', true);
        return;
    }
    try {
        const text = await file.text();
        const segments = parseSubtitles(text, file.name);
        if (!segments.length) {
            setTranscriptStatus('No subtitle cues were found in that file.', true);
            return;
        }
        state.import.transcript = {
            videoId: state.import.video ? state.import.video.id : null,
            type: file.name.toLowerCase().endsWith('.vtt') ? 'vtt' : 'srt',
            text: segments.map((segment) => segment.text).join('\n'),
            segments
        };
        setTranscriptStatus(`${segments.length} cues imported with exact timings. They become ${segments.length} editable sentences.`);
    } catch (err) {
        setTranscriptStatus('Could not read that subtitle file: ' + err.message, true);
    }
}

async function onImportNext() {
    const step = currentImportStep();
    const nextButton = document.getElementById('btn-import-next');

    if (step === 1) {
        if (!state.import.file) {
            document.getElementById('file-error').textContent = 'Choose a file first.';
            return;
        }
        nextButton.disabled = true;
        try {
            const file = state.import.file;
            const metadata = state.import.metadata || { duration: 0, thumbnail: null };
            const video = {
                title: file.name.replace(/\.[^/.]+$/, ''),
                filename: file.name,
                mimeType: file.type || '',
                size: file.size,
                blob: file,
                duration: metadata.duration || 0,
                thumbnail: metadata.thumbnail || null,
                createdAt: Date.now()
            };
            const id = await addVideo(video);
            state.import.video = { ...video, id };
            document.getElementById('file-error').textContent = '';
            showImportStep(2);
        } catch (err) {
            const quota = err && (err.name === 'QuotaExceededError' || String(err.message).includes('quota'));
            document.getElementById('file-error').textContent = quota
                ? 'This device is out of storage for that file. Free some space or choose a smaller file.'
                : 'Could not save the file locally: ' + (err && err.message ? err.message : 'unknown error');
        } finally {
            nextButton.disabled = false;
        }
        return;
    }

    if (step === 2) {
        if (!state.import.video) {
            setTranscriptStatus('The media file was not saved. Start the import again.', true);
            return;
        }
        if (!state.import.transcript) {
            setTranscriptStatus('Choose subtitles or paste a transcript to continue.', true);
            return;
        }

        nextButton.disabled = true;
        try {
            const transcript = {
                ...state.import.transcript,
                videoId: state.import.video.id,
                createdAt: Date.now()
            };
            await saveTranscript(transcript);

            const sentences = buildSentencesFromTranscript(transcript);
            const saved = await replaceSentences(state.import.video.id, sentences);
            state.import.transcript = transcript;
            state.import.sentenceCount = saved.length;
            state.import.timedCount = saved.filter(hasTiming).length;

            if (!saved.length) {
                setTranscriptStatus('That transcript produced no sentences. Add punctuation or a different transcript.', true);
                return;
            }

            const summary = document.getElementById('import-summary');
            summary.textContent = `${saved.length} sentence${saved.length === 1 ? '' : 's'} ready.`;
            const timingNote = document.getElementById('import-timing-note');
            if (state.import.timedCount === saved.length) {
                timingNote.textContent = 'All sentences have exact timings from the subtitles. Review them once in the editor.';
            } else {
                timingNote.textContent = `${saved.length - state.import.timedCount} sentence(s) still need in/out points. In the editor, select a sentence, play to the right spot, then press [ for in and ] for out.`;
            }
            showImportStep(3);
        } catch (err) {
            setTranscriptStatus('Could not save the sentences: ' + (err.message || 'unknown error'), true);
        } finally {
            nextButton.disabled = false;
        }
        return;
    }

    if (step === 3) {
        await openEditorFromImport();
    }
}

async function openEditorFromImport() {
    if (!state.import.video) return;
    const videoId = state.import.video.id;
    document.getElementById('import-sheet').classList.remove('active');
    resetImportState();
    await openEditorFor(videoId);
}

async function openEditorFor(videoId) {
    showScreen('editor');
    await sentenceEditor.init(videoId);
}

/* ----------------------------------------------------------- media metadata */

function readMediaMetadata(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const media = document.createElement('video');
        media.preload = 'metadata';
        media.muted = true;
        media.playsInline = true;
        let settled = false;

        const cleanup = () => {
            media.removeAttribute('src');
            media.load();
            URL.revokeObjectURL(url);
        };

        const finish = (value) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
        };

        const fail = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };

        const timeout = setTimeout(() => finish({ duration: 0, thumbnail: null }), 12000);

        media.addEventListener('loadedmetadata', async () => {
            clearTimeout(timeout);
            const duration = Number.isFinite(media.duration) ? media.duration : 0;
            let thumbnail = null;

            if (media.videoWidth > 0 && duration > 0) {
                try {
                    media.currentTime = Math.min(1, duration * 0.1);
                    await new Promise((res, rej) => {
                        const timer = setTimeout(res, 3000);
                        media.addEventListener('seeked', () => { clearTimeout(timer); res(); }, { once: true });
                        media.addEventListener('error', () => { clearTimeout(timer); rej(new Error('seek failed')); }, { once: true });
                    });
                    const canvas = document.createElement('canvas');
                    const width = 480;
                    const height = Math.round(width * (media.videoHeight / media.videoWidth)) || 270;
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(media, 0, 0, width, height);
                    thumbnail = canvas.toDataURL('image/jpeg', 0.72);
                } catch {
                    thumbnail = null;
                }
            }

            finish({ duration, thumbnail });
        }, { once: true });

        media.addEventListener('error', () => fail(new Error('This browser could not read that media file.')), { once: true });
        media.src = url;
    });
}

function formatBytes(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/* ---------------------------------------------------------------- library */

async function refreshLibrary() {
    const list = document.getElementById('library-list');
    const videos = await getAllVideos();
    const attempts = await getAllAttempts();

    const practiced = new Map();
    const attemptCounts = new Map();
    for (const attempt of attempts) {
        if (!attempt.videoId) continue;
        if (!practiced.has(attempt.videoId)) practiced.set(attempt.videoId, new Set());
        practiced.get(attempt.videoId).add(attempt.sentenceId);
        attemptCounts.set(attempt.videoId, (attemptCounts.get(attempt.videoId) || 0) + 1);
    }

    list.innerHTML = '';
    if (!videos.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.innerHTML = '<p>Import a video or audio file to start shadowing.</p><p class="hint-text">Everything stays on this device.</p>';
        list.appendChild(empty);
        return;
    }

    for (const video of videos) {
        const sentences = await getSentences(video.id);
        const displayTitle = video.title || video.filename || 'Untitled';
        const item = document.createElement('div');
        item.className = 'library-item';

        const card = document.createElement('button');
        card.className = 'library-card';
        card.type = 'button';

        const thumb = document.createElement('div');
        thumb.className = 'library-thumb-wrap';
        if (video.thumbnail) {
            const img = document.createElement('img');
            img.className = 'library-thumb';
            img.src = video.thumbnail;
            img.alt = '';
            img.loading = 'lazy';
            thumb.appendChild(img);
        } else {
            thumb.classList.add('library-thumb-fallback');
            thumb.innerHTML = isAudioFile({ type: video.mimeType, name: video.filename })
                ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>'
                : '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
        }
        card.appendChild(thumb);

        const info = document.createElement('div');
        info.className = 'library-info';
        const title = document.createElement('div');
        title.className = 'library-title';
        title.textContent = displayTitle;
        const meta = document.createElement('div');
        meta.className = 'library-meta';
        const total = sentences.length;
        const done = practiced.has(video.id) ? practiced.get(video.id).size : 0;
        const isLegacy = !(video.blob instanceof Blob);
        meta.textContent = isLegacy
            ? 'File missing — re-import'
            : `${formatDuration(video.duration || 0)} · ${total ? `${done}/${total} practiced` : 'no sentences yet'}`;
        info.appendChild(title);
        info.appendChild(meta);
        card.appendChild(info);

        if (!isLegacy) {
            const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            ring.setAttribute('viewBox', '0 0 36 36');
            ring.setAttribute('class', 'progress-ring');
            ring.setAttribute('aria-hidden', 'true');
            const pct = total ? Math.round(done / total * 100) : 0;
            ring.innerHTML = `
                <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="currentColor" stroke-opacity="0.12" stroke-width="3"></path>
                <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="var(--accent)" stroke-width="3" stroke-dasharray="${pct}, 100" stroke-linecap="round"></path>
            `;
            card.appendChild(ring);
        }

        card.addEventListener('click', () => {
            if (!(video.blob instanceof Blob)) {
                showToast('This library item was imported by an older build; its file is gone. Use the trash button to remove it.', 5000);
                return;
            }
            openShadowFor(video.id);
        });

        const remove = document.createElement('button');
        remove.className = 'library-delete';
        remove.type = 'button';
        remove.title = 'Delete';
        remove.setAttribute('aria-label', `Delete “${displayTitle}” from library`);
        remove.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>';
        remove.addEventListener('click', (event) => {
            event.stopPropagation();
            deleteLibraryVideo(video, attemptCounts.get(video.id) || 0);
        });

        item.appendChild(card);
        item.appendChild(remove);
        list.appendChild(item);
    }
}

async function deleteLibraryVideo(video, attemptCount) {
    const displayTitle = video.title || video.filename || 'this item';
    const removes = ['the media file', 'its transcript', 'its sentences'];
    if (attemptCount > 0) {
        removes.push(`${attemptCount} recording${attemptCount === 1 ? '' : 's'}`);
    }
    const removeList = removes.length > 1
        ? `${removes.slice(0, -1).join(', ')} and ${removes[removes.length - 1]}`
        : removes[0];
    const confirmed = window.confirm(
        `Delete “${displayTitle}”?\n\n` +
        `This permanently removes ${removeList} from this device. It cannot be undone.\n\n` +
        'Your practice totals in Progress are kept as history.'
    );
    if (!confirmed) return;

    try {
        await deleteVideo(video.id);
    } catch (error) {
        console.error('Failed to delete video', error);
        showToast('Could not delete that item. Please try again.');
        return;
    }

    if (state.currentVideo && state.currentVideo.id === video.id) {
        stopShadowPlayback();
        state.currentVideo = null;
        state.sentences = [];
        state.sentenceIndex = 0;
        state.mediaBuffer = null;
        state.mediaBufferVideoId = null;
        const shadowVideo = document.getElementById('shadow-video');
        if (shadowVideo) {
            shadowVideo.removeAttribute('src');
            shadowVideo.load();
        }
    }
    if (state.import.video && state.import.video.id === video.id) {
        state.import.video = null;
    }

    await refreshLibrary();
    await updateProgressDisplay();
    showToast(`Deleted “${displayTitle}”.`);
}

/* --------------------------------------------------------------- shadowing */

function setupShadowing() {
    document.getElementById('btn-prev-sentence').addEventListener('click', () => navigateSentence(-1, true));
    document.getElementById('btn-next-sentence').addEventListener('click', () => navigateSentence(1, true));

    document.getElementById('btn-play-pause-shadow').addEventListener('click', () => {
        const video = document.getElementById('shadow-video');
        if (video.paused) {
            playCurrentSentence();
        } else {
            video.pause();
            state.stopAt = null;
            state.onSentenceEnd = null;
        }
    });

    document.getElementById('btn-repeat-sentence').addEventListener('click', () => {
        playCurrentSentence();
    });

    document.getElementById('btn-shadow-options').addEventListener('click', () => {
        const panel = document.getElementById('shadow-options-panel');
        const button = document.getElementById('btn-shadow-options');
        const open = panel.hidden;
        panel.hidden = !open;
        button.setAttribute('aria-expanded', String(open));
        requestAnimationFrame(syncShadowControlPadding);
    });

    document.getElementById('btn-loop-shadow').addEventListener('click', () => {
        if (state.recording) {
            showToast('Stop the recording before starting a loop.');
            return;
        }
        if (state.loopActive) {
            stopShadowLoop(true);
            showToast('Loop stopped');
            return;
        }
        if (!hasTiming(currentSentence())) {
            showToast('Set this sentence\'s timing in the editor before looping.');
            return;
        }
        document.getElementById('loop-range').value = '3';
        document.getElementById('loop-value').textContent = '3';
        document.getElementById('btn-stop-loop').hidden = true;
        document.getElementById('btn-start-loop').hidden = false;
        document.getElementById('loop-sheet').classList.add('active');
    });

    document.querySelectorAll('#speed-segmented .seg-btn').forEach((button) => {
        button.addEventListener('click', () => {
            document.querySelectorAll('#speed-segmented .seg-btn').forEach((b) => b.classList.remove('active'));
            button.classList.add('active');
            state.playbackRate = parseFloat(button.dataset.speed);
            const video = document.getElementById('shadow-video');
            video.playbackRate = state.playbackRate;
            video.preservesPitch = true;
        });
    });

    document.querySelectorAll('#shadow-mode-segmented .seg-btn').forEach((button) => {
        button.addEventListener('click', () => {
            document.querySelectorAll('#shadow-mode-segmented .seg-btn').forEach((b) => b.classList.remove('active'));
            button.classList.add('active');
            state.mode = button.dataset.mode;
            document.getElementById('overlap-tip').hidden = state.mode !== 'overlap';
            saveSetting('shadowMode', state.mode).catch(() => {});
            requestAnimationFrame(syncShadowControlPadding);
        });
    });

    document.getElementById('btn-shadow-record').addEventListener('click', toggleShadowRecording);

    document.getElementById('btn-toggle-transcript').addEventListener('click', () => {
        state.hideTranscript = !state.hideTranscript;
        document.getElementById('transcript-display').hidden = state.hideTranscript;
        document.getElementById('btn-toggle-transcript').textContent = state.hideTranscript ? 'Show transcript' : 'Hide transcript';
    });

    document.getElementById('btn-toggle-video').addEventListener('click', () => {
        state.hideVideo = !state.hideVideo;
        const video = document.getElementById('shadow-video');
        video.hidden = state.hideVideo;
        document.getElementById('video-placeholder').hidden = !state.hideVideo;
        document.getElementById('btn-toggle-video').textContent = state.hideVideo ? 'Show video' : 'Audio only';
        if (state.hideVideo) document.getElementById('pip-camera').hidden = true;
    });

    document.getElementById('btn-toggle-pip').addEventListener('click', toggleCameraPip);

    document.getElementById('btn-shadow-settings').addEventListener('click', () => {
        document.getElementById('perm-sheet').classList.add('active');
    });

    const video = document.getElementById('shadow-video');
    video.addEventListener('play', () => {
        setPlayIcon(true);
        setVideoPlayIcon(true);
        startVideoUiTicker();
        armFrameWatcher();
        if (!state.freePlayback && state.stopAt == null) {
            const sentence = currentSentence();
            if (hasTiming(sentence)) state.stopAt = sentence.end;
        }
    });
    video.addEventListener('pause', () => {
        setPlayIcon(false);
        setVideoPlayIcon(false);
        stopVideoUiTicker();
        updateVideoTimeUI();
    });
    video.addEventListener('timeupdate', () => {
        if (state.freePlayback) syncSentenceToTime(video.currentTime);
        updateHighlightFromPlayback();
    });
    video.addEventListener('loadedmetadata', updateVideoTimeUI);
    video.addEventListener('durationchange', updateVideoTimeUI);
    video.addEventListener('volumechange', updateMuteButton);

    document.getElementById('btn-video-play').addEventListener('click', toggleVideoPlayback);
    document.getElementById('btn-video-mute').addEventListener('click', toggleVideoMute);
    document.getElementById('btn-video-fullscreen').addEventListener('click', toggleVideoFullscreen);

    const seek = document.getElementById('video-seek');
    seek.addEventListener('pointerdown', beginVideoSeek);
    seek.addEventListener('pointerup', finishVideoSeek);
    seek.addEventListener('pointercancel', finishVideoSeek);
    seek.addEventListener('input', handleVideoSeekInput);
    seek.addEventListener('change', finishVideoSeek);
    seek.addEventListener('keyup', finishVideoSeek);
    seek.addEventListener('blur', finishVideoSeek);
    document.addEventListener('fullscreenchange', updateFullscreenButton);
    updateMuteButton();

    // The control bar is fixed, so reserve exactly as much room as it needs.
    // Its height changes when controls wrap or the overlap tip appears.
    window.addEventListener('resize', syncShadowControlPadding);
    if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(() => syncShadowControlPadding());
        observer.observe(document.querySelector('.shadow-control-bar'));
    }
}

function syncShadowControlPadding() {
    const screen = document.getElementById('screen-shadow');
    if (!screen || !screen.classList.contains('active')) return;
    const main = document.querySelector('.shadow-main');
    const bar = document.querySelector('.shadow-control-bar');
    const nav = document.querySelector('.bottom-nav');
    if (!main || !bar) return;
    const navHeight = nav ? nav.getBoundingClientRect().height : 0;
    const padding = Math.ceil(bar.getBoundingClientRect().height + navHeight + 20);
    main.style.paddingBottom = `${Math.max(240, padding)}px`;
}

async function openShadowFor(videoId) {
    const video = await getVideo(videoId);
    if (!video) {
        showToast('That file is no longer in local storage.');
        return;
    }
    const sentences = await getSentences(videoId);
    if (!sentences.length) {
        showToast('No sentences yet. Add subtitles or paste a transcript first.');
        openImportSheet(video);
        return;
    }
    state.currentVideo = video;
    state.sentences = sentences;
    const firstTimed = sentences.findIndex(hasTiming);
    state.sentenceIndex = firstTimed >= 0 ? firstTimed : 0;
    showScreen('shadow');
    await initShadowing();
}

function currentSentence() {
    return state.sentences[state.sentenceIndex] || null;
}

async function initShadowing() {
    const video = document.getElementById('shadow-video');
    video.src = getVideoURL(state.currentVideo);
    video.playbackRate = state.playbackRate;
    video.preservesPitch = true;

    const mode = await getSetting('shadowMode');
    if (mode === 'overlap' || mode === 'sequential') {
        state.mode = mode;
        document.querySelectorAll('#shadow-mode-segmented .seg-btn').forEach((button) => {
            button.classList.toggle('active', button.dataset.mode === mode);
        });
        document.getElementById('overlap-tip').hidden = mode !== 'overlap';
    }

    document.getElementById('shadow-title').textContent = state.currentVideo.title || 'Shadow';
    const unset = state.sentences.filter((sentence) => !hasTiming(sentence)).length;
    document.getElementById('shadow-warning').hidden = unset === 0;
    if (unset) {
        document.getElementById('shadow-warning-text').textContent =
            `${unset} sentence${unset === 1 ? '' : 's'} still need timings.`;
    }

    renderTranscript();
    renderSeekStrip();
    updateSentenceCounter();
    updateShadowStatus('');
    setPlayIcon(false);
    setVideoPlayIcon(false);
    updateVideoTimeUI();
    updateMuteButton();
    state.freePlayback = false;
    state.stopAt = null;
    state.onSentenceEnd = null;
    requestAnimationFrame(syncShadowControlPadding);
}

function renderTranscript() {
    const container = document.getElementById('transcript-text');
    container.innerHTML = '';
    const sentence = currentSentence();
    if (!sentence) {
        container.textContent = 'No sentence selected.';
        return;
    }

    state.sentences.forEach((item, index) => {
        const span = document.createElement('span');
        span.className = 'transcript-sentence';
        span.dataset.index = String(index);
        if (index === state.sentenceIndex) span.classList.add('active');
        else span.classList.add('dimmed');

        if (Array.isArray(item.words) && item.words.length) {
            item.words.forEach((word, wordIndex) => {
                const wordSpan = document.createElement('span');
                wordSpan.className = 'transcript-word';
                wordSpan.dataset.wordIndex = String(wordIndex);
                wordSpan.textContent = word.word || word.text || '';
                span.appendChild(wordSpan);
                span.appendChild(document.createTextNode(' '));
            });
        } else {
            span.textContent = item.text + ' ';
        }

        span.addEventListener('click', () => {
            if (index === state.sentenceIndex) {
                playCurrentSentence();
            } else {
                navigateSentence(index - state.sentenceIndex, true);
            }
        });
        container.appendChild(span);
    });
}

function renderSeekStrip() {
    const strip = document.getElementById('sentence-seek-strip');
    strip.innerHTML = '';
    state.sentences.forEach((sentence, index) => {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'sentence-seek-dot' + (index === state.sentenceIndex ? ' active' : '');
        if (!hasTiming(sentence)) dot.classList.add('untimed');
        dot.setAttribute('aria-label', `Sentence ${index + 1}${hasTiming(sentence) ? '' : ' (needs timing)'}`);
        dot.title = `Sentence ${index + 1}`;
        dot.addEventListener('click', () => navigateSentence(index - state.sentenceIndex, true));
        strip.appendChild(dot);
    });
}

function updateSentenceCounter() {
    document.getElementById('shadow-sentence-counter').textContent =
        state.sentences.length ? `Sentence ${state.sentenceIndex + 1} of ${state.sentences.length}` : 'No sentences';
}

function updateShadowStatus(text) {
    document.getElementById('shadow-record-status').textContent = text || '';
}

function setPlayIcon(isPlaying) {
    const icon = document.getElementById('shadow-play-icon');
    if (!icon) return;
    icon.innerHTML = isPlaying
        ? '<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>'
        : '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
    document.getElementById('btn-play-pause-shadow').setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
}

/* ------------------------------------------------------------ video controls */

let videoUiFrame = null;
let videoSeekActive = false;
let videoSeekWasPlaying = false;

function setVideoPlayIcon(isPlaying) {
    const button = document.getElementById('btn-video-play');
    if (!button) return;
    button.innerHTML = isPlaying
        ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>'
        : '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
    button.setAttribute('aria-label', isPlaying ? 'Pause video' : 'Play video');
}

function formatVideoClock(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function updateVideoTimeUI() {
    const video = document.getElementById('shadow-video');
    const seek = document.getElementById('video-seek');
    if (!video || !seek) return;
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const current = Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0;
    seek.max = String(duration);
    if (!videoSeekActive) {
        seek.value = String(duration > 0 ? Math.min(current, duration) : 0);
    }
    const pct = duration > 0 ? Math.min(100, Math.max(0, (current / duration) * 100)) : 0;
    seek.style.setProperty('--seek-progress', pct.toFixed(2) + '%');
    document.getElementById('video-current-time').textContent = formatVideoClock(current);
    document.getElementById('video-duration').textContent = formatVideoClock(duration);
}

function startVideoUiTicker() {
    stopVideoUiTicker();
    const tick = () => {
        videoUiFrame = null;
        const video = document.getElementById('shadow-video');
        if (!video || video.paused) return;
        if (state.freePlayback) syncSentenceToTime(video.currentTime);
        updateVideoTimeUI();
        videoUiFrame = requestAnimationFrame(tick);
    };
    videoUiFrame = requestAnimationFrame(tick);
}

function stopVideoUiTicker() {
    if (videoUiFrame) {
        cancelAnimationFrame(videoUiFrame);
        videoUiFrame = null;
    }
}

/** Move the active sentence to whichever timed sentence contains `time`. */
function syncSentenceToTime(time) {
    const index = state.sentences.findIndex((sentence) =>
        hasTiming(sentence) && time >= sentence.start && time < sentence.end);
    if (index >= 0 && index !== state.sentenceIndex) {
        state.sentenceIndex = index;
        renderTranscript();
        renderSeekStrip();
        updateSentenceCounter();
    }
    updateWordHighlight(time);
}

function toggleVideoPlayback() {
    const video = document.getElementById('shadow-video');
    if (!video) return;
    if (state.recording) {
        showToast('Stop the recording before using video playback.');
        return;
    }
    if (!video.paused) {
        video.pause();
        state.stopAt = null;
        state.onSentenceEnd = null;
        return;
    }
    startFreePlayback();
}

function startFreePlayback() {
    const video = document.getElementById('shadow-video');
    if (!video) return;
    if (state.recording) {
        showToast('Stop the recording before using video playback.');
        return;
    }
    if (state.loopActive) stopShadowLoop(true);
    state.freePlayback = true;
    state.stopAt = null;
    state.onSentenceEnd = null;

    let restarted = false;
    if (video.ended || (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime >= video.duration - 0.05)) {
        video.currentTime = 0;
        restarted = true;
    }
    if (restarted) {
        const firstTimed = state.sentences.findIndex(hasTiming);
        if (firstTimed >= 0) {
            state.sentenceIndex = firstTimed;
            renderTranscript();
            renderSeekStrip();
            updateSentenceCounter();
        }
    }
    syncSentenceToTime(video.currentTime);
    video.playbackRate = state.playbackRate;
    video.preservesPitch = true;
    video.play().catch(() => showToast('Playback was blocked. Tap play again.'));
}

function toggleVideoMute() {
    const video = document.getElementById('shadow-video');
    if (!video) return;
    video.muted = !video.muted;
    updateMuteButton();
}

function updateMuteButton() {
    const video = document.getElementById('shadow-video');
    const button = document.getElementById('btn-video-mute');
    if (!video || !button) return;
    const muted = video.muted || video.volume === 0;
    button.innerHTML = muted
        ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>'
        : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>';
    button.setAttribute('aria-label', muted ? 'Unmute video' : 'Mute video');
    button.setAttribute('aria-pressed', muted ? 'true' : 'false');
}

function toggleVideoFullscreen() {
    const card = document.getElementById('shadow-video-card');
    const video = document.getElementById('shadow-video');
    if (!card || !video) return;
    if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
        return;
    }
    if (typeof card.requestFullscreen === 'function') {
        card.requestFullscreen().catch(() => showToast('Fullscreen is not available in this browser.'));
    } else if (typeof video.webkitEnterFullscreen === 'function') {
        video.webkitEnterFullscreen();
    } else {
        showToast('Fullscreen is not available in this browser.');
    }
}

function updateFullscreenButton() {
    const button = document.getElementById('btn-video-fullscreen');
    if (!button) return;
    const active = !!document.fullscreenElement;
    button.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen');
    button.innerHTML = active
        ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v3a2 2 0 0 1-2 2H3"></path><path d="M21 8h-3a2 2 0 0 1-2-2V3"></path><path d="M3 16h3a2 2 0 0 1 2 2v3"></path><path d="M16 21v-3a2 2 0 0 1 2-2h3"></path></svg>'
        : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M21 8V5a2 2 0 0 0-2-2h-3"></path><path d="M3 16v3a2 2 0 0 0 2 2h3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path></svg>';
}

function beginVideoSeek() {
    if (state.recording) return;
    const video = document.getElementById('shadow-video');
    if (!video) return;
    if (!videoSeekActive) {
        videoSeekWasPlaying = !video.paused;
        videoSeekActive = true;
        video.pause();
    }
    state.freePlayback = false;
    state.stopAt = null;
    state.onSentenceEnd = null;
}

function handleVideoSeekInput() {
    if (state.recording) return;
    if (!videoSeekActive) beginVideoSeek();
    const video = document.getElementById('shadow-video');
    const seek = document.getElementById('video-seek');
    if (!video || !seek) return;
    const rawTime = Number(seek.value);
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const time = Math.max(0, duration > 0 ? Math.min(rawTime, duration) : rawTime);
    if (!Number.isFinite(time)) return;
    video.currentTime = time;
    updateVideoTimeUI();
    syncSentenceToTime(time);
}

function finishVideoSeek() {
    if (state.recording) {
        videoSeekActive = false;
        videoSeekWasPlaying = false;
        return;
    }
    videoSeekActive = false;
    const shouldResume = videoSeekWasPlaying;
    videoSeekWasPlaying = false;
    updateVideoTimeUI();
    if (shouldResume) startFreePlayback();
}

function navigateSentence(delta, autoplay) {
    if (!state.sentences.length) return;
    if (state.recording) {
        showToast('Stop the recording before changing sentences.');
        return;
    }
    const next = Math.max(0, Math.min(state.sentences.length - 1, state.sentenceIndex + delta));
    state.sentenceIndex = next;
    state.freePlayback = false;
    const sentence = currentSentence();
    const video = document.getElementById('shadow-video');

    if (hasTiming(sentence)) {
        video.currentTime = sentence.start;
        state.stopAt = sentence.end;
    } else {
        state.stopAt = null;
        updateShadowStatus('This sentence needs timings — open the editor to mark them.');
    }
    renderTranscript();
    renderSeekStrip();
    updateSentenceCounter();
    updateHighlightFromPlayback();
    if (autoplay && hasTiming(sentence)) {
        video.play().catch(() => {});
    } else {
        video.pause();
    }
}

function playCurrentSentence() {
    const sentence = currentSentence();
    if (!sentence) return;
    if (!hasTiming(sentence)) {
        showToast('This sentence has no timing yet. Open the editor and mark in/out points.', 4200);
        return;
    }
    const video = document.getElementById('shadow-video');
    video.playbackRate = state.playbackRate;
    video.preservesPitch = true;
    state.freePlayback = false;
    video.currentTime = sentence.start;
    state.stopAt = sentence.end;
    state.onSentenceEnd = null;
    video.play().catch(() => showToast('Playback was blocked. Tap play again.'));
}

function stopShadowPlayback() {
    const video = document.getElementById('shadow-video');
    if (video) video.pause();
    state.freePlayback = false;
    state.stopAt = null;
    state.onSentenceEnd = null;
    state.pendingShadow = false;
    if (state.recordTimer) {
        clearTimeout(state.recordTimer);
        state.recordTimer = null;
    }
    setPlayIcon(false);
}

let frameWatcherArmed = false;
let frameWatchTimer = null;
let frameWatchToken = 0;

/**
 * Stop playback exactly at the sentence boundary.
 *
 * requestVideoFrameCallback is used when video frames exist, but it never
 * fires for audio-only media (and some browsers never call it at all), so a
 * 30 ms timer runs alongside it as a safety net. Whichever notices the
 * boundary first stops playback and fires the callback once.
 */
function armFrameWatcher() {
    const video = document.getElementById('shadow-video');
    if (!video || frameWatcherArmed) return;
    frameWatcherArmed = true;
    const token = ++frameWatchToken;

    const clearTimer = () => {
        if (frameWatchTimer) {
            clearInterval(frameWatchTimer);
            frameWatchTimer = null;
        }
    };

    const stopWatching = () => {
        if (token !== frameWatchToken) return;
        frameWatcherArmed = false;
        clearTimer();
    };

    const atBoundary = (mediaTime) => state.stopAt != null && mediaTime >= state.stopAt - 0.004;

    const finish = () => {
        if (token !== frameWatchToken) return;
        stopWatching();
        frameWatchToken++;
        video.pause();
        const callback = state.onSentenceEnd;
        state.onSentenceEnd = null;
        state.stopAt = null;
        if (callback) callback();
    };

    if (typeof video.requestVideoFrameCallback === 'function') {
        const onFrame = (now, metadata) => {
            if (token !== frameWatchToken) return;
            if (video.paused) {
                stopWatching();
                return;
            }
            const mediaTime = metadata && Number.isFinite(metadata.mediaTime) ? metadata.mediaTime : video.currentTime;
            if (atBoundary(mediaTime)) {
                finish();
                return;
            }
            video.requestVideoFrameCallback(onFrame);
        };
        video.requestVideoFrameCallback(onFrame);
    }

    const timerId = setInterval(() => {
        if (token !== frameWatchToken) {
            // A newer watcher owns the shared slot now; retire only this timer.
            clearInterval(timerId);
            if (frameWatchTimer === timerId) frameWatchTimer = null;
            return;
        }
        if (video.paused) {
            stopWatching();
            return;
        }
        if (atBoundary(video.currentTime)) finish();
    }, 30);
    frameWatchTimer = timerId;
}

function updateHighlightFromPlayback() {
    updateWordHighlight(document.getElementById('shadow-video').currentTime);
}

function updateWordHighlight(time) {
    const active = document.querySelector('#transcript-text .transcript-sentence.active');
    if (!active) return;
    const sentence = currentSentence();
    if (!sentence) return;

    const words = active.querySelectorAll('.transcript-word');
    if (!words.length) {
        return;
    }

    let activeFound = false;
    words.forEach((word, index) => {
        const timing = sentence.words[index];
        const isActive = !!timing && Number.isFinite(timing.start) && time >= timing.start && time < timing.end;
        word.classList.toggle('active', isActive);
        if (isActive) activeFound = true;
    });

    if (!activeFound) {
        // Between words: keep the last one lit so the eye has a place to rest.
        let lastIndex = -1;
        sentence.words.forEach((timing, index) => {
            if (Number.isFinite(timing.start) && time >= timing.start) lastIndex = index;
        });
        words.forEach((word, index) => word.classList.toggle('active', index === lastIndex));
    }
}

/* --------------------------------------------------------------- recording */

async function toggleShadowRecording() {
    if (state.recording) {
        await finishShadowRecording('manual');
        return;
    }

    // Sequential mode starts recording only after the sentence ends. A second
    // press before that point cancels the pending take.
    if (state.pendingShadow) {
        state.pendingShadow = false;
        stopShadowPlayback();
        setRecordingUI(false);
        updateShadowStatus('');
        showToast('Shadow cancelled');
        return;
    }

    const sentence = currentSentence();
    if (!hasTiming(sentence)) {
        showToast('Mark this sentence\'s in and out points in the editor first.', 4200);
        return;
    }
    if (!state.currentVideo) return;
    stopShadowLoop(false);
    state.freePlayback = false;
    const activeVideo = document.getElementById('shadow-video');
    if (activeVideo && !activeVideo.paused) activeVideo.pause();

    const button = document.getElementById('btn-shadow-record');
    button.disabled = true;
    try {
        await audioProcessor.requestMicrophone(document.getElementById('chk-echo-cancel').checked);
    } catch (err) {
        showToast(err.message, 6000);
        document.getElementById('perm-sheet').classList.add('active');
        button.disabled = false;
        return;
    } finally {
        button.disabled = false;
    }

    const video = document.getElementById('shadow-video');
    video.playbackRate = state.playbackRate;
    video.preservesPitch = true;

    try {
        if (state.mode === 'overlap') {
            await audioProcessor.startRecording();
            const context = await audioProcessor.initAudioContext();
            const recordedAt = audioProcessor.recordingStartContextTime;
            state.recording = true;
            setRecordingUI(true);
            showToast('Recording over the sentence — headphones strongly recommended.', 3800);
            video.currentTime = sentence.start;
            state.stopAt = sentence.end;
            state.onSentenceEnd = null;
            await video.play();
            state.overlapPlaybackOffsetMs = Math.max(0, (context.currentTime - recordedAt) * 1000);
            scheduleRecordingStop(Math.max(2500, ((sentence.end - sentence.start) / state.playbackRate) * 1000 + 800));
        } else {
            video.currentTime = sentence.start;
            state.stopAt = sentence.end;
            state.pendingShadow = true;
            state.onSentenceEnd = async () => {
                state.pendingShadow = false;
                try {
                    await audioProcessor.startRecording();
                    state.recording = true;
                    setRecordingUI(true);
                    updateShadowStatus('Recording your voice…');
                    scheduleRecordingStop(Math.max(2500, ((sentence.end - sentence.start) / state.playbackRate) * 1000 + 1500));
                } catch (err) {
                    showToast('Could not start recording: ' + err.message, 5000);
                }
            };
            await video.play();
            updateShadowStatus('Listen, then shadow…');
        }
        startRecordLevelIndicator();
    } catch (err) {
        showToast('Could not start: ' + (err.message || 'unknown error'), 5000);
        state.recording = false;
        setRecordingUI(false);
    }
}

function scheduleRecordingStop(delayMs) {
    if (state.recordTimer) clearTimeout(state.recordTimer);
    state.recordTimer = setTimeout(() => finishShadowRecording('timer'), Math.max(300, delayMs));
}

function setRecordingUI(isRecording) {
    const button = document.getElementById('btn-shadow-record');
    button.classList.toggle('recording', isRecording);
    button.querySelector('.shadow-record-text').textContent = isRecording ? 'Stop' : 'Shadow';
    button.setAttribute('aria-label', isRecording ? 'Stop recording' : 'Start shadowing');
    const videoPlay = document.getElementById('btn-video-play');
    const videoSeek = document.getElementById('video-seek');
    if (videoPlay) videoPlay.disabled = isRecording;
    if (videoSeek) videoSeek.disabled = isRecording;
    if (!isRecording) {
        stopRecordLevelIndicator();
        updateShadowStatus('');
    }
}

function startRecordLevelIndicator() {
    audioProcessor.onLevel = (level) => {
        const button = document.getElementById('btn-shadow-record');
        if (button) button.style.setProperty('--level', Math.min(1, level * 2).toFixed(2));
    };
}

function stopRecordLevelIndicator() {
    audioProcessor.onLevel = null;
    const button = document.getElementById('btn-shadow-record');
    if (button) button.style.removeProperty('--level');
}

async function finishShadowRecording(reason) {
    if (!state.recording) return;
    state.recording = false;
    if (state.recordTimer) {
        clearTimeout(state.recordTimer);
        state.recordTimer = null;
    }
    const video = document.getElementById('shadow-video');
    if (video) video.pause();
    state.stopAt = null;
    state.onSentenceEnd = null;
    setRecordingUI(false);
    updateShadowStatus('Saving…');

    const sentence = currentSentence();
    let result = null;
    try {
        result = await audioProcessor.stopRecording();
    } catch (err) {
        showToast('Could not save the recording: ' + err.message, 5000);
        updateShadowStatus('');
        return;
    }
    if (!result || !result.blob || result.duration < 0.15) {
        updateShadowStatus('');
        showToast('Nothing was recorded. Check the microphone and try again.');
        return;
    }

    state.recordingMeta = {
        ...result,
        mode: state.mode,
        overlapOffsetMs: state.mode === 'overlap' ? (state.overlapPlaybackOffsetMs || 0) : 0
    };
    state.recordingBlob = result.blob;
    state.recordWallClock = null;

    try {
        const attemptId = await saveAttempt({
            videoId: state.currentVideo.id,
            sentenceId: sentence.id,
            createdAt: Date.now(),
            mode: state.mode,
            rating: 0,
            audioBlob: result.blob,
            durationMs: Math.round(result.duration * 1000),
            lossless: !!result.lossless,
            mimeType: result.mimeType
        });
        state.attemptId = attemptId;
        state.rating = 0;
        const sentenceLength = sentence.end - sentence.start;
        const practiceSeconds = state.mode === 'overlap'
            ? Math.max(sentenceLength, result.duration)
            : sentenceLength + result.duration;
        await bumpProgress(practiceSeconds);
        await openReviewPanel({
            attemptId,
            blob: result.blob,
            meta: state.recordingMeta,
            sentence
        });
    } catch (err) {
        showToast('Could not save this attempt: ' + (err.message || 'unknown error'), 5000);
        updateShadowStatus('');
    }
    void reason;
}

/* ------------------------------------------------------------- camera PiP */

async function toggleCameraPip() {
    const pip = document.getElementById('pip-camera');
    if (state.pipStream) {
        state.pipStream.getTracks().forEach((track) => track.stop());
        state.pipStream = null;
        pip.srcObject = null;
        pip.hidden = true;
        document.getElementById('btn-toggle-pip').textContent = 'Camera PiP';
        return;
    }
    try {
        const stream = await audioProcessor.requestCamera();
        state.pipStream = stream;
        pip.srcObject = stream;
        pip.hidden = false;
        document.getElementById('camera-denied').hidden = true;
        document.getElementById('btn-toggle-pip').textContent = 'Hide camera';
        document.getElementById('btn-request-camera').textContent = 'Camera allowed';
    } catch (err) {
        document.getElementById('camera-denied').hidden = false;
        document.getElementById('camera-denied').textContent = err.message;
        showToast(err.message, 5000);
    }
}

/* ------------------------------------------------------------------- loop */

function setupLoopSheet() {
    document.getElementById('loop-close').addEventListener('click', () => {
        document.getElementById('loop-sheet').classList.remove('active');
    });
    document.getElementById('loop-sheet-backdrop').addEventListener('click', () => {
        document.getElementById('loop-sheet').classList.remove('active');
    });
    document.getElementById('loop-range').addEventListener('input', (event) => {
        document.getElementById('loop-value').textContent = event.target.value;
    });
    document.getElementById('btn-start-loop').addEventListener('click', () => {
        const count = parseInt(document.getElementById('loop-range').value, 10) || 3;
        document.getElementById('loop-sheet').classList.remove('active');
        startShadowLoop(count);
    });
    document.getElementById('btn-stop-loop').addEventListener('click', () => {
        stopShadowLoop(true);
        document.getElementById('loop-sheet').classList.remove('active');
    });
}

function startShadowLoop(count) {
    const sentence = currentSentence();
    if (!hasTiming(sentence)) return;
    if (state.recording) {
        showToast('Stop the recording before starting a loop.');
        return;
    }
    stopShadowLoop(false);
    state.freePlayback = false;
    state.loopActive = true;
    state.loopTotal = count;
    state.loopRemaining = count;
    state.loopCount = count;
    document.getElementById('btn-stop-loop').hidden = false;
    document.getElementById('btn-start-loop').hidden = true;
    document.getElementById('btn-loop-shadow').textContent = 'Stop loop';
    updateShadowStatus(`Loop 1 of ${count}`);
    runLoopIteration();
}

function runLoopIteration() {
    if (!state.loopActive) return;
    if (state.loopRemaining <= 0) {
        stopShadowLoop(true);
        showToast('Loop finished');
        return;
    }
    const video = document.getElementById('shadow-video');
    const sentence = currentSentence();
    state.loopRemaining -= 1;
    updateShadowStatus(`Loop ${state.loopTotal - state.loopRemaining} of ${state.loopTotal}`);

    video.currentTime = sentence.start;
    state.stopAt = sentence.end;
    state.onSentenceEnd = () => {
        if (!state.loopActive) return;
        if (state.loopRemaining <= 0) {
            stopShadowLoop(true);
            showToast('Loop finished');
            return;
        }
        setTimeout(() => {
            if (state.loopActive) runLoopIteration();
        }, 650);
    };
    video.play().catch(() => {});
}

function stopShadowLoop(showToastMessage) {
    state.loopActive = false;
    state.loopRemaining = 0;
    const start = document.getElementById('btn-start-loop');
    const stop = document.getElementById('btn-stop-loop');
    const toggle = document.getElementById('btn-loop-shadow');
    if (start) start.hidden = false;
    if (stop) stop.hidden = true;
    if (toggle) toggle.textContent = 'Loop…';
    if (showToastMessage) updateShadowStatus('');
}

/* ----------------------------------------------------------------- review */

const abPlayer = {
    ctx: null,
    buffers: { original: null, you: null },
    active: 'original',
    source: null,
    playing: false,
    position: 0,
    startedAt: 0,
    startedPosition: 0,

    async ensureContext() {
        if (!this.ctx) {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            this.ctx = new Ctor();
        }
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        return this.ctx;
    },

    setBuffers(original, you) {
        this.buffers.original = original || null;
        this.buffers.you = you || null;
        this.position = 0;
    },

    duration() {
        const buffer = this.buffers[this.active];
        return buffer ? buffer.duration : 0;
    },

    currentPosition() {
        if (!this.playing || !this.ctx) return this.position;
        return Math.min(this.duration(), this.startedPosition + (this.ctx.currentTime - this.startedAt));
    },

    stopSource() {
        if (this.source) {
            try { this.source.onended = null; this.source.stop(); } catch { /* ignore */ }
            this.source = null;
        }
        this.playing = false;
    },

    async play() {
        const buffer = this.buffers[this.active];
        if (!buffer) return false;
        await this.ensureContext();
        this.stopSource();
        if (this.position >= buffer.duration - 0.01) this.position = 0;
        this.source = this.ctx.createBufferSource();
        this.source.buffer = buffer;
        this.source.connect(this.ctx.destination);
        this.startedAt = this.ctx.currentTime;
        this.startedPosition = this.position;
        this.source.start(0, this.position);
        this.playing = true;
        this.source.onended = () => {
            if (this.playing) {
                this.playing = false;
                this.position = 0;
                this.source = null;
                // The play/pause label lives in the DOM, so reset it when the
                // buffer finishes on its own.
                if (typeof updateABLabels === 'function') updateABLabels();
            }
        };
        if (typeof updateABLabels === 'function') updateABLabels();
        return true;
    },

    pause() {
        if (!this.playing) return;
        this.position = this.currentPosition();
        this.stopSource();
        if (typeof updateABLabels === 'function') updateABLabels();
    },

    toggle() {
        if (this.playing) {
            this.pause();
            return false;
        }
        this.play();
        return true;
    },

    switchTo(kind) {
        if (!this.buffers[kind]) return false;
        const wasPlaying = this.playing;
        const position = this.currentPosition();
        this.stopSource();
        this.active = kind;
        this.position = Math.min(position, this.duration());
        if (wasPlaying) this.play();
        return true;
    },

    stop() {
        this.stopSource();
        this.position = 0;
    }
};

function setupReview() {
    document.getElementById('btn-close-review').addEventListener('click', closeReviewPanel);
    document.getElementById('review-backdrop').addEventListener('click', closeReviewPanel);

    document.querySelectorAll('#ab-segmented .seg-btn').forEach((button) => {
        button.addEventListener('click', () => {
            if (!abPlayer.buffers[button.dataset.ab]) {
                showToast(button.dataset.ab === 'original'
                    ? 'The original audio could not be decoded for this file.'
                    : 'No recording for this side.');
                return;
            }
            setABActive(button.dataset.ab);
            abPlayer.switchTo(button.dataset.ab);
            updateABLabels();
        });
    });

    document.getElementById('btn-ab-toggle').addEventListener('click', () => {
        const next = abPlayer.active === 'original' ? 'you' : 'original';
        if (!abPlayer.buffers[next]) {
            showToast(next === 'original'
                ? 'The original audio could not be decoded for this file.'
                : 'No recording to compare.');
            return;
        }
        setABActive(next);
        abPlayer.switchTo(next);
        updateABLabels();
    });

    document.getElementById('btn-ab-play').addEventListener('click', async () => {
        if (!abPlayer.buffers[abPlayer.active]) {
            showToast('Nothing to play on this side yet.');
            return;
        }
        if (abPlayer.playing) {
            abPlayer.pause();
            updateABLabels();
            return;
        }
        const playing = await abPlayer.play();
        if (playing) updateABLabels();
    });

    document.querySelectorAll('.star-btn').forEach((button) => {
        button.addEventListener('click', async () => {
            state.rating = parseInt(button.dataset.rating, 10) || 0;
            updateStarRating(state.rating);
            if (!state.attemptId) return;
            try {
                const attempt = await getAttemptById(state.attemptId);
                if (attempt) {
                    attempt.rating = state.rating;
                    await updateAttempt(attempt);
                    document.getElementById('rating-status').textContent = `Saved ${state.rating} star${state.rating === 1 ? '' : 's'} on this device.`;
                }
            } catch (err) {
                console.warn('Could not save rating:', err);
            }
        });
    });

    setInterval(() => {
        if (!document.getElementById('review-panel').classList.contains('active')) return;
        updateABTime();
        if (abPlayer.playing) {
            const position = abPlayer.currentPosition();
            document.getElementById('ab-time').textContent = `${formatClock(position)} / ${formatClock(abPlayer.duration())}`;
            if (position >= abPlayer.duration() - 0.01) {
                abPlayer.pause();
                updateABLabels();
            }
        }
    }, 120);
}

async function getAttemptById(id) {
    const db = await initDB();
    const tx = db.transaction(['attempts'], 'readonly');
    return new Promise((resolve, reject) => {
        const request = tx.objectStore('attempts').get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function setABActive(kind) {
    document.querySelectorAll('#ab-segmented .seg-btn').forEach((button) => {
        button.classList.toggle('active', button.dataset.ab === kind);
    });
}

function updateABLabels() {
    const button = document.getElementById('btn-ab-play');
    button.textContent = abPlayer.playing ? 'Pause' : 'Play';
    document.getElementById('ab-status').textContent = abPlayer.buffers.original
        ? 'Switching keeps the same point in the audio.'
        : 'Original audio unavailable for this file; you can still hear your recording.';
    updateABTime();
}

function updateABTime() {
    const position = abPlayer.currentPosition();
    const duration = abPlayer.duration();
    document.getElementById('ab-time').textContent = `${formatClock(position)} / ${formatClock(duration)}`;
}

function closeReviewPanel() {
    abPlayer.stop();
    document.getElementById('review-panel').classList.remove('active');
    document.getElementById('btn-ab-play').textContent = 'Play';
}

async function openReviewPanel({ attemptId, blob, meta, sentence }) {
    document.getElementById('review-panel').classList.add('active');
    document.getElementById('review-loading').hidden = false;
    document.getElementById('feedback-text').textContent = 'Measuring…';
    document.getElementById('similarity-section').hidden = true;
    document.getElementById('rating-status').textContent = 'Saved on this device only.';
    document.getElementById('comparison-visuals').classList.add('is-loading');
    setABActive('original');
    abPlayer.setBuffers(null, null);
    state.attemptId = attemptId;
    state.rating = 0;
    updateStarRating(0);
    updateABLabels();

    let userBuffer = null;
    try {
        userBuffer = await audioProcessor.decodeBlob(blob, true);
    } catch (err) {
        document.getElementById('feedback-text').textContent = 'Could not decode this recording: ' + err.message;
        document.getElementById('review-loading').hidden = true;
        document.getElementById('comparison-visuals').classList.remove('is-loading');
        return;
    }

    let originalSegment = null;
    let originalError = null;
    try {
        const full = await getDecodedMediaBuffer(state.currentVideo);
        if (full) {
            originalSegment = audioProcessor.extractSegment(full, sentence.start, sentence.end);
        } else {
            originalError = 'This file has no decodable audio track.';
        }
    } catch (err) {
        originalError = err.message;
    }

    abPlayer.setBuffers(originalSegment, userBuffer);
    abPlayer.active = originalSegment ? 'original' : 'you';
    setABActive(abPlayer.active);
    updateABLabels();

    const calibration = (await getSetting('latencyOffsetMs')) || 0;
    let analysis = null;
    if (originalSegment) {
        try {
            analysis = await audioProcessor.analyzeAttempt({
                originalBuffer: originalSegment,
                userBuffer,
                calibrationMs: calibration,
                mode: meta.mode || 'sequential',
                playbackOffsetMs: meta.overlapOffsetMs || 0
            });
        } catch (err) {
            console.warn('Analysis failed:', err);
            document.getElementById('feedback-text').textContent = 'Analysis failed: ' + err.message;
        }
    } else {
        document.getElementById('feedback-text').textContent =
            `Could not read the audio track for the comparison${originalError ? ': ' + originalError : '.'} ` +
            'Your recording is saved and can still be played.';
    }

    if (analysis) {
        renderAnalysis(analysis, { calibration, meta, sentence });
    }

    document.getElementById('review-loading').hidden = true;
    document.getElementById('comparison-visuals').classList.remove('is-loading');
    if (analysis) drawAnalysisCharts(analysis, originalSegment, userBuffer);
}

async function getDecodedMediaBuffer(video) {
    if (!video || !(video.blob instanceof Blob)) return null;
    if (state.mediaBuffer && state.mediaBufferVideoId === video.id) return state.mediaBuffer;
    try {
        const buffer = await audioProcessor.decodeBlob(video.blob, true);
        state.mediaBuffer = buffer;
        state.mediaBufferVideoId = video.id;
        return buffer;
    } catch {
        return null;
    }
}

function renderAnalysis(analysis, { calibration, meta, sentence }) {
    const feedbackEl = document.getElementById('feedback-text');
    feedbackEl.innerHTML = '';
    if (!analysis.hasVoice) {
        analysis.feedback.forEach((line) => appendFeedback(feedbackEl, line));
        return;
    }

    const list = [...analysis.feedback];
    const m = analysis.metrics;
    if (calibration > 0) {
        if (meta.mode === 'overlap') {
            list.push(`A ${Math.round(calibration)} ms round-trip latency is saved. It is reported here, not subtracted from overlap timing, because the playback offset is measured separately.`);
        } else {
            list.push(`Timing is corrected for a ${Math.round(calibration)} ms measured round-trip latency (estimate, about ±15 ms).`);
        }
    } else {
        list.push('No latency calibration saved yet — run calibration in settings for tighter timing numbers.');
    }
    if (meta.mode === 'overlap') {
        list.push('Overlap recordings include the original speaker in the microphone if you used speakers instead of headphones.');
    }
    list.push(`Sentence length: ${sentence.end - sentence.start > 0 ? (sentence.end - sentence.start).toFixed(2) : analysis.original.duration.toFixed(2)} s; your recording: ${analysis.user.duration.toFixed(2)} s.`);
    if (Number.isFinite(m.driftMs)) {
        list.push(`Median rhythm offset from DTW: ${m.driftMs > 0 ? '+' : ''}${m.driftMs} ms (positive = behind, measured within the voiced spans).`);
    }

    list.forEach((line) => appendFeedback(feedbackEl, line));

    if (analysis.similarities && (Number.isFinite(analysis.similarities.rhythm) || Number.isFinite(analysis.similarities.pitch))) {
        document.getElementById('similarity-section').hidden = false;
        const sim = document.getElementById('similarity-text');
        sim.innerHTML = '';
        if (Number.isFinite(analysis.similarities.rhythm)) {
            appendFeedback(sim, `Rhythm similarity estimate: ${analysis.similarities.rhythm}% — 100 means identical loudness envelopes after DTW alignment of the voiced spans; 0 means very different.`);
        }
        if (Number.isFinite(analysis.similarities.pitch)) {
            appendFeedback(sim, `Pitch-contour similarity estimate: ${analysis.similarities.pitch}% — compares intonation shape only, not absolute pitch.`);
        } else {
            appendFeedback(sim, 'Pitch similarity: not enough voiced audio in both recordings, or the contours could not be aligned.');
        }
    }
}

function appendFeedback(container, text) {
    const line = document.createElement('div');
    line.className = 'feedback-line';
    line.textContent = '• ' + text;
    container.appendChild(line);
}

function updateStarRating(rating) {
    document.querySelectorAll('.star-btn').forEach((button) => {
        button.classList.toggle('active', parseInt(button.dataset.rating, 10) <= rating);
    });
}

/* ------------------------------------------------------------- chart drawing */

function prepareCanvas(canvas) {
    const width = canvas.clientWidth || 320;
    const height = canvas.clientHeight || 110;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const styles = getComputedStyle(document.documentElement);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = styles.getPropertyValue('--surface-2').trim() || '#f5f5f7';
    ctx.fillRect(0, 0, width, height);
    ctx.font = '10px system-ui, sans-serif';
    return { ctx, width, height, styles };
}

function drawAnalysisCharts(analysis, originalBuffer, userBuffer) {
    drawWaveformComparison(analysis, originalBuffer, userBuffer);
    drawPitchComparison(analysis);
    drawLoudnessComparison(analysis);
}

function drawWaveformComparison(analysis, originalBuffer, userBuffer) {
    const canvas = document.getElementById('comparison-waveform');
    const { ctx, width, height, styles } = prepareCanvas(canvas);
    const accent = styles.getPropertyValue('--accent').trim() || '#0071e3';
    const secondary = styles.getPropertyValue('--text-secondary').trim() || '#86868b';

    const half = height / 2;
    const originalPeaks = originalBuffer ? computePeaksInline(originalBuffer, Math.max(120, Math.floor(width))) : null;
    const userPeaks = computePeaksInline(userBuffer, Math.max(120, Math.floor(width)));

    const drawHalf = (peaks, centerY, color, label) => {
        if (!peaks) return;
        const amplitude = half * 0.4;
        ctx.fillStyle = color;
        const buckets = peaks.length / 2;
        for (let x = 0; x < width; x++) {
            const bucket = Math.min(buckets - 1, Math.floor(x / width * buckets));
            const min = peaks[bucket * 2];
            const max = peaks[bucket * 2 + 1];
            const y1 = centerY + min * amplitude;
            const y2 = centerY + max * amplitude;
            ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
        }
        ctx.fillStyle = color;
        ctx.fillText(label, 8, centerY - half * 0.38);
    };

    drawHalf(originalPeaks, half * 0.5, accent, 'Original');
    drawHalf(userPeaks, half * 1.5, secondary, 'You');
    ctx.strokeStyle = styles.getPropertyValue('--border').trim() || 'rgba(0,0,0,0.08)';
    ctx.beginPath();
    ctx.moveTo(0, half);
    ctx.lineTo(width, half);
    ctx.stroke();
}

function drawPitchComparison(analysis) {
    const canvas = document.getElementById('comparison-pitch');
    const { ctx, width, height, styles } = prepareCanvas(canvas);
    const accent = styles.getPropertyValue('--accent').trim() || '#0071e3';
    const secondary = styles.getPropertyValue('--text-secondary').trim() || '#86868b';

    const maxDuration = Math.max(analysis.original.duration, analysis.user.duration, 0.1);
    const hop = analysis.pitch.hop || 0.012;
    const values = [
        ...analysis.pitch.original.filter((v) => v > 0),
        ...analysis.pitch.user.filter((v) => v > 0)
    ];
    if (!values.length) {
        ctx.fillStyle = secondary;
        ctx.fillText('No pitched voice detected.', 8, height / 2);
        return;
    }

    const med = median(values);
    const semis = (v) => (v > 0 ? 12 * Math.log2(v / med) : null);
    const allSemis = values.map(semis).filter((v) => Number.isFinite(v));
    const low = Math.max(-24, Math.min(...allSemis, -2) - 1);
    const high = Math.min(24, Math.max(...allSemis, 2) + 1);
    const yFor = (semitone) => height - 14 - ((semitone - low) / (high - low)) * (height - 24);
    const xFor = (seconds) => 8 + seconds / maxDuration * (width - 16);

    ctx.strokeStyle = styles.getPropertyValue('--border').trim() || 'rgba(0,0,0,0.08)';
    ctx.beginPath();
    ctx.moveTo(8, yFor(0));
    ctx.lineTo(width - 8, yFor(0));
    ctx.stroke();

    const plot = (track, color) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        let started = false;
        track.forEach((value, index) => {
            const semitone = semis(value);
            if (!Number.isFinite(semitone)) {
                started = false;
                return;
            }
            const x = xFor(index * hop);
            const y = yFor(semitone);
            if (!started) { ctx.moveTo(x, y); started = true; }
            else ctx.lineTo(x, y);
        });
        ctx.stroke();
    };

    plot(analysis.pitch.original, accent);
    plot(analysis.pitch.user, secondary);

    ctx.fillStyle = accent;
    ctx.fillText('Original', 8, 12);
    ctx.fillStyle = secondary;
    ctx.fillText('You', 8, 24);
    ctx.fillStyle = secondary;
    ctx.fillText(`${low.toFixed(0)}…${high.toFixed(0)} st`, width - 58, height - 4);
}

function drawLoudnessComparison(analysis) {
    const canvas = document.getElementById('comparison-loudness');
    const { ctx, width, height, styles } = prepareCanvas(canvas);
    const accent = styles.getPropertyValue('--accent').trim() || '#0071e3';
    const secondary = styles.getPropertyValue('--text-secondary').trim() || '#86868b';

    const maxDuration = Math.max(analysis.original.duration, analysis.user.duration, 0.1);
    const original = analysis.original.envelope;
    const user = analysis.user.envelope;

    const normalise = (envelope) => {
        const max = envelope.peak || 1;
        return envelope.values.map((v) => Math.min(1, v / max));
    };

    const drawEnvelope = (envelope, color, label, offset) => {
        const values = normalise(envelope);
        const hopSeconds = envelope.hop / envelope.sampleRate;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        values.forEach((value, index) => {
            const x = 8 + (index * hopSeconds) / maxDuration * (width - 16);
            const y = height - 12 - value * (height - 30) * 0.45 - offset;
            if (index === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.fillText(label, 8, label === 'Original' ? 12 : 24);
    };

    drawEnvelope(original, accent, 'Original', (height - 30) * 0.5);
    drawEnvelope(user, secondary, 'You', 0);
}

/* ---------------------------------------------------------------- progress */

async function bumpProgress(seconds) {
    const progress = await getProgress();
    const today = todayKey();
    if (!progress.daily) progress.daily = {};
    if (!progress.daily[today]) progress.daily[today] = { sentences: 0, seconds: 0 };

    progress.sentencesPracticed = (progress.sentencesPracticed || 0) + 1;
    progress.totalSeconds = (progress.totalSeconds || 0) + Math.max(0, seconds || 0);
    progress.totalMinutes = progress.totalSeconds / 60;
    progress.daily[today].sentences += 1;
    progress.daily[today].seconds += Math.max(0, seconds || 0);

    if (progress.lastPracticeDay !== today) {
        const yesterday = todayKey(addDays(new Date(), -1));
        progress.streak = progress.lastPracticeDay === yesterday ? (progress.streak || 0) + 1 : 1;
        progress.lastPracticeDay = today;
    }
    if (!progress.streak) progress.streak = 1;
    progress.updatedAt = Date.now();

    await saveProgress(progress);
    await updateProgressDisplay();
}

async function updateProgressDisplay() {
    const progress = await getProgress();
    const minutes = Math.round(progress.totalMinutes || 0);
    document.getElementById('streak-count').textContent = progress.streak || 0;
    document.getElementById('minutes-total').textContent = minutes;
    document.getElementById('sentences-practiced').textContent = progress.sentencesPracticed || 0;
}

async function renderProgressScreen() {
    const progress = await getProgress();
    document.getElementById('prog-streak').textContent = progress.streak || 0;
    document.getElementById('prog-minutes').textContent = Math.round(progress.totalMinutes || 0);
    document.getElementById('prog-sentences').textContent = progress.sentencesPracticed || 0;

    const chart = document.getElementById('weekly-chart-bars');
    chart.innerHTML = '';
    const days = [];
    for (let i = 6; i >= 0; i--) days.push(addDays(new Date(), -i));

    const counts = days.map((date) => {
        const entry = (progress.daily || {})[todayKey(date)];
        return entry ? entry.sentences : 0;
    });
    const max = Math.max(1, ...counts);
    const total = counts.reduce((sum, value) => sum + value, 0);
    document.getElementById('weekly-subtitle').textContent = total
        ? `${total} sentence${total === 1 ? '' : 's'} in the last 7 days`
        : 'No attempts in the last 7 days yet';

    days.forEach((date, index) => {
        const container = document.createElement('div');
        container.className = 'chart-bar-container';

        const value = document.createElement('div');
        value.className = 'chart-value';
        value.textContent = counts[index] || '';

        const track = document.createElement('div');
        track.className = 'chart-bar-track';

        const bar = document.createElement('div');
        bar.className = 'chart-bar';
        bar.style.height = `${Math.max(3, Math.round(counts[index] / max * 100))}%`;
        if (!counts[index]) bar.classList.add('empty');
        track.appendChild(bar);

        const label = document.createElement('div');
        label.className = 'chart-label';
        label.textContent = date.toLocaleDateString(undefined, { weekday: 'short' });

        container.appendChild(value);
        container.appendChild(track);
        container.appendChild(label);
        chart.appendChild(container);
    });
    chart.setAttribute('aria-label', `Sentences per day: ${days.map((date, index) => `${date.toLocaleDateString(undefined, { weekday: 'long' })} ${counts[index]}`).join(', ')}`);
}

/* -------------------------------------------------------------- permissions */

function setupPermissions() {
    document.getElementById('btn-request-mic').addEventListener('click', async () => {
        try {
            await audioProcessor.requestMicrophone(document.getElementById('chk-echo-cancel').checked);
            document.getElementById('mic-status').textContent = 'Microphone ready. Recording uses the raw voice unless echo cancellation is enabled above.';
            showToast('Microphone ready');
        } catch (err) {
            document.getElementById('mic-status').textContent = err.message;
            showToast(err.message, 5000);
        }
    });

    document.getElementById('chk-echo-cancel').addEventListener('change', async (event) => {
        await saveSetting('echoCancellation', event.target.checked);
        if (audioProcessor.mediaStream) {
            audioProcessor.mediaStream.getTracks().forEach((track) => track.stop());
            audioProcessor.mediaStream = null;
        }
        showToast(event.target.checked ? 'Echo cancellation on (for speakers)' : 'Echo cancellation off (raw voice)');
    });

    document.getElementById('btn-request-camera').addEventListener('click', async () => {
        try {
            const stream = await audioProcessor.requestCamera();
            stream.getTracks().forEach((track) => track.stop());
            document.getElementById('camera-status').textContent = 'Camera allowed. Turn on Camera PiP while shadowing. It is never uploaded.';
            showToast('Camera ready');
        } catch (err) {
            document.getElementById('camera-status').textContent = err.message;
            showToast(err.message, 5000);
        }
    });

    document.getElementById('btn-calibrate').addEventListener('click', async () => {
        const button = document.getElementById('btn-calibrate');
        const resultEl = document.getElementById('calibration-result');
        button.disabled = true;
        resultEl.textContent = 'Playing a click and listening… (stay quiet for a second)';
        try {
            const result = await audioProcessor.calibrateLatency();
            resultEl.textContent = `Measured round-trip latency: ${result.offsetMs} ms (${result.confidence} confidence). ${result.note}`;
            showToast('Calibration saved: ' + result.offsetMs + ' ms');
        } catch (err) {
            resultEl.textContent = err.message;
            showToast(err.message, 6000);
        } finally {
            button.disabled = false;
        }
    });

    document.getElementById('perm-close').addEventListener('click', () => {
        document.getElementById('perm-sheet').classList.remove('active');
    });
    document.getElementById('perm-sheet-backdrop').addEventListener('click', () => {
        document.getElementById('perm-sheet').classList.remove('active');
    });
}

function updateRecordingFormatStatus() {
    const el = document.getElementById('format-status');
    if (!el) return;
    const workletCtor = window.AudioContext || window.webkitAudioContext;
    const hasWorklet = !!(workletCtor && workletCtor.prototype && 'audioWorklet' in workletCtor.prototype);
    const worklet = typeof AudioWorkletNode !== 'undefined' && hasWorklet;
    el.textContent = worklet
        ? 'Lossless 16-bit WAV via AudioWorklet. Saved originals are never re-processed.'
        : 'AudioWorklet is unavailable; recordings fall back to the best MediaRecorder codec the browser supports.';
}

/* --------------------------------------------------------------- keyboard */

function setupKeyboard() {
    document.addEventListener('keydown', (event) => {
        const reviewOpen = document.getElementById('review-panel').classList.contains('active');
        const tag = document.activeElement && document.activeElement.tagName;
        const typing = tag === 'INPUT' || tag === 'TEXTAREA' || (document.activeElement && document.activeElement.isContentEditable);
        if (typing) return;

        if (event.key === 'Escape') {
            if (reviewOpen) closeReviewPanel();
            else closeAllSheets();
            return;
        }

        if (reviewOpen) {
            if (event.code === 'Space') {
                event.preventDefault();
                document.getElementById('btn-ab-play').click();
            }
            return;
        }

        if (!document.getElementById('screen-shadow').classList.contains('active')) return;
        if (event.code === 'Space') {
            event.preventDefault();
            document.getElementById('btn-play-pause-shadow').click();
        } else if (event.code === 'ArrowRight') {
            event.preventDefault();
            document.getElementById('btn-next-sentence').click();
        } else if (event.code === 'ArrowLeft') {
            event.preventDefault();
            document.getElementById('btn-prev-sentence').click();
        } else if (event.code === 'KeyR') {
            event.preventDefault();
            document.getElementById('btn-shadow-record').click();
        }
    });
}

/* --------------------------------------------------------- subtitle parsing */

/**
 * Parse .srt or .vtt into cues with exact timings.
 * Cue text may include VTT timestamp tags, which become word timings.
 */
function parseSubtitles(raw, filename = '') {
    if (!raw) return [];
    const text = String(raw).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const isVtt = /\.vtt$/i.test(filename) || /^\s*WEBVTT/.test(text);
    const blocks = text.split(/\n{2,}/);
    const segments = [];

    for (const block of blocks) {
        const lines = block.split('\n').map((line) => line.trimEnd());
        if (!lines.length) continue;
        if (/^WEBVTT/.test(lines[0])) continue;
        if (/^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;

        const timeIndex = lines.findIndex((line) => line.includes('-->'));
        if (timeIndex === -1) continue;

        const timingLine = lines[timeIndex];
        const match = timingLine.match(/(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})/);
        if (!match) continue;

        const start = parseSubtitleTime(match[1]);
        const end = parseSubtitleTime(match[2]);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

        const textLines = lines.slice(timeIndex + 1).filter((line) => line !== '');
        if (!textLines.length) continue;

        const { plainText, words } = parseCueText(textLines.join('\n'), isVtt, start, end);
        if (!plainText) continue;

        segments.push({
            start,
            end,
            text: plainText,
            words: words.length > 1 ? words : []
        });
    }

    return segments.sort((a, b) => a.start - b.start);
}

function parseSubtitleTime(value) {
    const cleaned = String(value).trim().replace(',', '.');
    const parts = cleaned.split(':').map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return NaN;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return NaN;
}

function stripCueTags(text) {
    return String(text)
        .replace(/<\/?[^>]+>/g, '')   // <i>, </i>, <c.yellow>, <v Speaker>, <ruby>…
        .replace(/\{\\[^}]*\}/g, ''); // ASS-style override tags
}

/**
 * Split a cue's text into plain text plus optional word timings.
 * WebVTT karaoke cues use inline <00:00:01.000> tags; those tags are the only
 * angle-bracket content we keep, everything else is markup.
 */
function parseCueText(rawText, isVtt, cueStart, cueEnd) {
    const base = String(rawText).replace(/<br\s*\/?>/gi, '\n');
    const timestampPattern = /<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>/;
    const splitPattern = /(<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>)/g;

    if (!timestampPattern.test(base)) {
        return { plainText: stripCueTags(base).replace(/\s+/g, ' ').trim(), words: [] };
    }

    const tokens = [];
    let currentTime = cueStart;
    const parts = base.split(splitPattern);
    for (const part of parts) {
        if (!part) continue;
        const tagMatch = part.match(/^<(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})>$/);
        if (tagMatch) {
            const time = parseSubtitleTime(tagMatch[1]);
            if (Number.isFinite(time)) currentTime = time;
            continue;
        }
        const pieces = stripCueTags(part).split(/\s+/).filter(Boolean);
        for (const piece of pieces) {
            tokens.push({ word: piece, start: currentTime });
        }
    }

    const words = tokens.map((token, index) => ({
        word: token.word,
        start: token.start,
        end: index + 1 < tokens.length ? Math.max(token.start, tokens[index + 1].start) : cueEnd
    }));

    return {
        plainText: stripCueTags(base).replace(/\s+/g, ' ').trim(),
        words
    };
}

/* ------------------------------------------------------------------ export */

window.__shadow = {
    state,
    parseSubtitles,
    splitIntoSentences,
    abPlayer,
    getCurrentSentence: () => currentSentence()
};
