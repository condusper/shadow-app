/**
 * IndexedDB storage for videos, transcripts, sentences, attempts, progress.
 *
 * Media files are stored as Blobs inside IndexedDB so everything survives a
 * reload and works offline. Object URLs are created on demand at runtime and
 * never persisted (they are only valid for the lifetime of the page).
 */

const DB_NAME = 'ShadowAppDB';
const DB_VERSION = 3;

let dbInstance = null;

function initDB() {
    return new Promise((resolve, reject) => {
        if (dbInstance) {
            resolve(dbInstance);
            return;
        }

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Database upgrade blocked — close other tabs of this app.'));

        request.onsuccess = () => {
            dbInstance = request.result;
            dbInstance.onversionchange = () => {
                dbInstance.close();
                dbInstance = null;
            };
            resolve(dbInstance);
        };

        request.onupgradeneeded = (event) => {
            const db = request.result;
            void event;

            if (!db.objectStoreNames.contains('videos')) {
                const videoStore = db.createObjectStore('videos', { keyPath: 'id', autoIncrement: true });
                videoStore.createIndex('createdAt', 'createdAt', { unique: false });
            }

            if (!db.objectStoreNames.contains('transcripts')) {
                db.createObjectStore('transcripts', { keyPath: 'videoId' });
            }

            if (!db.objectStoreNames.contains('sentences')) {
                const sentenceStore = db.createObjectStore('sentences', { keyPath: 'id', autoIncrement: true });
                sentenceStore.createIndex('videoId', 'videoId', { unique: false });
            }

            if (!db.objectStoreNames.contains('attempts')) {
                const attemptStore = db.createObjectStore('attempts', { keyPath: 'id', autoIncrement: true });
                attemptStore.createIndex('sentenceId', 'sentenceId', { unique: false });
                attemptStore.createIndex('videoId', 'videoId', { unique: false });
                attemptStore.createIndex('createdAt', 'createdAt', { unique: false });
            }

            // Audio is kept separately so listing attempts stays lightweight.
            if (!db.objectStoreNames.contains('attemptAudio')) {
                db.createObjectStore('attemptAudio', { keyPath: 'attemptId' });
            }

            if (!db.objectStoreNames.contains('progress')) {
                db.createObjectStore('progress', { keyPath: 'id' });
            }

            if (!db.objectStoreNames.contains('settings')) {
                db.createObjectStore('settings', { keyPath: 'key' });
            }
        };
    });
}

function requestToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function txDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
}

/* ------------------------------------------------------------------ videos */

async function addVideo(videoData) {
    const db = await initDB();
    const tx = db.transaction(['videos'], 'readwrite');
    const id = await requestToPromise(tx.objectStore('videos').add(videoData));
    await txDone(tx);
    return id;
}

async function updateVideo(video) {
    const db = await initDB();
    const tx = db.transaction(['videos'], 'readwrite');
    tx.objectStore('videos').put(video);
    await txDone(tx);
    return video;
}

async function getAllVideos() {
    const db = await initDB();
    const tx = db.transaction(['videos'], 'readonly');
    const videos = await requestToPromise(tx.objectStore('videos').getAll());
    return (videos || []).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

async function getVideo(id) {
    const db = await initDB();
    const tx = db.transaction(['videos'], 'readonly');
    return requestToPromise(tx.objectStore('videos').get(id));
}

async function deleteVideo(id) {
    const db = await initDB();
    const tx = db.transaction(['videos', 'transcripts', 'sentences', 'attempts', 'attemptAudio'], 'readwrite');
    tx.objectStore('videos').delete(id);
    tx.objectStore('transcripts').delete(id);

    for (const storeName of ['sentences', 'attempts']) {
        const store = tx.objectStore(storeName);
        const index = store.index('videoId');
        const cursorRequest = index.openCursor(IDBKeyRange.only(id));
        cursorRequest.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
                if (storeName === 'attempts') {
                    tx.objectStore('attemptAudio').delete(cursor.primaryKey);
                }
                cursor.delete();
                cursor.continue();
            }
        };
    }

    await txDone(tx);
    const cached = videoUrlCache.get(id);
    if (cached) {
        URL.revokeObjectURL(cached);
        videoUrlCache.delete(id);
    }
}

