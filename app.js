/**
 * BPM Heart — app.js
 * 3-in-1 Heart Rate Monitor
 *  Mode 1: Camera + Flash  → live red-channel peak detection
 *  Mode 2: Microphone      → BiquadFilter (50Hz) + RMS spike detection
 *  Mode 3: Video Upload    → frame-by-frame red-channel analysis of a recorded video
 *
 * Blood Pressure: population-average estimates keyed on BPM zone (not diagnostic).
 */

'use strict';

// ─────────────────────────────────────────────
// SERVICE WORKER
// ─────────────────────────────────────────────
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(r => console.log('[SW] scope:', r.scope))
            .catch(e => console.warn('[SW] failed:', e));
    });
}

// ─────────────────────────────────────────────
// PWA INSTALL BANNER
// ─────────────────────────────────────────────
let deferredPrompt = null;
const installBanner = document.getElementById('installBanner');

window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    installBanner.classList.add('visible');
});
installBanner.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') installBanner.classList.remove('visible');
    deferredPrompt = null;
});
window.addEventListener('appinstalled', () => {
    installBanner.classList.remove('visible');
    toast('✅ App installed — works offline now!');
});

// ─────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────
let _toastTimer;
function toast(msg, ms = 3800) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ─────────────────────────────────────────────
// DOM REFS
// ─────────────────────────────────────────────
// Tabs
const tabs = { camera: document.getElementById('cameraTab'), mic: document.getElementById('micTab'), upload: document.getElementById('uploadTab') };
const panels = { camera: document.getElementById('cameraPanel'), mic: document.getElementById('micPanel'), upload: document.getElementById('uploadPanel') };

// Camera
const $ = id => document.getElementById(id);
const cameraSensorVisual = $('cameraSensorVisual');
const cameraGauge = $('cameraGauge');
const cameraBpmValue = $('cameraBpmValue');
const cameraBpmStatus = $('cameraBpmStatus');
const cameraBpmCard = $('cameraBpmCard');
const cameraZoneBadge = $('cameraZoneBadge');
const cameraHistoryBars = $('cameraHistoryBars');
const cameraStartBtn = $('cameraStartBtn');
const cameraVideo = $('cameraVideo');
const cameraCanvas = $('cameraCanvas');
const cameraSystolic = $('cameraSystolic');
const cameraDiastolic = $('cameraDiastolic');

// Mic
const micSensorVisual = $('micSensorVisual');
const micBpmValue = $('micBpmValue');
const micBpmStatus = $('micBpmStatus');
const micBpmCard = $('micBpmCard');
const micZoneBadge = $('micZoneBadge');
const micHistoryBars = $('micHistoryBars');
const micStartBtn = $('micStartBtn');
const micSystolic = $('micSystolic');
const micDiastolic = $('micDiastolic');
const waveformCanvas = $('waveformCanvas');

// Upload
const uploadDropzone = $('uploadDropzone');
const uploadPickBtn = $('uploadPickBtn');
const videoFileInput = $('videoFileInput');
const uploadProgress = $('uploadProgress');
const progressFill = $('progressFill');
const progressPct = $('progressPct');
const progressLabel = $('progressLabel');
const uploadBpmValue = $('uploadBpmValue');
const uploadBpmStatus = $('uploadBpmStatus');
const uploadBpmCard = $('uploadBpmCard');
const uploadZoneBadge = $('uploadZoneBadge');
const uploadHistoryBars = $('uploadHistoryBars');
const uploadSystolic = $('uploadSystolic');
const uploadDiastolic = $('uploadDiastolic');

// Canvas context
const ctx2d = cameraCanvas.getContext('2d', { willReadFrequently: true });
const GAUGE_CIRC = 345; // 2π × 55

// ─────────────────────────────────────────────
// TAB SWITCHING
// ─────────────────────────────────────────────
let activeMode = 'camera';

function switchTab(mode) {
    if (mode === activeMode) return;
    if (activeMode === 'camera' && camState.measuring) stopCamera();
    if (activeMode === 'mic' && micState.measuring) stopMic();
    activeMode = mode;

    Object.keys(tabs).forEach(k => {
        const active = k === mode;
        tabs[k].classList.toggle('active', active);
        tabs[k].setAttribute('aria-selected', active);
        panels[k].classList.toggle('active', active);
    });
}

