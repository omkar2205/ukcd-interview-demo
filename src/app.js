import { InterviewApi } from './api.js';
import { ApplicantRecorder } from './recorder.js';
import {
  $, clearFieldErrors, debug, initUi, markInvalidFields, setReadiness,
  showDetailsErrors, showScreen, showToast
} from './ui.js';
import { InterviewController } from './interview.js';

const CAMERA_SAMPLE_WIDTH = 160;
const CAMERA_SAMPLE_HEIGHT = 90;
const CAMERA_MIN_AVERAGE_BRIGHTNESS = 18;
const CAMERA_MIN_CONTRAST = 4.5;
const CAMERA_MIN_VISIBLE_RATIO = 0.08;

let recorder;
let api;
let interview;

initUi();
api = new InterviewApi(debug);
recorder = new ApplicantRecorder(debug);

$('beginBtn').addEventListener('click', () => showScreen('detailsScreen'));
$('detailsNextBtn').addEventListener('click', proceedToReadinessCheck);
$('retryCameraBtn').addEventListener('click', initCameraPreview);
$('startInterviewBtn').addEventListener('click', startInterview);
$('repeatQuestionBtn').addEventListener('click', () => interview && interview.replayQuestion());
$('skipQuestionBtn').addEventListener('click', () => interview && interview.skipQuestion());
$('endSessionBtn').addEventListener('click', () => interview && interview.endSession());
$('detailsForm').addEventListener('submit', (event) => {
  event.preventDefault();
  proceedToReadinessCheck();
});

window.addEventListener('beforeunload', () => {
  if (recorder) recorder.stopTracks();
});

async function proceedToReadinessCheck() {
  const result = collectStudentDetails();
  showDetailsErrors(result.errors);
  markInvalidFields(result.invalidFields);

  if (!result.valid) {
    showToast('Please review the highlighted details before continuing.');
    return;
  }

  clearFieldErrors();
  showScreen('checkScreen');
  await initCameraPreview();
}

async function initCameraPreview() {
  $('startInterviewBtn').disabled = true;
  setReadiness('Checking', 'Checking');

  try {
    const stream = await recorder.requestMedia();
    const checkPreview = $('checkPreview');
    recorder.attachPreview(checkPreview);
    recorder.attachPreview($('interviewPreview'));
    $('checkPlaceholder').classList.add('hidden');

    const readiness = recorder.getReadiness();
    setReadiness(readiness.camera ? 'Checking view' : 'Not detected', readiness.microphone ? 'Ready' : 'Not detected');

    let cameraView = {
      ok: false,
      label: 'No clear view',
      message: 'We could not confirm a clear camera view. Please check your camera shutter, lighting, and position, then retry.'
    };

    if (readiness.camera) {
      cameraView = await verifyCameraView(checkPreview);
    }

    const readyToStart = Boolean(readiness.camera && readiness.microphone && cameraView.ok);
    setReadiness(cameraView.label, readiness.microphone ? 'Ready' : 'Not detected');
    $('startInterviewBtn').disabled = !readyToStart;

    debug('Media stream ready', {
      videoTracks: stream.getVideoTracks().length,
      audioTracks: stream.getAudioTracks().length,
      cameraView
    });

    if (!readiness.camera || !readiness.microphone) {
      showToast('We could not detect both camera and microphone. Please check browser permissions and try again.');
      return;
    }

    if (!cameraView.ok) {
      showToast(cameraView.message);
    }
  } catch (error) {
    setReadiness('Permission needed', 'Permission needed');
    $('checkPlaceholder').classList.remove('hidden');
    showToast('Camera and microphone access is needed to continue. Please allow access in your browser and try again.');
    debug('Media permission error', error.stack || error.message);
  }
}