/* Runtime-only object URL cache so we do not leak one URL per render. */
const videoUrlCache = new Map();

function getVideoURL(video) {
    if (!video) return '';
    if (video.blob instanceof Blob) {
        let url = videoUrlCache.get(video.id);
        if (!url) {
            url = URL.createObjectURL(video.blob);
            videoUrlCache.set(video.id, url);
        }
        return url;
    }
    // Legacy records from the first build only had a (now dead) object URL.
    return video.objectUrl || '';
}

/* ------------------------------------------------------------- transcripts */

async function saveTranscript(transcript) {
    const db = await initDB();
    const tx = db.transaction(['transcripts'], 'readwrite');
    tx.objectStore('transcripts').put(transcript);
    await txDone(tx);
    return transcript;
}

async function getTranscript(videoId) {
    const db = await initDB();
    const tx = db.transaction(['transcripts'], 'readonly');
    return requestToPromise(tx.objectStore('transcripts').get(videoId));
}

async function deleteTranscript(videoId) {
    const db = await initDB();
    const tx = db.transaction(['transcripts'], 'readwrite');
    tx.objectStore('transcripts').delete(videoId);
    await txDone(tx);
}

/* --------------------------------------------------------------- sentences */

async function saveSentences(sentences) {
    if (!sentences || sentences.length === 0) return [];
    const db = await initDB();
    const tx = db.transaction(['sentences'], 'readwrite');
    const store = tx.objectStore('sentences');

    // Queue every write inside the same task so the transaction stays active.
    const requests = sentences.map((sentence) => {
        const record = { ...sentence };
        return { record, request: record.id ? store.put(record) : store.add(record) };
    });
    const results = await Promise.all(requests.map(({ request }) => requestToPromise(request)));
    await txDone(tx);

    return requests.map(({ record }, i) => ({
        ...record,
        id: record.id || results[i]
    }));
}

async function replaceSentences(videoId, sentences) {
    // Read the existing keys first, then delete + add in one synchronous batch.
    const existing = await getSentences(videoId);
    const db = await initDB();
    const tx = db.transaction(['sentences'], 'readwrite');
    const store = tx.objectStore('sentences');

    for (const sentence of existing) {
        if (sentence.id) store.delete(sentence.id);
    }

    const requests = sentences.map((sentence) => {
        const record = { ...sentence, videoId };
        delete record.id;
        return store.add(record);
    });
    const ids = await Promise.all(requests.map(requestToPromise));
    await txDone(tx);

    return sentences.map((sentence, i) => ({ ...sentence, videoId, id: ids[i] }));
}

async function getSentences(videoId) {
    const db = await initDB();
    const tx = db.transaction(['sentences'], 'readonly');
    const index = tx.objectStore('sentences').index('videoId');
    const sentences = await requestToPromise(index.getAll(IDBKeyRange.only(videoId)));
    return (sentences || []).sort((a, b) => {
        const as = Number.isFinite(a.start) ? a.start : Infinity;
        const bs = Number.isFinite(b.start) ? b.start : Infinity;
        return as - bs;
    });
}

async function deleteSentence(id) {
    const db = await initDB();
    const tx = db.transaction(['sentences'], 'readwrite');
    tx.objectStore('sentences').delete(id);
    await txDone(tx);
}

/* ---------------------------------------------------------------- attempts */