Object.keys(tabs).forEach(k => tabs[k].addEventListener('click', () => switchTab(k)));

// ═══════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════

function movingAvg(arr, w) {
    return arr.map((_, i) => {
        const sl = arr.slice(Math.max(0, i - w + 1), i + 1);
        return sl.reduce((a, b) => a + b, 0) / sl.length;
    });
}

function medianIBI(peakTimes) {
    if (peakTimes.length < 3) return null;
    const ibis = [];
    for (let i = 1; i < peakTimes.length; i++) ibis.push(peakTimes[i] - peakTimes[i - 1]);
    const valid = ibis.filter(v => v >= 280 && v <= 1600);
    if (valid.length < 2) return null;
    valid.sort((a, b) => a - b);
    return valid[Math.floor(valid.length / 2)];
}

/** Blood pressure estimate based on BPM zone (population averages, not diagnostic) */
function estimateBP(bpm) {
    if (bpm < 50) return { sys: 102, dia: 64 };
    if (bpm < 60) return { sys: 108, dia: 68 };
    if (bpm < 70) return { sys: 115, dia: 73 };
    if (bpm < 80) return { sys: 120, dia: 78 };
    if (bpm < 90) return { sys: 126, dia: 82 };
    if (bpm < 100) return { sys: 130, dia: 85 };
    if (bpm < 120) return { sys: 138, dia: 89 };
    return { sys: 145, dia: 93 };
}

function classifyZone(bpm) {
    if (bpm < 50) return 'Very Low';
    if (bpm < 60) return 'Low';
    if (bpm < 80) return 'Resting';
    if (bpm < 100) return 'Normal';
    if (bpm < 120) return 'Elevated';
    return 'High';
}

function setGauge(bpm) {
    // Map 40–180 BPM to 0–100% of gauge arc
    const pct = Math.min(Math.max((bpm - 40) / 140, 0), 1);
    cameraGauge.style.strokeDashoffset = GAUGE_CIRC - pct * GAUGE_CIRC;
}

function renderHistory(container, history, clr) {
    if (!history.length) { container.innerHTML = '<p class="history-empty">No readings yet</p>'; return; }
    const maxB = Math.max(...history, 100);
    const minB = Math.min(...history, 60);
    const range = maxB - minB || 40;
    container.innerHTML = '';
    history.forEach(bpm => {
        const hPx = Math.max(6, Math.round(((bpm - minB) / range) * 48 + 8));
        const wrap = document.createElement('div');
        wrap.className = 'bar-wrap';
        const bar = document.createElement('div');
        bar.className = 'bar';
        bar.style.height = hPx + 'px';
        bar.style.background = clr === 'red' ? 'linear-gradient(180deg, rgba(255,45,85,.85),  rgba(255,45,85,.25))' :
            clr === 'teal' ? 'linear-gradient(180deg, rgba(0,229,204,.85),  rgba(0,229,204,.25))' :
                'linear-gradient(180deg, rgba(74,144,255,.85), rgba(74,144,255,.25))';
        const lbl = document.createElement('span'); lbl.textContent = bpm;
        bar.appendChild(lbl); wrap.appendChild(bar); container.appendChild(wrap);
    });
}

// ═══════════════════════════════════════════════════
// 1. CAMERA + FLASH MODE
// ═══════════════════════════════════════════════════
const camState = {
    measuring: false, stream: null, loopId: null,
    redBuf: [], timestamps: [], peaks: [], history: [],
    lastPeak: 0,
};

cameraStartBtn.addEventListener('click', () => {
    if (camState.measuring) stopCamera(); else startCamera();
});

