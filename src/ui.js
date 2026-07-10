const SCREEN_IDS = [
  'welcomeScreen',
  'detailsScreen',
  'checkScreen',
  'interviewScreen',
  'finalisingScreen',
  'completeScreen'
];

const SCREEN_LABELS = {
  welcomeScreen: 'Ready to begin',
  detailsScreen: 'Applicant details',
  checkScreen: 'Pre-interview lobby',
  interviewScreen: 'Recording',
  finalisingScreen: 'Finalising',
  completeScreen: 'Completed'
};

export const DEBUG = new URLSearchParams(window.location.search).get('debug') === 'true';

export function $(id) {
  return document.getElementById(id);
}

export function initUi() {
  if (window.lucide) window.lucide.createIcons();
  if (DEBUG) $('debugPanel').classList.remove('hidden');
  showScreen('welcomeScreen');
}

export function showScreen(screenId) {
  SCREEN_IDS.forEach((id) => $(id).classList.toggle('is-active', id === screenId));
  $('sessionLabel').textContent = SCREEN_LABELS[screenId] || 'In progress';
  $('sessionDot').classList.toggle('is-recording', screenId === 'interviewScreen');
  if (window.lucide) window.lucide.createIcons();
}

export function setStatus(message, options = {}) {
  const statusText = $('statusText');
  if (statusText) statusText.textContent = message;

  const listeningBars = $('listeningBars');
  if (listeningBars) listeningBars.classList.toggle('hidden', options.listening !== true && options.speaking !== true);

  const icon = $('statusIcon');
  if (icon) {
    icon.setAttribute('data-lucide', options.icon || (options.listening ? 'audio-lines' : 'loader-circle'));
    if (window.lucide) window.lucide.createIcons();
  }

  updateAvatarState(message, options);
}

export function setReadiness(cameraText, micText) {
  $('cameraBadge').textContent = cameraText;
  $('micBadge').textContent = micText;
}

export function renderQuestion({ question, stageLabel, index, total }) {
  $('questionCounter').textContent = `Question ${index} of ${total}`;
  $('stageLabel').textContent = stageLabel || 'Interview Question';
  $('questionText').textContent = question;
  $('progressFill').style.width = `${Math.round(((index - 1) / total) * 100)}%`;
  $('instructionText').textContent = 'Answer naturally after the question has been asked.';
  setStatus('Preparing question...', { icon: 'loader-circle' });
}

export function markQuestionComplete(index, total) {
  $('progressFill').style.width = `${Math.round((index / total) * 100)}%`;
}

export function updateTimer(startedAt) {
  const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const seconds = String(elapsed % 60).padStart(2, '0');
  $('timer').textContent = `${minutes}:${seconds}`;
}

export function showToast(message) {
  $('toast').textContent = message;
  $('toast').classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => $('toast').classList.add('hidden'), 4800);
}

export function showDetailsErrors(messages) {
  const panel = $('detailsErrors');
  panel.textContent = messages.join(' ');
  panel.classList.toggle('hidden', messages.length === 0);
}

export function clearFieldErrors() {
  document.querySelectorAll('.field').forEach((field) => field.classList.remove('is-invalid'));
}

export function markInvalidFields(fieldIds) {
  clearFieldErrors();
  fieldIds.forEach((id) => {
    const input = $(id);
    const field = input ? input.closest('.field') : null;
    if (field) field.classList.add('is-invalid');
  });
}

export function showCompletion(success, referenceId) {
  showScreen('completeScreen');
  $('referenceId').textContent = `Reference ID: ${referenceId}`;
  if (!success) {
    $('completeTitle').textContent = 'Interview Submitted';
    $('completeText').textContent = 'Thank you. Your interview has been submitted. If confirmation is needed, please share the reference ID below with the admissions team.';
  }
}

export function debug(message, data) {
  if (!DEBUG) return;
  const suffix = data === undefined ? '' : ` ${safeStringify(data)}`;
  const line = `[${new Date().toLocaleTimeString()}] ${message}${suffix}`;
  const panel = $('debugPanel');
  panel.textContent += `${line}\n`;
  panel.scrollTop = panel.scrollHeight;
  console.debug('[UKCD]', message, data || '');
}

function updateAvatarState(message, options) {
  const avatarStage = $('avatarStage');
  if (!avatarStage) return;

  avatarStage.classList.remove('preparing', 'is-speaking', 'is-listening', 'is-complete');

  const text = String(message || '').toLowerCase();
  if (options.listening || text.includes('listening') || text.includes('answer')) {
    avatarStage.classList.add('is-listening');
    return;
  }

  if (options.speaking || text.includes('question being asked') || text.includes('played again')) {
    avatarStage.classList.add('is-speaking');
    return;
  }

  if (text.includes('captured') || text.includes('complete')) {
    avatarStage.classList.add('is-complete');
    return;
  }

  avatarStage.classList.add('preparing');
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}