async function saveAttempt(attempt) {
    const db = await initDB();
    const { audioBlob, ...metadata } = attempt;

    const tx = db.transaction(['attempts'], 'readwrite');
    const id = await requestToPromise(tx.objectStore('attempts').add(metadata));
    await txDone(tx);

    if (audioBlob) {
        const audioTx = db.transaction(['attemptAudio'], 'readwrite');
        audioTx.objectStore('attemptAudio').put({
            attemptId: id,
            blob: audioBlob,
            mimeType: attempt.mimeType || audioBlob.type || 'audio/wav',
            createdAt: attempt.createdAt || Date.now()
        });
        await txDone(audioTx);
    }
    return id;
}

async function getAttemptAudio(attemptId) {
    const db = await initDB();
    const tx = db.transaction(['attemptAudio'], 'readonly');
    const record = await requestToPromise(tx.objectStore('attemptAudio').get(attemptId));
    return record ? record.blob : null;
}

async function updateAttempt(attempt) {
    const db = await initDB();
    const tx = db.transaction(['attempts'], 'readwrite');
    tx.objectStore('attempts').put(attempt);
    await txDone(tx);
    return attempt;
}

async function getAttempts(sentenceId) {
    const db = await initDB();
    const tx = db.transaction(['attempts'], 'readonly');
    const index = tx.objectStore('attempts').index('sentenceId');
    return requestToPromise(index.getAll(IDBKeyRange.only(sentenceId)));
}

async function getAttemptsByVideo(videoId) {
    const db = await initDB();
    const tx = db.transaction(['attempts'], 'readonly');
    const index = tx.objectStore('attempts').index('videoId');
    return requestToPromise(index.getAll(IDBKeyRange.only(videoId)));
}

async function getAllAttempts() {
    const db = await initDB();
    const tx = db.transaction(['attempts'], 'readonly');
    return requestToPromise(tx.objectStore('attempts').getAll());
}

/* ---------------------------------------------------------------- progress */

function emptyProgress() {
    return {
        id: 'user',
        streak: 0,
        totalMinutes: 0,
        sentencesPracticed: 0,
        totalSeconds: 0,
        daily: {},          // { 'YYYY-MM-DD': { sentences, seconds } }
        lastPracticeDay: null,
        updatedAt: 0
    };
}

async function getProgress() {
    const db = await initDB();
    const tx = db.transaction(['progress'], 'readonly');
    const stored = await requestToPromise(tx.objectStore('progress').get('user'));
    return { ...emptyProgress(), ...(stored || {}) };
}

async function saveProgress(progress) {
    const db = await initDB();
    const tx = db.transaction(['progress'], 'readwrite');
    tx.objectStore('progress').put({ ...progress, id: 'user' });
    await txDone(tx);
    return progress;
}

/* ---------------------------------------------------------------- settings */

/*
 * Small settings live in localStorage (fast, synchronous enough for UI), with
 * an IndexedDB mirror kept so nothing is lost if storage gets cleared.
 */
const SETTINGS_KEY = 'shadow.settings.v1';

function readSettings() {
    try {
        return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    } catch {
        return {};
    }
}

function writeSettings(settings) {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
        /* private mode / quota — the IndexedDB mirror still holds it */
    }
}

function getSettingSync(key, fallback = null) {
    const settings = readSettings();
    return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : fallback;
}

async function saveSetting(key, value) {
    const settings = readSettings();
    settings[key] = value;
    writeSettings(settings);
    try {
        const db = await initDB();
        const tx = db.transaction(['settings'], 'readwrite');
        tx.objectStore('settings').put({ key, value });
        await txDone(tx);
    } catch {
        /* localStorage copy is enough */
    }
    return value;
}

async function getSetting(key) {
    const settings = readSettings();
    if (Object.prototype.hasOwnProperty.call(settings, key)) return settings[key];
    try {
        const db = await initDB();
        const tx = db.transaction(['settings'], 'readonly');
        const record = await requestToPromise(tx.objectStore('settings').get(key));
        if (record) {
            settings[key] = record.value;
            writeSettings(settings);
            return record.value;
        }
    } catch {
        /* ignore */
    }
    return null;
}