async function startCamera() {
    Object.assign(camState, { redBuf: [], timestamps: [], peaks: [], lastPeak: 0 });
    setCameraDisplay('--', 'Requesting camera permission…', '', false);
    setCameraBtn(true);

    let stream, torchGranted = false;

    // Step 1 — getUserMedia with torch in constraint (iOS path)
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { exact: 'environment' }, width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 30 }, advanced: [{ torch: true }] },
            audio: false,
        });
        torchGranted = true;
        console.log('[Cam] torch via getUserMedia ✔');
    } catch (e1) {
        console.warn('[Cam] torch in getUserMedia failed:', e1.message);
        // Step 2 — retry without torch
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { exact: 'environment' }, width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 30 } },
                audio: false,
            });
        } catch (e2) {
            setCameraBtn(false);
            if (e2.name === 'NotAllowedError') setCameraDisplay('--', '❌ Camera permission denied.', 'err', false);
            else if (e2.name === 'OverconstrainedError') { toast('Rear camera not found — trying any camera…'); retryCam(); }
            else setCameraDisplay('--', '❌ ' + e2.message, 'err', false);
            return;
        }
    }

    try {
        camState.stream = stream;
        cameraVideo.srcObject = stream;
        await cameraVideo.play();
        cameraCanvas.width = cameraVideo.videoWidth || 320;
        cameraCanvas.height = cameraVideo.videoHeight || 240;

        // Step 3 — applyConstraints fallback (Android)
        if (!torchGranted) {
            const [t] = stream.getVideoTracks();
            if (t?.applyConstraints) {
                try {
                    const caps = t.getCapabilities?.() ?? {};
                    if (caps.torch) { await t.applyConstraints({ advanced: [{ torch: true }] }); torchGranted = true; console.log('[Cam] torch via applyConstraints ✔'); }
                } catch { }
            }
            if (!torchGranted) {
                toast('💡 Flash unavailable in browser — turn on torch manually, then measure.');
                setCameraDisplay('--', '📡 Detecting pulse… (use manual torch)', 'warn', false);
            }
        }

        camState.measuring = true;
        cameraSensorVisual.classList.add('measuring');
        if (torchGranted) setCameraDisplay('--', '📡 Detecting pulse… keep finger still', '', false);
        camState.loopId = requestAnimationFrame(camLoop);
    } catch (e) {
        setCameraBtn(false);
        cameraSensorVisual.classList.remove('measuring');
        setCameraDisplay('--', '❌ ' + e.message, 'err', false);
    }
}

async function retryCam() {
    try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 30 } }, audio: false });
        camState.stream = s;
        cameraVideo.srcObject = s;
        await cameraVideo.play();
        cameraCanvas.width = cameraVideo.videoWidth || 320;
        cameraCanvas.height = cameraVideo.videoHeight || 240;
        camState.measuring = true;
        cameraSensorVisual.classList.add('measuring');
        setCameraDisplay('--', '📡 Detecting pulse… keep finger still', '', false);
        camState.loopId = requestAnimationFrame(camLoop);
    } catch { setCameraBtn(false); setCameraDisplay('--', '❌ Could not access any camera.', 'err', false); }
}

function stopCamera() {
    cancelAnimationFrame(camState.loopId);
    camState.stream?.getTracks().forEach(t => {
        try { t.applyConstraints({ advanced: [{ torch: false }] }); } catch { }
        t.stop();
    });
    camState.stream = null;
    cameraVideo.srcObject = null;
    camState.measuring = false;
    cameraSensorVisual.classList.remove('measuring');
    setCameraBtn(false);
    setCameraDisplay(cameraBpmValue.textContent, 'Stopped. Press Start to measure again.', '', false);
}

function camLoop() {
    if (!camState.measuring) return;
    try { ctx2d.drawImage(cameraVideo, 0, 0, cameraCanvas.width, cameraCanvas.height); } catch { camState.loopId = requestAnimationFrame(camLoop); return; }

    const cx = (cameraCanvas.width / 2) | 0;
    const cy = (cameraCanvas.height / 2) | 0;
    const SZ = 80;
    let imgData;
    try { imgData = ctx2d.getImageData(Math.max(0, cx - SZ / 2), Math.max(0, cy - SZ / 2), SZ, SZ); } catch { camState.loopId = requestAnimationFrame(camLoop); return; }

    const d = imgData.data;
    let rSum = 0;
    for (let i = 0; i < d.length; i += 4) rSum += d[i];
    const avgRed = rSum / (SZ * SZ);
    const now = performance.now();

    camState.redBuf.push(avgRed);
    camState.timestamps.push(now);
    if (camState.redBuf.length > 200) { camState.redBuf.shift(); camState.timestamps.shift(); }

    if (camState.redBuf.length >= 90) {
        const sm = movingAvg(camState.redBuf, 6);
        detectPeaks(sm, camState.timestamps, camState.peaks, camState, 'camera');
    }
    camState.loopId = requestAnimationFrame(camLoop);
}