async function verifyCameraView(videoElement) {
  try {
    await waitForVideoReady(videoElement, 5000);
    await wait(450);

    const signal = await inspectCameraSignal(videoElement);

    debug('Camera signal check', signal);

    if (!signal.ok) {
      return {
        ok: false,
        label: 'No clear view',
        message: 'Your camera appears blocked, covered, too dark, or not showing a clear image. Please check your shutter or lighting, then retry.',
        signal
      };
    }

    const faceCheck = await detectFaceIfAvailable(videoElement);

    debug('Camera face check', faceCheck);

    if (faceCheck.supported && !faceCheck.detected) {
      return {
        ok: false,
        label: 'Face not visible',
        message: 'We could not detect a face in the camera frame. Please sit clearly in front of the camera and retry.',
        signal,
        faceCheck
      };
    }

    return {
      ok: true,
      label: faceCheck.supported ? 'Face detected' : 'View clear',
      message: '',
      signal,
      faceCheck
    };
  } catch (error) {
    debug('Camera view verification warning', error.stack || error.message);
    return {
      ok: false,
      label: 'No clear view',
      message: 'We could not verify the camera image. Please check your camera shutter, lighting, and browser permissions, then retry.',
      warning: error.message
    };
  }
}

function waitForVideoReady(videoElement, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!videoElement) {
      reject(new Error('Camera preview element not found.'));
      return;
    }

    const hasFrame = () => videoElement.readyState >= 2 && videoElement.videoWidth > 0 && videoElement.videoHeight > 0;
    if (hasFrame()) {
      resolve();
      return;
    }

    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('Camera preview did not become ready in time.'));
    }, timeoutMs || 5000);

    const onReady = () => {
      if (!hasFrame()) return;
      cleanup();
      resolve();
    };

    const cleanup = () => {
      window.clearTimeout(timer);
      videoElement.removeEventListener('loadedmetadata', onReady);
      videoElement.removeEventListener('canplay', onReady);
      videoElement.removeEventListener('playing', onReady);
    };

    videoElement.addEventListener('loadedmetadata', onReady);
    videoElement.addEventListener('canplay', onReady);
    videoElement.addEventListener('playing', onReady);
  });
}

async function inspectCameraSignal(videoElement) {
  const canvas = document.createElement('canvas');
  canvas.width = CAMERA_SAMPLE_WIDTH;
  canvas.height = CAMERA_SAMPLE_HEIGHT;
  const context = canvas.getContext('2d', { willReadFrequently: true });

  if (!context) throw new Error('Could not create camera check canvas.');

  const samples = [];

  for (let i = 0; i < 5; i += 1) {
    await wait(i === 0 ? 0 : 220);
    context.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
    samples.push(readFrameStats(context, canvas.width, canvas.height));
  }

  const averageBrightness = average(samples.map((sample) => sample.averageBrightness));
  const contrast = average(samples.map((sample) => sample.contrast));
  const visibleRatio = average(samples.map((sample) => sample.visibleRatio));
  const frameDifference = averageFrameDifference(samples);

  const ok =
    averageBrightness >= CAMERA_MIN_AVERAGE_BRIGHTNESS &&
    contrast >= CAMERA_MIN_CONTRAST &&
    visibleRatio >= CAMERA_MIN_VISIBLE_RATIO;

  return {
    ok,
    averageBrightness: Number(averageBrightness.toFixed(2)),
    contrast: Number(contrast.toFixed(2)),
    visibleRatio: Number(visibleRatio.toFixed(3)),
    frameDifference: Number(frameDifference.toFixed(2)),
    samples: samples.length
  };
}

function readFrameStats(context, width, height) {
  const image = context.getImageData(0, 0, width, height).data;
  let total = 0;
  let totalSquared = 0;
  let visiblePixels = 0;
  const reduced = [];

  for (let i = 0; i < image.length; i += 4) {
    const luma = (0.2126 * image[i]) + (0.7152 * image[i + 1]) + (0.0722 * image[i + 2]);
    total += luma;
    totalSquared += luma * luma;
    if (luma > 28) visiblePixels += 1;
    if (i % 64 === 0) reduced.push(luma);
  }

  const pixelCount = image.length / 4;
  const averageBrightness = total / pixelCount;
  const variance = Math.max(0, (totalSquared / pixelCount) - (averageBrightness * averageBrightness));

  return {
    averageBrightness,
    contrast: Math.sqrt(variance),
    visibleRatio: visiblePixels / pixelCount,
    reduced
  };
}

