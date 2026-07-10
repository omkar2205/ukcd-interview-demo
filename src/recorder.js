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

    // Audio mixing state
    this.audioContext = null;
    this.mixedDestination = null;
    this.micSource = null;
    this.recordingStream = null;
    this._currentBufferSource = null;
    this._currentAudioElement = null;
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

  /* ────────────────────────────────────────────────────
   * Audio mixing: merge applicant mic + TTS into one
   * audio track so both appear in the final recording.
   * ──────────────────────────────────────────────────── */

  _setupAudioMixing() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        this.debug('[MIX] AudioContext not available — mic-only recording');
        return;
      }

      this.audioContext = new AudioCtx();
      this.mixedDestination = this.audioContext.createMediaStreamDestination();

      // Pipe applicant mic into the mix
      if (this.stream && this.stream.getAudioTracks().length > 0) {
        this.micSource = this.audioContext.createMediaStreamSource(this.stream);
        this.micSource.connect(this.mixedDestination);
        this.debug('[MIX] Mic connected to mix destination');
      }

      // Build recording stream: camera video + mixed audio
      const videoTracks = this.stream.getVideoTracks();
      const mixedAudioTracks = this.mixedDestination.stream.getAudioTracks();
      this.recordingStream = new MediaStream([...videoTracks, ...mixedAudioTracks]);

      this.debug('[MIX] Setup complete', {
        ctxState: this.audioContext.state,
        ctxSampleRate: this.audioContext.sampleRate,
        videoTracks: videoTracks.length,
        mixedAudioTracks: mixedAudioTracks.length
      });
    } catch (error) {
      this.debug('[MIX] Setup FAILED — mic-only recording', error.message);
      this.recordingStream = null;
    }
  }

  /* ────────────────────────────────────────────────────
   * Play TTS audio through speakers AND capture it in
   * the recording.
   *
   * Strategy:
   *  1. ALWAYS play via Audio element (reliable speakers)
   *  2. TRY to also decode the same data and feed a
   *     silent AudioBufferSourceNode into the mix
   *     (recording capture — no double-speaker output)
   *  3. If decode fails, TRY captureStream() on the
   *     Audio element and pipe that into the mix
   *  4. If everything fails, TTS still plays but won't
   *     appear in the recording (graceful degradation)
   * ──────────────────────────────────────────────────── */

  async playAndRecordAudio(audioBlob) {
    // Resume AudioContext first (browser autoplay policy)
    if (this.audioContext && this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume();
        this.debug('[MIX] AudioContext resumed');
      } catch (e) {
        this.debug('[MIX] AudioContext resume failed', e.message);
      }
    }

    const objectUrl = URL.createObjectURL(audioBlob);
    const player = new Audio(objectUrl);
    this._currentAudioElement = player;

    // Try to inject TTS into the recording mix (non-blocking)
    let captureCleanup = null;
    if (this.audioContext && this.mixedDestination) {
      captureCleanup = await this._tryCaptureTTS(audioBlob, player);
    } else {
      this.debug('[MIX] No audio context — TTS will NOT be in recording');
    }

    // Play through speakers via Audio element (always reliable)
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        URL.revokeObjectURL(objectUrl);
        this._currentAudioElement = null;
        if (captureCleanup) captureCleanup();
        resolve();
      };

      player.onended = finish;
      player.onerror = () => {
        this.debug('[PLAY] Audio element playback error');
        finish();
      };
      player.play().catch((e) => {
        this.debug('[PLAY] Audio element play() rejected', e.message);
        finish();
      });

      // Safety timeout
      window.setTimeout(finish, 45000);
    });
  }

  /**
   * Attempts to feed TTS audio into the recording mix.
   * Returns a cleanup function, or null if capture failed.
   */
  async _tryCaptureTTS(audioBlob, audioElement) {
    // ── Attempt 1: decodeAudioData → AudioBufferSourceNode ──
    try {
      const arrayBuffer = await audioBlob.arrayBuffer();
      this.debug('[MIX] Decoding audio', {
        byteLength: arrayBuffer.byteLength,
        ctxState: this.audioContext.state
      });

      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer.slice(0));
      // Note: .slice(0) creates a copy because decodeAudioData detaches the buffer

      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      // Connect ONLY to recording mix — NOT to speakers (Audio element handles that)
      source.connect(this.mixedDestination);
      this._currentBufferSource = source;
      source.start(0);

      this.debug('[MIX] ✓ TTS captured via AudioBufferSourceNode', {
        duration: audioBuffer.duration.toFixed(2) + 's',
        sampleRate: audioBuffer.sampleRate,
        channels: audioBuffer.numberOfChannels
      });

      return () => {
        this._currentBufferSource = null;
        try { source.disconnect(); } catch (e) {}
      };
    } catch (decodeError) {
      this.debug('[MIX] decodeAudioData failed — trying captureStream()', decodeError.message);
    }

    // ── Attempt 2: captureStream() on the Audio element ──
    try {
      if (typeof audioElement.captureStream === 'function') {
        const ttsStream = audioElement.captureStream();
        const ttsSource = this.audioContext.createMediaStreamSource(ttsStream);
        ttsSource.connect(this.mixedDestination);

        this.debug('[MIX] ✓ TTS captured via captureStream()');

        return () => {
          try { ttsSource.disconnect(); } catch (e) {}
        };
      } else if (typeof audioElement.mozCaptureStream === 'function') {
        // Firefox variant
        const ttsStream = audioElement.mozCaptureStream();
        const ttsSource = this.audioContext.createMediaStreamSource(ttsStream);
        ttsSource.connect(this.mixedDestination);

        this.debug('[MIX] ✓ TTS captured via mozCaptureStream()');

        return () => {
          try { ttsSource.disconnect(); } catch (e) {}
        };
      } else {
        this.debug('[MIX] captureStream() not available on this browser');
      }
    } catch (captureError) {
      this.debug('[MIX] captureStream() failed', captureError.message);
    }

    // ── Attempt 3: createMediaElementSource as last resort ──
    try {
      const mesSource = this.audioContext.createMediaElementSource(audioElement);
      mesSource.connect(this.mixedDestination);
      mesSource.connect(this.audioContext.destination); // must re-route to speakers
      this.debug('[MIX] ✓ TTS captured via createMediaElementSource');

      return () => {
        try { mesSource.disconnect(); } catch (e) {}
      };
    } catch (mesError) {
      this.debug('[MIX] createMediaElementSource also failed', mesError.message);
    }

    this.debug('[MIX] ✗ ALL capture methods failed — TTS will NOT be in recording');
    return null;
  }

  /**
   * Stop any currently playing TTS audio.
   */
  stopCurrentAudio() {
    if (this._currentBufferSource) {
      try { this._currentBufferSource.stop(); } catch (e) {}
      this._currentBufferSource = null;
    }
    if (this._currentAudioElement) {
      try { this._currentAudioElement.pause(); } catch (e) {}
      this._currentAudioElement = null;
    }
  }

  /* ───── Recording lifecycle ───── */

  start() {
    if (!window.MediaRecorder) throw new Error('Recording is not supported in this browser.');
    if (!this.stream) throw new Error('Camera and microphone are not ready.');

    this._setupAudioMixing();

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
      usingMixedStream: !!this.recordingStream
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

    this.stopCurrentAudio();

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

/* ────── Utility exports ────── */

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
