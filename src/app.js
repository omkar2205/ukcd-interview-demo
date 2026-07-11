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
