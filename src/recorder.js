import { dataUrlPayload } from './api.js';

const RECORDING_TYPES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=h264,aac',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm'
];

export class ApplicantRecorder {
  constructor(debug = () => {}) {
    this.debug = debug;
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.totalBytes = 0;
    this.watchdog = null;
    this.monitor = null;
  }

  async requestMedia() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser cannot access camera and microphone devices.');
    }

    this.stopTracks();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 24, max: 30 },
        facingMode: 'user'
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    this.monitor = createMicrophoneMonitor(this.stream, this.debug);
    return this.stream;
  }

  attachPreview(videoElement) {
    if (!videoElement || !this.stream) return;
    videoElement.srcObject = this.stream;
    videoElement.muted = true;
    videoElement.playsInline = true;
    videoElement.play().catch((error) => this.debug('Preview play warning', error.message));
  }

  getReadiness() {
    return {
      camera: !!this.stream && this.stream.getVideoTracks().some((track) => track.readyState === 'live'),
      microphone: !!this.stream && this.stream.getAudioTracks().some((track) => track.readyState === 'live')
    };
  }

  start() {
    if (!window.MediaRecorder) throw new Error('Recording is not supported in this browser.');
    if (!this.stream) throw new Error('Camera and microphone are not ready.');

    // Record only the applicant camera and microphone stream.
    // Interviewer playback stays separate and is not mixed into the saved video.
    const mimeType = pickRecordingType();
    const options = {
      videoBitsPerSecond: 1200000,
      audioBitsPerSecond: 128000
    };
    if (mimeType) options.mimeType = mimeType;

    this.chunks = [];
    this.totalBytes = 0;
    this.recorder = new MediaRecorder(this.stream, options);

    this.recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size <= 0) return;
      this.chunks.push(event.data);
      this.totalBytes += event.data.size;
      this.debug('Recorder chunk captured', { bytes: event.data.size, totalBytes: this.totalBytes });
    };

    this.recorder.onerror = (event) => this.debug('Recorder warning', event.error || event);
    this.recorder.start(1000);
    this.watchdog = window.setInterval(() => this.requestData(), 2500);
    this.debug('Recording started', { mimeType: this.recorder.mimeType || mimeType || 'default' });
  }

  requestData() {
    try {
      if (this.recorder && this.recorder.state === 'recording') this.recorder.requestData();
    } catch (error) {
      this.debug('Recorder data request warning', error.message);
    }
  }

  async stop() {
    if (this.watchdog) window.clearInterval(this.watchdog);
    this.watchdog = null;

    const recorder = this.recorder;
    if (!recorder) {
      this.stopTracks();
      return new Blob([], { type: 'video/webm' });
    }

    const blob = await new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        window.setTimeout(() => {
          const type = recorder.mimeType || pickRecordingType() || 'video/webm';
          resolve(new Blob(this.chunks, { type }));
        }, 450);
      };

      recorder.addEventListener('stop', finish, { once: true });
      try {
        if (recorder.state === 'recording') {
          recorder.requestData();
          window.setTimeout(() => {
            try {
              if (recorder.state !== 'inactive') recorder.stop();
              else finish();
            } catch (error) {
              this.debug('Recorder stop warning', error.message);
              finish();
            }
          }, 900);
        } else {
          finish();
        }
      } catch (error) {
        this.debug('Recorder finalisation warning', error.message);
        finish();
      }
    });

    this.stopTracks();
    this.debug('Recording finalised', { size: blob.size, type: blob.type, chunks: this.chunks.length });
    return blob;
  }

  getVoiceLevel() {
    return this.monitor ? this.monitor.getLevel() : 0;
  }

  stopTracks() {
    if (this.monitor) this.monitor.stop();
    this.monitor = null;
    if (this.stream) this.stream.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }
}

export async function blobToUploadPack(blob) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

  return {
    encoded: dataUrlPayload(dataUrl),
    prefix: dataUrl.slice(0, Math.min(100, dataUrl.length))
  };
}

export function normaliseVideoMimeType(mimeType) {
  const value = String(mimeType || '').toLowerCase();
  if (value.includes('mp4')) return 'video/mp4';
  if (value.includes('webm')) return 'video/webm';
  return 'application/octet-stream';
}

function pickRecordingType() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  return RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function createMicrophoneMonitor(stream, debug) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;

  try {
    // This lightweight level meter lets the interview move on after speech and silence,
    // even in browsers where live speech recognition is unavailable.
    const context = new AudioContextClass();
    const analyser = context.createAnalyser();
    const source = context.createMediaStreamSource(stream);
    const buffer = new Uint8Array(analyser.fftSize);
    analyser.fftSize = 2048;
    source.connect(analyser);

    return {
      getLevel() {
        analyser.getByteTimeDomainData(buffer);
        let total = 0;
        for (let i = 0; i < buffer.length; i += 1) {
          const sample = (buffer[i] - 128) / 128;
          total += sample * sample;
        }
        return Math.sqrt(total / buffer.length);
      },
      stop() {
        try { source.disconnect(); } catch (error) {}
        if (context.state !== 'closed') context.close().catch((error) => debug('Audio monitor close warning', error.message));
      }
    };
  } catch (error) {
    debug('Audio monitor unavailable', error.message);
    return null;
  }
}
