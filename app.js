/**
 * BPM Heart — app.js
 * 2-in-1 Heart Rate Monitor
 * Camera+Flash mode    → red channel peak detection
 * Microphone mode      → BiquadFilter + RMS spike detection
 */

'use strict';

// ─────────────────────────────────────────────
// PWA: Service Worker Registration
// ─────────────────────────────────────────────
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('[SW] Registered:', reg.scope))
            .catch(err => console.warn('[SW] Registration failed:', err));
    });
}

// ─────────────────────────────────────────────
// PWA: Install Banner
// ─────────────────────────────────────────────
let deferredInstallPrompt = null;
const installBanner = document.getElementById('installBanner');

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installBanner.classList.add('visible');
});

installBanner.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') installBanner.classList.remove('visible');
    deferredInstallPrompt = null;
});

window.addEventListener('appinstalled', () => {
    installBanner.classList.remove('visible');
    showToast('✅ App installed! You can now use it offline.');
});

// ─────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, duration = 3500) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ─────────────────────────────────────────────
// DOM ELEMENTS
// ─────────────────────────────────────────────

// Tabs
const cameraTab = document.getElementById('cameraTab');
const micTab = document.getElementById('micTab');
const cameraPanel = document.getElementById('cameraPanel');
const micPanel = document.getElementById('micPanel');

// Camera
const cameraSensorVisual = document.getElementById('cameraSensorVisual');
const cameraBpmValue = document.getElementById('cameraBpmValue');
const cameraBpmStatus = document.getElementById('cameraBpmStatus');
const cameraBpmCard = document.getElementById('cameraBpmCard');
const cameraHistoryBars = document.getElementById('cameraHistoryBars');
const cameraStartBtn = document.getElementById('cameraStartBtn');
const cameraVideo = document.getElementById('cameraVideo');
const cameraCanvas = document.getElementById('cameraCanvas');

// Mic
const micSensorVisual = document.getElementById('micSensorVisual');
const micBpmValue = document.getElementById('micBpmValue');
const micBpmStatus = document.getElementById('micBpmStatus');
const micBpmCard = document.getElementById('micBpmCard');
const micHistoryBars = document.getElementById('micHistoryBars');
const micStartBtn = document.getElementById('micStartBtn');
const waveformCanvas = document.getElementById('waveformCanvas');

// ─────────────────────────────────────────────
// TAB SWITCHING
// ─────────────────────────────────────────────
let activeMode = 'camera'; // 'camera' | 'mic'

function switchTab(mode) {
    if (mode === activeMode) return;

    // Stop current mode if measuring
    if (activeMode === 'camera' && cameraState.measuring) stopCamera();
    if (activeMode === 'mic' && micState.measuring) stopMic();

    activeMode = mode;

    cameraTab.classList.toggle('active', mode === 'camera');
    micTab.classList.toggle('active', mode === 'mic');
    cameraTab.setAttribute('aria-selected', mode === 'camera');
    micTab.setAttribute('aria-selected', mode === 'mic');

    cameraPanel.classList.toggle('active', mode === 'camera');
    micPanel.classList.toggle('active', mode === 'mic');
}

cameraTab.addEventListener('click', () => switchTab('camera'));
micTab.addEventListener('click', () => switchTab('mic'));

// ─────────────────────────────────────────────
// 1. CAMERA + FLASH MODE
// ─────────────────────────────────────────────

const cameraState = {
    measuring: false,
    stream: null,
    loopId: null,
    redBuffer: [],          // rolling buffer of avg red values
    timestamps: [],         // timestamps matching redBuffer
    peakTimes: [],          // timestamps of detected peaks
    bpmHistory: [],
    smoothed: [],
    bufferSize: 180,        // ~6 seconds at 30fps
    lastPeakTime: 0,
    dynamicThreshold: 128,
};

// Canvas context for pixel analysis
const ctx2d = cameraCanvas.getContext('2d', { willReadFrequently: true });

