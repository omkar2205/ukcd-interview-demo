import { InterviewApi } from './api.js';
import { ApplicantRecorder } from './recorder.js';
import {
  $, clearFieldErrors, debug, initUi, markInvalidFields, setReadiness,
  showDetailsErrors, showScreen, showToast
} from './ui.js';
import { InterviewController } from './interview.js';

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
    recorder.attachPreview($('checkPreview'));
    recorder.attachPreview($('interviewPreview'));
    $('checkPlaceholder').classList.add('hidden');

    const readiness = recorder.getReadiness();
    setReadiness(readiness.camera ? 'Ready' : 'Not detected', readiness.microphone ? 'Ready' : 'Not detected');
    $('startInterviewBtn').disabled = !(readiness.camera && readiness.microphone);

    debug('Media stream ready', {
      videoTracks: stream.getVideoTracks().length,
      audioTracks: stream.getAudioTracks().length
    });

    if (!readiness.camera || !readiness.microphone) {
      showToast('We could not detect both camera and microphone. Please check browser permissions and try again.');
    }
  } catch (error) {
    setReadiness('Permission needed', 'Permission needed');
    $('checkPlaceholder').classList.remove('hidden');
    showToast('Camera and microphone access is needed to continue. Please allow access in your browser and try again.');
    debug('Media permission error', error.stack || error.message);
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
  const student = {
    fullName: value('fullName'),
    email: value('email'),
    phone: value('phone'),
    studentId: value('studentId'),
    programme: value('programme'),
    studyLevel: value('studyLevel'),
    country: value('country'),
    intake: value('intake')
  };

  const errors = [];
  const invalidFields = [];
  const required = [
    ['fullName', 'Please enter your full name.'],
    ['email', 'Please enter your email address.'],
    ['studentId', 'Please enter your student ID.'],
    ['programme', 'Please enter your programme.'],
    ['studyLevel', 'Please select your study level.'],
    ['country', 'Please enter your country of residence.'],
    ['intake', 'Please enter your intake.']
  ];

  required.forEach(([field, message]) => {
    if (!student[field]) {
      errors.push(message);
      invalidFields.push(field);
    }
  });

  if (student.fullName && student.fullName.trim().split(/\s+/).length < 2) {
    errors.push('Please enter your full name as shown on your application.');
    invalidFields.push('fullName');
  }

  if (student.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(student.email)) {
    errors.push('Please enter a valid email address.');
    invalidFields.push('email');
  }

  if (student.phone && !/^[+()\d\s-]{7,22}$/.test(student.phone)) {
    errors.push('Please enter a valid phone number, including country code where possible.');
    invalidFields.push('phone');
  }

  if (student.studentId && !/^[a-z0-9-_/]{3,30}$/i.test(student.studentId)) {
    errors.push('Please check your student ID contains only letters, numbers, hyphens, underscores, or slashes.');
    invalidFields.push('studentId');
  }

  return {
    valid: errors.length === 0,
    errors,
    invalidFields: [...new Set(invalidFields)],
    student
  };
}

function value(id) {
  return $(id).value.trim();
}