// ═══════════════════════════════════════════════════
// 2. MIC MODE
// ═══════════════════════════════════════════════════
const micState = {
    measuring: false, stream: null, audioCtx: null,
    analyserNode: null, loopId: null,
    peaks: [], history: [], lastPeak: 0, rmsSamples: [],
};

// Waveform canvas
const wCtx = waveformCanvas.getContext('2d');
const WW = 360, WH = 64;
waveformCanvas.width = WW; waveformCanvas.height = WH;

micStartBtn.addEventListener('click', () => { if (micState.measuring) stopMic(); else startMic(); });

async function startMic() {
    Object.assign(micState, { stream: null, audioCtx: null, analyserNode: null, loopId: null, peaks: [], lastPeak: 0, rmsSamples: [] });
    setMicDisplay('--', 'Requesting microphone…', '', false);
    setMicBtn(true);

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        micState.stream = stream;

        const AC = window.AudioContext || window.webkitAudioContext;
        const audioCtx = new AC();
        micState.audioCtx = audioCtx;

        const src = audioCtx.createMediaStreamSource(stream);
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'lowpass'; filter.frequency.value = 50; filter.Q.value = 0.5;
        const gain = audioCtx.createGain();
        gain.gain.value = 20;
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.3;
        micState.analyserNode = analyser;

        src.connect(filter); filter.connect(gain); gain.connect(analyser);
        // NOT connected to destination — no speaker feedback

        micState.measuring = true;
        micSensorVisual.classList.add('measuring');
        setMicDisplay('--', '🎵 Listening for heartbeats…', '', false);
        micState.loopId = requestAnimationFrame(micLoop);
    } catch (e) {
        setMicBtn(false);
        micSensorVisual.classList.remove('measuring');
        if (e.name === 'NotAllowedError') { setMicDisplay('--', '❌ Microphone permission denied.', 'err', false); toast('Mic access denied.'); }
        else setMicDisplay('--', '❌ ' + e.message, 'err', false);
    }
}

function stopMic() {
    cancelAnimationFrame(micState.loopId);
    try { micState.audioCtx?.close(); } catch { }
    micState.stream?.getTracks().forEach(t => t.stop());
    micState.stream = null; micState.audioCtx = null; micState.measuring = false;
    micSensorVisual.classList.remove('measuring');
    setMicBtn(false);
    setMicDisplay(micBpmValue.textContent, 'Stopped. Press Start to measure again.', '', false);
    wCtx.clearRect(0, 0, WW, WH);
}

function micLoop() {
    if (!micState.measuring || !micState.analyserNode) return;

    const n = micState.analyserNode.frequencyBinCount;
    const td = new Float32Array(n);
    micState.analyserNode.getFloatTimeDomainData(td);
    drawWaveform(td);

    let ss = 0;
    for (let i = 0; i < td.length; i++) ss += td[i] ** 2;
    const rms = Math.sqrt(ss / td.length);
    const now = performance.now();

    micState.rmsSamples.push({ rms, t: now });
    micState.rmsSamples = micState.rmsSamples.filter(s => now - s.t < 3000);

    if (micState.rmsSamples.length > 15) {
        const vals = micState.rmsSamples.map(s => s.rms);
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const std = Math.sqrt(vals.map(v => (v - mean) ** 2).reduce((a, b) => a + b, 0) / vals.length);
        const thr = mean + 1.1 * std;

        if (rms > thr && rms > 0.0005 && now - micState.lastPeak > 300) {
            micState.peaks.push(now);
            micState.lastPeak = now;
            if (micState.peaks.length > 12) micState.peaks = micState.peaks.slice(-12);
        }

        computeMicBpm();
    }

    micState.loopId = requestAnimationFrame(micLoop);
}