cameraStartBtn.addEventListener('click', () => {
    if (cameraState.measuring) stopCamera();
    else startCamera();
});

async function startCamera() {
    // Reset state
    Object.assign(cameraState, {
        redBuffer: [], timestamps: [], peakTimes: [],
        bpmHistory: [], smoothed: [], lastPeakTime: 0, dynamicThreshold: 128,
    });

    setCameraBpm('--');
    setCameraStatus('Requesting camera permission…', '');
    setCameraBtn(true);

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { exact: 'environment' },
                width: { ideal: 320 },
                height: { ideal: 240 },
                frameRate: { ideal: 30 },
            },
            audio: false,
        });

        cameraState.stream = stream;
        cameraVideo.srcObject = stream;
        await cameraVideo.play();

        cameraCanvas.width = cameraVideo.videoWidth || 320;
        cameraCanvas.height = cameraVideo.videoHeight || 240;

        // Enable torch (flashlight)
        const [track] = stream.getVideoTracks();
        if (track && 'applyConstraints' in track) {
            const caps = track.getCapabilities();
            if (caps && caps.torch) {
                await track.applyConstraints({ advanced: [{ torch: true }] });
                console.log('[Camera] Torch enabled ✔');
            } else {
                showToast('⚠️ Torch not supported on this device. Keep finger pressed firmly.');
            }
        }

        cameraState.measuring = true;
        cameraSensorVisual.classList.add('measuring');
        setCameraStatus('📡 Detecting pulse… keep finger still', '');
        cameraState.loopId = requestAnimationFrame(cameraLoop);

    } catch (err) {
        console.error('[Camera]', err);
        setCameraBtn(false);
        cameraSensorVisual.classList.remove('measuring');
        if (err.name === 'NotAllowedError') {
            setCameraStatus('❌ Camera permission denied. Enable it in settings.', 'err');
            showToast('Camera access denied.');
        } else if (err.name === 'OverconstrainedError') {
            // Retry without exact facingMode
            showToast('Rear camera not found – trying any camera…');
            retryCameraAnyFacing();
        } else {
            setCameraStatus('❌ Camera error: ' + err.message, 'err');
        }
    }
}

async function retryCameraAnyFacing() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 30 } },
            audio: false,
        });
        cameraState.stream = stream;
        cameraVideo.srcObject = stream;
        await cameraVideo.play();
        cameraCanvas.width = cameraVideo.videoWidth || 320;
        cameraCanvas.height = cameraVideo.videoHeight || 240;
        cameraState.measuring = true;
        cameraSensorVisual.classList.add('measuring');
        setCameraStatus('📡 Detecting pulse… keep finger still', '');
        cameraState.loopId = requestAnimationFrame(cameraLoop);
    } catch (err) {
        setCameraBtn(false);
        setCameraStatus('❌ Could not access any camera.', 'err');
    }
}

function stopCamera() {
    cancelAnimationFrame(cameraState.loopId);
    if (cameraState.stream) {
        cameraState.stream.getTracks().forEach(t => {
            // Turn off torch before stopping
            if ('applyConstraints' in t) {
                try { t.applyConstraints({ advanced: [{ torch: false }] }); } catch { }
            }
            t.stop();
        });
        cameraState.stream = null;
    }
    cameraVideo.srcObject = null;
    cameraState.measuring = false;
    cameraSensorVisual.classList.remove('measuring');
    setCameraBtn(false);
    setCameraStatus('Stopped. Press Start to measure again.', '');
}

