const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const bpmDisplay = document.getElementById('bpm-display');
const startBtn = document.getElementById('start-btn');

let isPlaying = false;
let redValues = [];
let lastBeatTime = 0;
let bpms = [];

startBtn.addEventListener('click', async () => {
    if (isPlaying) return;
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        video.srcObject = stream;
        video.play();
        isPlaying = true;
        startBtn.innerText = "Reading Pulse...";
        requestAnimationFrame(processFrame);
    } catch (err) {
        alert("Camera access denied. Please allow camera permissions.");
    }
});

function processFrame() {
    if (!isPlaying) return;

    // Draw the current video frame to a tiny canvas to extract pixel data
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = frame.data;

    let redSum = 0;
    // Loop through pixels to isolate the red channel
    for (let i = 0; i < data.length; i += 4) {
        redSum += data[i]; 
    }
    
    // Calculate the average redness of the frame
    const avgRed = redSum / (data.length / 4);
    redValues.push({ time: Date.now(), value: avgRed });

    // Keep the array size manageable (approx last few seconds of frames)
    if (redValues.length > 100) redValues.shift();

    detectBeat();
    requestAnimationFrame(processFrame);
}

function detectBeat() {
    if (redValues.length < 3) return;

    const current = redValues[redValues.length - 2];
    const previous = redValues[redValues.length - 3];
    const next = redValues[redValues.length - 1];

    // Peak detection: check if the current frame is redder than the frames right before and after it
    if (current.value > previous.value && current.value > next.value && current.value > 100) {
        const timeSinceLastBeat = current.time - lastBeatTime;

        // Filter out impossible human heart rates (faster than 180 BPM or slower than 40 BPM)
        if (timeSinceLastBeat > 333 && timeSinceLastBeat < 1500) {
            const currentBpm = Math.round(60000 / timeSinceLastBeat);
            bpms.push(currentBpm);
            
            // Average the last 5 readings for a smoother display
            if (bpms.length > 5) bpms.shift(); 
            const avgBpm = Math.round(bpms.reduce((a, b) => a + b) / bpms.length);
            
            bpmDisplay.innerText = `${avgBpm} BPM`;
        }
        lastBeatTime = current.time;
    }
}

// Register Service Worker for PWA installation
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js');
}