function computeMicBpm() {
    const ibi = medianIBI(micState.peaks);
    if (!ibi) {
        const needed = Math.max(0, 3 - micState.peaks.length);
        setMicDisplay('--', `🎵 Listening… need ${needed} more beat${needed !== 1 ? 's' : ''}`, '', false);
        return;
    }
    const bpm = Math.round(60000 / ibi);
    if (bpm < 40 || bpm > 200) return;
    setMicDisplay(bpm, `✅ Heartbeat detected — ${classifyZone(bpm)}`, 'ok', true);
    micState.history.push(bpm);
    if (micState.history.length > 10) micState.history.shift();
    renderHistory(micHistoryBars, micState.history, 'teal');
}

function drawWaveform(td) {
    wCtx.clearRect(0, 0, WW, WH);
    wCtx.fillStyle = 'rgba(0,229,204,0.04)';
    wCtx.fillRect(0, 0, WW, WH);
    wCtx.lineWidth = 2; wCtx.strokeStyle = 'rgba(0,229,204,0.7)';
    wCtx.shadowColor = 'rgba(0,229,204,0.45)'; wCtx.shadowBlur = 6;
    wCtx.beginPath();
    const sw = WW / td.length;
    for (let i = 0; i < td.length; i++) {
        const y = ((td[i] + 1) / 2) * WH;
        i === 0 ? wCtx.moveTo(0, y) : wCtx.lineTo(i * sw, y);
    }
    wCtx.stroke(); wCtx.shadowBlur = 0;
}

// ═══════════════════════════════════════════════════
// 3. VIDEO UPLOAD MODE
// ═══════════════════════════════════════════════════
const uploadState = { history: [], analysing: false };

// File input triggers
uploadPickBtn.addEventListener('click', () => videoFileInput.click());
uploadDropzone.addEventListener('click', e => { if (e.target !== uploadPickBtn) videoFileInput.click(); });
videoFileInput.addEventListener('change', e => { if (e.target.files[0]) analyseVideo(e.target.files[0]); });

// Drag & drop
uploadDropzone.addEventListener('dragover', e => { e.preventDefault(); uploadDropzone.classList.add('drag-over'); });
uploadDropzone.addEventListener('dragleave', () => uploadDropzone.classList.remove('drag-over'));
uploadDropzone.addEventListener('drop', e => {
    e.preventDefault(); uploadDropzone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('video/')) analyseVideo(f);
    else toast('Please drop a video file.');
});

async function analyseVideo(file) {
    if (uploadState.analysing) return;
    uploadState.analysing = true;

    setUploadDisplay('--', `📹 Loading "${file.name}"…`, '', false);
    uploadProgress.classList.add('active');
    setProgress(0, 'Loading video…');

    const url = URL.createObjectURL(file);
    const vid = document.createElement('video');
    vid.src = url;
    vid.muted = true;
    vid.playsInline = true;
    vid.preload = 'auto';

    await new Promise((res, rej) => {
        vid.addEventListener('loadedmetadata', res, { once: true });
        vid.addEventListener('error', rej, { once: true });
        vid.load();
    });

    const duration = vid.duration;
    if (!isFinite(duration) || duration < 5) {
        toast('⚠️ Video too short — record at least 15 seconds.');
        endUpload(url); return;
    }

    const offCanvas = document.createElement('canvas');
    offCanvas.width = 320; offCanvas.height = 240;
    const offCtx = offCanvas.getContext('2d', { willReadFrequently: true });

    const redBuf = [], tsBuf = [];
    const peaks = []; let lastPeak = 0;
    let lastLogTime = -1;

    setProgress(0, 'Analysing frames…');

    vid.addEventListener('ended', () => { finaliseUpload(redBuf, tsBuf, url, duration); });
    vid.addEventListener('error', () => { toast('❌ Could not read video.'); endUpload(url); });

    // Throttle frame sampling to ~30fps equivalent based on video time
    const SAMPLE_INTERVAL_MS = 1000 / 30; // target: 30 samples/sec of video time

    function processFrame() {
        if (vid.paused || vid.ended) return;

        const vt = vid.currentTime;
        const progress = vt / duration;
        setProgress(progress, `Analysing… ${Math.round(progress * 100)}%`);

        try {
            offCtx.drawImage(vid, 0, 0, 320, 240);
            const SZ = 80;
            const imageData = offCtx.getImageData(120, 80, SZ, SZ);
            const data = imageData.data;
            let rSum = 0;
            for (let i = 0; i < data.length; i += 4) rSum += data[i];
            const avgRed = rSum / (SZ * SZ);
            redBuf.push(avgRed);
            tsBuf.push(vt * 1000); // convert to ms
        } catch { }

        requestAnimationFrame(processFrame);
    }

    try {
        await vid.play();
        requestAnimationFrame(processFrame);
    } catch (e) {
        toast('❌ Could not play video: ' + e.message);
        endUpload(url);
    }
}