function cameraLoop() {
    if (!cameraState.measuring) return;

    // Draw frame to canvas and read pixels
    try {
        ctx2d.drawImage(cameraVideo, 0, 0, cameraCanvas.width, cameraCanvas.height);
    } catch {
        cameraState.loopId = requestAnimationFrame(cameraLoop);
        return;
    }

    // Sample center 60×60 px region for accuracy
    const cx = Math.floor(cameraCanvas.width / 2);
    const cy = Math.floor(cameraCanvas.height / 2);
    const size = 60;
    const x0 = Math.max(0, cx - size / 2);
    const y0 = Math.max(0, cy - size / 2);

    let imageData;
    try {
        imageData = ctx2d.getImageData(x0, y0, size, size);
    } catch {
        cameraState.loopId = requestAnimationFrame(cameraLoop);
        return;
    }

    const data = imageData.data;
    let redSum = 0;
    const pixelCount = size * size;

    for (let i = 0; i < data.length; i += 4) {
        redSum += data[i]; // R channel
    }

    const avgRed = redSum / pixelCount;
    const now = performance.now();

    cameraState.redBuffer.push(avgRed);
    cameraState.timestamps.push(now);

    // Keep buffer capped
    if (cameraState.redBuffer.length > cameraState.bufferSize) {
        cameraState.redBuffer.shift();
        cameraState.timestamps.shift();
    }

    // Apply smoothing (moving average over 5 samples)
    const MA = 5;
    cameraState.smoothed = smoothMovingAverage(cameraState.redBuffer, MA);

    // Need at least 90 frames (~3s) before peak detection
    if (cameraState.smoothed.length >= 90) {
        detectCameraPeaks(cameraState.smoothed, cameraState.timestamps);
    }

    cameraState.loopId = requestAnimationFrame(cameraLoop);
}

function smoothMovingAverage(arr, window) {
    const out = [];
    for (let i = 0; i < arr.length; i++) {
        const start = Math.max(0, i - window + 1);
        const slice = arr.slice(start, i + 1);
        out.push(slice.reduce((a, b) => a + b, 0) / slice.length);
    }
    return out;
}

function detectCameraPeaks(smoothed, timestamps) {
    // Dynamic threshold: mean + fraction of amplitude
    const n = smoothed.length;
    const recent = smoothed.slice(-60); // look at last 2s
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const min = Math.min(...recent);
    const max = Math.max(...recent);
    const amp = max - min;

    // Require a meaningful signal (not just noise or covered lens)
    if (amp < 2) {
        setCameraStatus('🔴 Low signal. Cover lens completely & stay still.', 'warn');
        return;
    }

    const threshold = mean + amp * 0.35;

    // Find peaks in the last 60 frames
    const searchStart = n - 60;
    for (let i = searchStart + 1; i < n - 1; i++) {
        const prev = smoothed[i - 1];
        const curr = smoothed[i];
        const next = smoothed[i + 1];
        const t = timestamps[i];

        if (curr > threshold && curr >= prev && curr >= next) {
            // Enforce refractory period: min 300ms between peaks (~200 BPM max)
            if (t - cameraState.lastPeakTime > 300) {
                cameraState.peakTimes.push(t);
                cameraState.lastPeakTime = t;
            }
        }
    }

    // Trim peak history to last 10
    if (cameraState.peakTimes.length > 12) {
        cameraState.peakTimes = cameraState.peakTimes.slice(-12);
    }

    updateCameraBpm();
}

function updateCameraBpm() {
    const pts = cameraState.peakTimes;
    if (pts.length < 3) {
        const needed = 3 - pts.length;
        setCameraStatus(`📡 Detecting pulse… need ${needed} more beat${needed > 1 ? 's' : ''}`, '');
        return;
    }

    // Compute inter-beat intervals
    const ibis = [];
    for (let i = 1; i < pts.length; i++) {
        ibis.push(pts[i] - pts[i - 1]);
    }

    // Filter out physiologically implausible IBIs (300ms – 1500ms = 40-200 BPM)
    const validIbis = ibis.filter(ibi => ibi >= 300 && ibi <= 1500);
    if (validIbis.length < 2) return;

    // Use median for robustness against outliers
    validIbis.sort((a, b) => a - b);
    const medianIbi = validIbis[Math.floor(validIbis.length / 2)];
    const bpm = Math.round(60000 / medianIbi);

    if (bpm < 40 || bpm > 200) return;

    setCameraBpm(bpm);
    setCameraStatus(`✅ Good signal — ${classifyBpm(bpm)}`, 'ok');

    // Record to history
    cameraState.bpmHistory.push(bpm);
    if (cameraState.bpmHistory.length > 10) cameraState.bpmHistory.shift();
    renderHistory(cameraHistoryBars, cameraState.bpmHistory, 'red');
}

