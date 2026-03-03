const tabCam = document.getElementById('tab-cam');
const tabMic = document.getElementById('tab-mic');
const startCamBtn = document.getElementById('start-cam-btn');
const startMicBtn = document.getElementById('start-mic-btn');
const stopBtn = document.getElementById('stop-btn');
const bpmDisplay = document.getElementById('bpm-display');
const healthStatus = document.getElementById('health-status');
const logText = document.getElementById('log-text');
const heartIcon = document.getElementById('heart-icon');
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

let mode = 'cam'; // 'cam' or 'mic'
let isRunning = false;
let currentStream = null;
let audioContext, analyser, animationId;
let bpms = [];
let lastBeatTime = 0;
let redValues = [];

// UI Switching
tabCam.addEventListener('click', () => switchMode('cam'));
tabMic.addEventListener('click', () => switchMode('mic'));

function switchMode(newMode) {
    if (isRunning) stopEverything();
    mode = newMode;
    tabCam.classList.toggle('active', mode === 'cam');
    tabMic.classList.toggle('active', mode === 'mic');
    startCamBtn.style.display = mode === 'cam' ? 'inline-block' : 'none';
    startMicBtn.style.display = mode === 'mic' ? 'inline-block' : 'none';
    resetUI();
}

function resetUI() {
    bpmDisplay.innerText = '--';
    bpmDisplay.style.color = 'white';
    healthStatus.style.display = 'none';
    logText.innerText = mode === 'cam' ? "Place finger on back camera." : "Press mic firmly to chest.";
    bpms = [];
    redValues = [];
    lastBeatTime = 0;
}

// Health Evaluator
function updateHealthStatus(bpm) {
    healthStatus.style.display = 'inline-block';
    if (bpm < 60) {
        healthStatus.innerText = "Resting / Low";
        healthStatus.style.backgroundColor = "rgba(173, 216, 230, 0.2)";
        healthStatus.style.color = "#add8e6";
        bpmDisplay.style.color = "#add8e6";
    } else if (bpm >= 60 && bpm <= 100) {
        healthStatus.innerText = "Normal / Good";
        healthStatus.style.backgroundColor = "rgba(144, 238, 144, 0.2)";
        healthStatus.style.color = "#90ee90";
        bpmDisplay.style.color = "#90ee90";
    } else if (bpm > 100 && bpm <= 140) {
        healthStatus.innerText = "Exercising / Active";
        healthStatus.style.backgroundColor = "rgba(255, 215, 0, 0.2)";
        healthStatus.style.color = "#ffd700";
        bpmDisplay.style.color = "#ffd700";
    } else {
        healthStatus.innerText = "Very High (Stop if not exercising!)";
        healthStatus.style.backgroundColor = "rgba(255, 75, 75, 0.2)";
        healthStatus.style.color = "#ff4b4b";
        bpmDisplay.style.color = "#ff4b4b";
    }
}

// Pulse Animation
function triggerBeat(bpm) {
    heartIcon.classList.add('beat');
    setTimeout(() => heartIcon.classList.remove('beat'), 150);
    bpms.push(bpm);
    if (bpms.length > 5) bpms.shift();
    const avgBpm = Math.round(bpms.reduce((a, b) => a + b) / bpms.length);
    bpmDisplay.innerText = avgBpm;
    updateHealthStatus(avgBpm);
}

// Stop everything
stopBtn.addEventListener('click', stopEverything);
function stopEverything() {
    isRunning = false;
    cancelAnimationFrame(animationId);
    if (currentStream) {
        currentStream.getTracks().forEach(track => track.stop());
    }
    if (audioContext) audioContext.close();
    startCamBtn.style.display = mode === 'cam' ? 'inline-block' : 'none';
    startMicBtn.style.display = mode === 'mic' ? 'inline-block' : 'none';
    stopBtn.style.display = 'none';
    resetUI();
}

// ==================== CAMERA METHOD ====================
startCamBtn.addEventListener('click', async () => {
    try {
        currentStream = await navigator.mediaDevices.getUserMedia({ 
            video: { facingMode: 'environment' } 
        });
        video.srcObject = currentStream;
        video.play();
        
        // Attempt to force the flash on natively
        const track = currentStream.getVideoTracks()[0];
        try {
            await track.applyConstraints({ advanced: [{ torch: true }] });
            logText.innerText = "Flashlight enabled! Reading pulse...";
        } catch (e) {
            logText.innerText = "Flashlight blocked by iOS. Hold near a bright light!";
        }

        isRunning = true;
        startCamBtn.style.display = 'none';
        stopBtn.style.display = 'inline-block';
        processCameraFrame();
    } catch (err) {
        logText.innerText = "Camera access denied.";
    }
});

function processCameraFrame() {
    if (!isRunning) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let redSum = 0;
    for (let i = 0; i < data.length; i += 4) redSum += data[i]; 
    
    redValues.push({ time: Date.now(), value: redSum / (data.length / 4) });
    if (redValues.length > 100) redValues.shift();

    if (redValues.length > 3) {
        const current = redValues[redValues.length - 2];
        const prev = redValues[redValues.length - 3];
        const next = redValues[redValues.length - 1];

        if (current.value > prev.value && current.value > next.value && current.value > 80) {
            const timeDiff = current.time - lastBeatTime;
            if (timeDiff > 333 && timeDiff < 1500) { // between 40 and 180 BPM
                triggerBeat(Math.round(60000 / timeDiff));
            }
            lastBeatTime = current.time;
        }
    }
    animationId = requestAnimationFrame(processCameraFrame);
}

// ==================== MIC METHOD ====================
startMicBtn.addEventListener('click', async () => {
    try {
        currentStream = await navigator.mediaDevices.getUserMedia({ 
            audio: { echoCancellation: false, noiseSuppression: false } 
        });
        
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioContext.createMediaStreamSource(currentStream);
        
        const filter = audioContext.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 100; // Only listen for deep bass thuds
        
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        
        source.connect(filter);
        filter.connect(analyser);
        
        isRunning = true;
        startMicBtn.style.display = 'none';
        stopBtn.style.display = 'inline-block';
        logText.innerText = "Listening... hold steady to avoid noise.";
        processMicAudio();
    } catch (err) {
        logText.innerText = "Microphone access denied.";
    }
});

function processMicAudio() {
    if (!isRunning) return;
    const dataArray = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatTimeDomainData(dataArray);

    let maxVol = 0;
    for (let i = 0; i < dataArray.length; i++) {
        if (Math.abs(dataArray[i]) > maxVol) maxVol = Math.abs(dataArray[i]);
    }

    const now = Date.now();
    const timeDiff = now - lastBeatTime;

    // Mic threshold set to 0.15 - adjust if it triggers on fabric noise
    if (maxVol > 0.15 && timeDiff > 333) { 
        if (lastBeatTime > 0) {
            const currentBpm = Math.round(60000 / timeDiff);
            if (currentBpm > 40 && currentBpm < 180) {
                triggerBeat(currentBpm);
            }
        }
        lastBeatTime = now;
    }
    animationId = requestAnimationFrame(processMicAudio);
}

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js');
}