function finaliseUpload(redBuf, tsBuf, url, duration) {
    setProgress(1, 'Computing BPM…');

    if (redBuf.length < 30) {
        setUploadDisplay('--', '⚠️ Not enough frames — try a longer video.', 'warn', false);
        endUpload(url); return;
    }

    const sm = movingAvg(redBuf, 6);
    const peaks = [];
    let lastPeak = 0;

    const n = sm.length;
    const recent = sm;
    const mean = recent.reduce((a, b) => a + b, 0) / n;
    const min = Math.min(...recent);
    const max = Math.max(...recent);
    const amp = max - min;

    if (amp < 1.5) {
        setUploadDisplay('--', '⚠️ Low signal. Was the flash on and finger covering the lens?', 'warn', false);
        endUpload(url); return;
    }

    const threshold = mean + amp * 0.3;

    for (let i = 1; i < n - 1; i++) {
        const prev = sm[i - 1], curr = sm[i], next = sm[i + 1];
        const t = tsBuf[i];
        if (curr > threshold && curr >= prev && curr >= next && t - lastPeak > 280) {
            peaks.push(t);
            lastPeak = t;
        }
    }

    const ibi = medianIBI(peaks);
    if (!ibi) {
        setUploadDisplay('--', '⚠️ Could not detect a clear heartbeat. Ensure the video has flash on and finger over lens.', 'warn', false);
        endUpload(url); return;
    }

    const bpm = Math.round(60000 / ibi);
    if (bpm < 35 || bpm > 220) {
        setUploadDisplay('--', '⚠️ Result out of range — please re-record and try again.', 'warn', false);
        endUpload(url); return;
    }

    setUploadDisplay(bpm, `✅ Analysis complete — ${classifyZone(bpm)}`, 'ok', true);
    uploadState.history.push(bpm);
    if (uploadState.history.length > 10) uploadState.history.shift();
    renderHistory(uploadHistoryBars, uploadState.history, 'blue');

    const bp = estimateBP(bpm);
    uploadSystolic.textContent = bp.sys;
    uploadDiastolic.textContent = bp.dia;

    endUpload(url);
}

function setProgress(frac, label) {
    const pct = Math.round(frac * 100);
    progressFill.style.width = pct + '%';
    progressPct.textContent = pct + '%';
    progressLabel.textContent = label;
}

function endUpload(url) {
    URL.revokeObjectURL(url);
    uploadState.analysing = false;
    setTimeout(() => uploadProgress.classList.remove('active'), 2000);
}

// ═══════════════════════════════════════════════════
// SHARED PEAK DETECTOR (camera live mode)
// ═══════════════════════════════════════════════════
function detectPeaks(smoothed, timestamps, peaks, state, mode) {
    const n = smoothed.length;
    const recent = smoothed.slice(-60);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const min = Math.min(...recent);
    const max = Math.max(...recent);
    const amp = max - min;

    if (amp < 1.5) {
        setCameraDisplay('--', '🔴 Low signal. Cover lens completely & stay still.', 'warn', false);
        return;
    }

    const thr = mean + amp * 0.3;
    const start = n - 60;

    for (let i = start + 1; i < n - 1; i++) {
        const curr = smoothed[i], t = timestamps[i];
        if (curr > thr && curr >= smoothed[i - 1] && curr >= smoothed[i + 1] && t - state.lastPeak > 280) {
            peaks.push(t);
            state.lastPeak = t;
        }
    }
    if (peaks.length > 14) peaks.splice(0, peaks.length - 14);

    const ibi = medianIBI(peaks);
    if (!ibi) {
        const need = Math.max(0, 3 - peaks.length);
        setCameraDisplay('--', `📡 Detecting… need ${need} more beat${need !== 1 ? 's' : ''}`, '', false);
        return;
    }
    const bpm = Math.round(60000 / ibi);
    if (bpm < 40 || bpm > 200) return;

    setCameraDisplay(bpm, `✅ Good signal — ${classifyZone(bpm)}`, 'ok', true);
    setGauge(bpm);
    camState.history = camState.history || [];
    camState.history.push(bpm);
    if (camState.history.length > 10) camState.history.shift();
    renderHistory(cameraHistoryBars, camState.history, 'red');
}