// ─────────────────────────────────────────────
// 2. MICROPHONE MODE
// ─────────────────────────────────────────────

const micState = {
    measuring: false,
    stream: null,
    audioCtx: null,
    sourceNode: null,
    filterNode: null,
    analyserNode: null,
    loopId: null,
    peakTimes: [],
    bpmHistory: [],
    lastPeakTime: 0,
    rmsSamples: [],
    rmsWindow: 30,
};

// Waveform canvas
const wCtx = waveformCanvas.getContext('2d');
const WW = 360, WH = 70;
waveformCanvas.width = WW;
waveformCanvas.height = WH;

micStartBtn.addEventListener('click', () => {
    if (micState.measuring) stopMic();
    else startMic();
});

async function startMic() {
    Object.assign(micState, {
        stream: null, audioCtx: null, sourceNode: null,
        filterNode: null, analyserNode: null, loopId: null,
        peakTimes: [], bpmHistory: [], lastPeakTime: 0,
        rmsSamples: [],
    });

    setMicBpm('--');
    setMicStatus('Requesting microphone permission…', '');
    setMicBtn(true);

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
            }
        });

        micState.stream = stream;

        // Build Web Audio graph:
        // MediaStreamSource → BiquadFilter (lowpass 100Hz) → Analyser → destination(muted)
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        const audioCtx = new AudioContext();
        micState.audioCtx = audioCtx;

        const sourceNode = audioCtx.createMediaStreamSource(stream);
        micState.sourceNode = sourceNode;

        // Lowpass filter: cuts everything above 100Hz, keeping only the heartbeat thud
        const filterNode = audioCtx.createBiquadFilter();
        filterNode.type = 'lowpass';
        filterNode.frequency.value = 100;
        filterNode.Q.value = 0.7;
        micState.filterNode = filterNode;

        // Analyser
        const analyserNode = audioCtx.createAnalyser();
        analyserNode.fftSize = 512;
        analyserNode.smoothingTimeConstant = 0.4;
        micState.analyserNode = analyserNode;

        // Connect: source → filter → analyser (not connected to output = silent)
        sourceNode.connect(filterNode);
        filterNode.connect(analyserNode);
        // analyserNode intentionally NOT connected to audioCtx.destination (no speaker feedback)

        micState.measuring = true;
        micSensorVisual.classList.add('measuring');
        setMicStatus('🎵 Listening for heartbeats…', '');
        micState.loopId = requestAnimationFrame(micLoop);

    } catch (err) {
        console.error('[Mic]', err);
        setMicBtn(false);
        micSensorVisual.classList.remove('measuring');
        if (err.name === 'NotAllowedError') {
            setMicStatus('❌ Microphone permission denied.', 'err');
            showToast('Microphone access denied.');
        } else {
            setMicStatus('❌ Mic error: ' + err.message, 'err');
        }
    }
}

function stopMic() {
    cancelAnimationFrame(micState.loopId);
    if (micState.audioCtx) { try { micState.audioCtx.close(); } catch { } }
    if (micState.stream) { micState.stream.getTracks().forEach(t => t.stop()); }
    micState.stream = null;
    micState.audioCtx = null;
    micState.measuring = false;
    micSensorVisual.classList.remove('measuring');
    setMicBtn(false);
    setMicStatus('Stopped. Press Start to measure again.', '');
    clearWaveform();
}

