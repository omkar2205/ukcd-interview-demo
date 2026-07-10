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

    // Audio mixing: combine applicant mic + interviewer TTS into one recorded stream
    this.audioContext = null;
    this.mixedDestination = null;
    this.micSource = null;
    this.recordingStream = null;
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

  /**
   * Sets up the Web Audio mixing graph so both the applicant's microphone
   * and the interviewer's TTS audio are recorded into a single stream.
   */
  _setupAudioMixing() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        this.debug('AudioContext not available; recording mic only');
        return;
      }

      this.audioContext = new AudioCtx();
      // Create a destination node whose stream we'll record from
      this.mixedDestination = this.audioContext.createMediaStreamDestination();

      // Connect the applicant's microphone to the mix
      if (this.stream && this.stream.getAudioTracks().length > 0) {
        this.micSource = this.audioContext.createMediaStreamSource(this.stream);
        this.micSource.connect(this.mixedDestination);
        this.debug('Mic audio connected to recording mix');
      }

      // Build the recording stream: video tracks from camera + mixed audio track
      this.recordingStream = new MediaStream();
      // Add video tracks from the original camera stream
      this.stream.getVideoTracks().forEach((track) => {
        this.recordingStream.addTrack(track);
      });
      // Add the mixed audio track (mic + any TTS routed through routeAudioElement)
      this.mixedDestination.stream.getAudioTracks().forEach((track) => {
        this.recordingStream.addTrack(track);
      });

      this.debug('Audio mixing setup complete', {
        videoTracks: this.recordingStream.getVideoTracks().length,
        audioTracks: this.recordingStream.getAudioTracks().length
      });
    } catch (error) {
      this.debug('Audio mixing setup failed; falling back to mic-only', error.message);
      this.recordingStream = null;
    }
  }

  /**
   * Route an Audio element (e.g. TTS playback) through the recording mix
   * so the interviewer's voice is captured in the final video.
   * The audio still plays through speakers as normal.
   */
  routeAudioElement(audioElement) {
    if (!this.audioContext || !this.mixedDestination) {
      this.debug('Audio mixing not available; TTS will not be in recording');
      return;
    }

    try {
      const source = this.audioContext.createMediaElementSource(audioElement);
      // Connect to the mixed destination (for recording)
      source.connect(this.mixedDestination);
      // Also connect to speakers so the applicant can hear it
      source.connect(this.audioContext.destination);
      this.debug('TTS audio routed to recording mix and speakers');
    } catch (error) {
      this.debug('Could not route TTS audio to recording', error.message);
    }
  }

  start() {
    if (!window.MediaRecorder) throw new Error('Recording is not supported in this browser.');
    if (!this.stream) throw new Error('Camera and microphone are not ready.');

    // Set up audio mixing so interviewer voice is captured
    this._setupAudioMixing();

    // Record from the mixed stream (mic + TTS) if available, otherwise fall back to camera stream
    const streamToRecord = this.recordingStream || this.stream;

    const mimeType = pickRecordingType();
    const options = {
      videoBitsPerSecond: 1200000,
      audioBitsPerSecond: 128000
    };
    if (mimeType) options.mimeType = mimeType;

    this.chunks = [];
    this.totalBytes = 0;
    this.recorder = new MediaRecorder(streamToRecord, options);

    this.recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size <= 0) return;
      this.chunks.push(event.data);
      this.totalBytes += event.data.size;
      this.debug('Recorder chunk captured', { bytes: event.data.size, totalBytes: this.totalBytes });
    };

    this.recorder.onerror = (event) => this.debug('Recorder warning', event.error || event);
    this.recorder.start(1000);
    this.watchdog = window.setInterval(() => this.requestData(), 2500);
    this.debug('Recording started', {
      mimeType: this.recorder.mimeType || mimeType || 'default',
      mixedAudio: !!this.recordingStream
    });
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

    // Clean up audio mixing
    try { if (this.micSource) this.micSource.disconnect(); } catch (e) {}
    this.micSource = null;

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch((e) => this.debug('AudioContext close warning', e.message));
    }
    this.audioContext = null;
    this.mixedDestination = null;
    this.recordingStream = null;

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