// ═══════════════════════════════════════════════════
// UI SETTERS
// ═══════════════════════════════════════════════════
function setCameraDisplay(bpm, status, statusCls, hasReading) {
    if (cameraBpmValue.textContent !== String(bpm)) {
        cameraBpmValue.textContent = bpm;
        if (bpm !== '--') { cameraBpmValue.classList.remove('pop'); void cameraBpmValue.offsetWidth; cameraBpmValue.classList.add('pop'); }
    }
    cameraBpmCard.classList.toggle('has-reading', hasReading);
    cameraBpmStatus.textContent = status;
    cameraBpmStatus.className = 'bpm-status' + (statusCls ? ' ' + statusCls : '');
    if (hasReading && bpm !== '--') {
        cameraZoneBadge.textContent = classifyZone(+bpm);
        cameraZoneBadge.classList.add('visible');
        const bp = estimateBP(+bpm);
        cameraSystolic.textContent = bp.sys;
        cameraDiastolic.textContent = bp.dia;
    }
}

function setMicDisplay(bpm, status, statusCls, hasReading) {
    if (micBpmValue.textContent !== String(bpm)) {
        micBpmValue.textContent = bpm;
        if (bpm !== '--') { micBpmValue.classList.remove('pop'); void micBpmValue.offsetWidth; micBpmValue.classList.add('pop'); }
    }
    micBpmCard.classList.toggle('has-reading', hasReading);
    micBpmStatus.textContent = status;
    micBpmStatus.className = 'bpm-status' + (statusCls ? ' ' + statusCls : '');
    if (hasReading && bpm !== '--') {
        micZoneBadge.textContent = classifyZone(+bpm);
        micZoneBadge.classList.add('visible');
        const bp = estimateBP(+bpm);
        micSystolic.textContent = bp.sys;
        micDiastolic.textContent = bp.dia;
    }
}

function setUploadDisplay(bpm, status, statusCls, hasReading) {
    if (uploadBpmValue.textContent !== String(bpm)) {
        uploadBpmValue.textContent = bpm;
        if (bpm !== '--') { uploadBpmValue.classList.remove('pop'); void uploadBpmValue.offsetWidth; uploadBpmValue.classList.add('pop'); }
    }
    uploadBpmCard.classList.toggle('has-reading', hasReading);
    uploadBpmStatus.textContent = status;
    uploadBpmStatus.className = 'bpm-status' + (statusCls ? ' ' + statusCls : '');
    if (hasReading && bpm !== '--') {
        uploadZoneBadge.textContent = classifyZone(+bpm);
        uploadZoneBadge.classList.add('visible');
    }
}

function setCameraBtn(measuring) {
    camState.measuring = measuring;
    cameraStartBtn.classList.toggle('measuring', measuring);
    cameraStartBtn.innerHTML = measuring
        ? '<span class="btn-icon">⏹</span>Stop Measuring'
        : '<span class="btn-icon">▶</span>Start Measuring';
}

function setMicBtn(measuring) {
    micState.measuring = measuring;
    micStartBtn.classList.toggle('measuring', measuring);
    micStartBtn.innerHTML = measuring
        ? '<span class="btn-icon">⏹</span>Stop Measuring'
        : '<span class="btn-icon">▶</span>Start Measuring';
}

// ─────────────────────────────────────────────
// CLEANUP ON BACKGROUND
// ─────────────────────────────────────────────
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        if (camState.measuring) stopCamera();
        if (micState.measuring) stopMic();
    }
});

console.log('[BPM Heart] Ready 💓');