function micLoop() {
    if (!micState.measuring || !micState.analyserNode) return;

    const bufferLen = micState.analyserNode.frequencyBinCount;
    const timeDomain = new Float32Array(bufferLen);
    micState.analyserNode.getFloatTimeDomainData(timeDomain);

    // Draw waveform
    drawWaveform(timeDomain);

    // Compute RMS
    let sumSquares = 0;
    for (let i = 0; i < timeDomain.length; i++) sumSquares += timeDomain[i] ** 2;
    const rms = Math.sqrt(sumSquares / timeDomain.length);

    const now = performance.now();
    micState.rmsSamples.push({ rms, t: now });

    // Keep ~3s of RMS history
    const window3s = micState.rmsSamples.filter(s => now - s.t < 3000);
    micState.rmsSamples = window3s;

    // Dynamic threshold: mean + 1.5 * std of recent RMS
    if (micState.rmsSamples.length > 15) {
        const rmsValues = micState.rmsSamples.map(s => s.rms);
        const mean = rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length;
        const std = Math.sqrt(rmsValues.map(v => (v - mean) ** 2).reduce((a, b) => a + b, 0) / rmsValues.length);
        const threshold = mean + 1.5 * std;

        // Detect spike (heartbeat thud)
        if (rms > threshold && rms > 0.003) {
            // Refractory period: min 300ms
            if (now - micState.lastPeakTime > 300) {
                micState.peakTimes.push(now);
                micState.lastPeakTime = now;
            }
        }

        // Trim peak history
        if (micState.peakTimes.length > 12) {
            micState.peakTimes = micState.peakTimes.slice(-12);
        }

        updateMicBpm();
    }

    micState.loopId = requestAnimationFrame(micLoop);
}

function updateMicBpm() {
    const pts = micState.peakTimes;
    if (pts.length < 3) {
        const needed = 3 - pts.length;
        setMicStatus(`🎵 Listening… need ${needed} more beat${needed > 1 ? 's' : ''}`, '');
        return;
    }

    const ibis = [];
    for (let i = 1; i < pts.length; i++) ibis.push(pts[i] - pts[i - 1]);

    const validIbis = ibis.filter(ibi => ibi >= 300 && ibi <= 1500);
    if (validIbis.length < 2) return;

    validIbis.sort((a, b) => a - b);
    const medianIbi = validIbis[Math.floor(validIbis.length / 2)];
    const bpm = Math.round(60000 / medianIbi);

    if (bpm < 40 || bpm > 200) return;

    setMicBpm(bpm);
    setMicStatus(`✅ Heartbeat detected — ${classifyBpm(bpm)}`, 'ok');

    micState.bpmHistory.push(bpm);
    if (micState.bpmHistory.length > 10) micState.bpmHistory.shift();
    renderHistory(micHistoryBars, micState.bpmHistory, 'teal');
}

// ─────────────────────────────────────────────
// WAVEFORM CANVAS
// ─────────────────────────────────────────────
function drawWaveform(timeDomain) {
    wCtx.clearRect(0, 0, WW, WH);
    wCtx.fillStyle = 'rgba(0,212,170,0.05)';
    wCtx.fillRect(0, 0, WW, WH);

    wCtx.lineWidth = 2;
    wCtx.strokeStyle = 'rgba(0,212,170,0.75)';
    wCtx.shadowColor = 'rgba(0,212,170,0.5)';
    wCtx.shadowBlur = 6;

    wCtx.beginPath();
    const sliceW = WW / timeDomain.length;
    for (let i = 0; i < timeDomain.length; i++) {
        const v = (timeDomain[i] + 1) / 2;
        const x = i * sliceW;
        const y = v * WH;
        if (i === 0) wCtx.moveTo(x, y);
        else wCtx.lineTo(x, y);
    }
    wCtx.stroke();
    wCtx.shadowBlur = 0;
}

function clearWaveform() {
    wCtx.clearRect(0, 0, WW, WH);
}