function averageFrameDifference(samples) {
  if (!samples || samples.length < 2) return 0;

  let total = 0;
  let comparisons = 0;

  for (let i = 1; i < samples.length; i += 1) {
    const previous = samples[i - 1].reduced || [];
    const current = samples[i].reduced || [];
    const count = Math.min(previous.length, current.length);

    if (!count) continue;

    let difference = 0;
    for (let p = 0; p < count; p += 1) difference += Math.abs(current[p] - previous[p]);
    total += difference / count;
    comparisons += 1;
  }

  return comparisons ? total / comparisons : 0;
}

async function detectFaceIfAvailable(videoElement) {
  if (!('FaceDetector' in window)) {
    return {
      supported: false,
      detected: false
    };
  }

  try {
    const detector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await wait(attempt === 0 ? 0 : 260);
      const faces = await detector.detect(videoElement);
      if (faces && faces.length > 0) {
        return {
          supported: true,
          detected: true,
          count: faces.length
        };
      }
    }

    return {
      supported: true,
      detected: false,
      count: 0
    };
  } catch (error) {
    return {
      supported: false,
      detected: false,
      warning: error.message
    };
  }
}

async function startInterview() {
  const result = collectStudentDetails();
  if (!result.valid) {
    showScreen('detailsScreen');
    showDetailsErrors(result.errors);
    markInvalidFields(result.invalidFields);
    return;
  }

  try {
    interview = new InterviewController({
      api,
      recorder,
      student: result.student
    });
    await interview.start();
  } catch (error) {
    showToast('We could not start the interview. Please refresh the page and try again.');
    debug('Interview start error', error.stack || error.message);
  }
}

function collectStudentDetails() {
  const hiddenContext = getHiddenApplicantContext();
  const student = {
    fullName: value('fullName'),
    studentId: value('studentId'),
    email: hiddenContext.email,
    phone: hiddenContext.phone,
    programme: hiddenContext.programme,
    studyLevel: hiddenContext.studyLevel,
    country: hiddenContext.country,
    intake: hiddenContext.intake,
    institution: hiddenContext.institution,
    studyMode: hiddenContext.studyMode
  };

  const errors = [];
  const invalidFields = [];
  const required = [
    ['fullName', 'Please enter your applicant name.'],
    ['studentId', 'Please enter your applicant ID.']
  ];

  required.forEach(([field, message]) => {
    if (!student[field]) {
      errors.push(message);
      invalidFields.push(field);
    }
  });

  if (student.fullName && student.fullName.length < 2) {
    errors.push('Please enter a valid applicant name.');
    invalidFields.push('fullName');
  }

  if (student.studentId && !/^[a-z0-9-_/]{2,30}$/i.test(student.studentId)) {
    errors.push('Please check your applicant ID contains only letters, numbers, hyphens, underscores, or slashes.');
    invalidFields.push('studentId');
  }

  debug('Applicant details collected', {
    hasProgrammeContext: Boolean(student.programme),
    hasStudyLevelContext: Boolean(student.studyLevel),
    hasIntakeContext: Boolean(student.intake)
  });

  return {
    valid: errors.length === 0,
    errors,
    invalidFields: [...new Set(invalidFields)],
    student
  };
}

function getHiddenApplicantContext() {
  const params = new URLSearchParams(window.location.search);
  return {
    email: paramValue(params, ['email', 'emailAddress']),
    phone: paramValue(params, ['phone', 'mobile', 'phoneNumber']),
    programme: paramValue(params, ['programme', 'program', 'course', 'courseName']),
    studyLevel: paramValue(params, ['studyLevel', 'level']),
    country: paramValue(params, ['country', 'residenceCountry', 'countryOfResidence']),
    intake: paramValue(params, ['intake', 'startDate']),
    institution: paramValue(params, ['institution', 'university', 'college']),
    studyMode: paramValue(params, ['studyMode', 'mode', 'courseOption'])
  };
}

function paramValue(params, keys) {
  for (const key of keys) {
    const value = params.get(key);
    if (value && value.trim()) return value.trim();
  }
  return '';
}

function value(id) {
  const element = $(id);
  return element ? element.value.trim() : '';
}

function average(values) {
  const validValues = values.filter((value) => Number.isFinite(value));
  if (!validValues.length) return 0;
  return validValues.reduce((sum, value) => sum + value, 0) / validValues.length;
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