// ─────────────────────────────────────────────
// HISTORY BARS
// ─────────────────────────────────────────────
function renderHistory(container, history, modeColor) {
    if (!history.length) {
        container.innerHTML = '<p class="history-empty">No readings yet</p>';
        return;
    }

    const maxBpm = Math.max(...history, 100);
    const minBpm = Math.min(...history, 60);
    const range = maxBpm - minBpm || 40;

    container.innerHTML = '';
    history.forEach((bpm) => {
        const heightPct = ((bpm - minBpm) / range) * 70 + 10; // 10%-80% of 60px
        const heightPx = Math.round((heightPct / 100) * 60);

        const wrap = document.createElement('div');
        wrap.className = 'bar-wrap';

        const bar = document.createElement('div');
        bar.className = 'bar';
        bar.style.height = heightPx + 'px';
        bar.style.background = modeColor === 'red'
            ? 'linear-gradient(180deg, rgba(255,58,92,0.8), rgba(255,58,92,0.3))'
            : 'linear-gradient(180deg, rgba(0,212,170,0.8), rgba(0,212,170,0.3))';

        const label = document.createElement('span');
        label.textContent = bpm;
        bar.appendChild(label);
        wrap.appendChild(bar);
        container.appendChild(wrap);
    });
}

// ─────────────────────────────────────────────
// BPM CLASSIFICATION
// ─────────────────────────────────────────────
function classifyBpm(bpm) {
    if (bpm < 60) return 'Bradycardia (low)';
    if (bpm < 80) return 'Resting / Calm';
    if (bpm < 100) return 'Normal range';
    if (bpm < 120) return 'Slightly elevated';
    return 'Elevated / Active';
}

// ─────────────────────────────────────────────
// UI HELPERS — CAMERA
// ─────────────────────────────────────────────
let lastCameraBpm = null;
function setCameraBpm(val) {
    if (val === lastCameraBpm) return;
    lastCameraBpm = val;
    cameraBpmValue.textContent = val;
    cameraBpmCard.classList.toggle('has-reading', val !== '--');
    if (val !== '--') {
        cameraBpmValue.classList.remove('pulse-anim');
        void cameraBpmValue.offsetWidth; // force reflow
        cameraBpmValue.classList.add('pulse-anim');
    }
}

function setCameraStatus(msg, cls = '') {
    cameraBpmStatus.textContent = msg;
    cameraBpmStatus.className = 'bpm-status ' + cls;
}

function setCameraBtn(measuring) {
    cameraState.measuring = measuring;
    cameraStartBtn.classList.toggle('measuring', measuring);
    cameraStartBtn.innerHTML = measuring
        ? '<span class="btn-icon" aria-hidden="true">⏹</span>Stop Measuring'
        : '<span class="btn-icon" aria-hidden="true">▶</span>Start Measuring';
}

// ─────────────────────────────────────────────
// UI HELPERS — MIC
// ─────────────────────────────────────────────
let lastMicBpm = null;
function setMicBpm(val) {
    if (val === lastMicBpm) return;
    lastMicBpm = val;
    micBpmValue.textContent = val;
    micBpmCard.classList.toggle('has-reading', val !== '--');
    if (val !== '--') {
        micBpmValue.classList.remove('pulse-anim');
        void micBpmValue.offsetWidth;
        micBpmValue.classList.add('pulse-anim');
    }
}

function setMicStatus(msg, cls = '') {
    micBpmStatus.textContent = msg;
    micBpmStatus.className = 'bpm-status ' + cls;
}

function setMicBtn(measuring) {
    micState.measuring = measuring;
    micStartBtn.classList.toggle('measuring', measuring);
    micStartBtn.innerHTML = measuring
        ? '<span class="btn-icon" aria-hidden="true">⏹</span>Stop Measuring'
        : '<span class="btn-icon" aria-hidden="true">▶</span>Start Measuring';
}

// ─────────────────────────────────────────────
// CLEANUP ON PAGE HIDE (e.g. background tab)
// ─────────────────────────────────────────────
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        if (cameraState.measuring) stopCamera();
        if (micState.measuring) stopMic();
    }
});

console.log('[BPM Heart] App ready 💓');
