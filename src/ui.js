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

// SVG progress ring circumference (r=92, C=2πr)
const RING_CIRCUMFERENCE = 2 * Math.PI * 92;

// Status icon SVG templates (inline, no Lucide dependency)
const STATUS_ICONS = {
  'loader-circle': '<svg class="status-icon spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
  'volume-2': '<svg class="status-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
  'audio-lines': '<svg class="status-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/></svg>',
  'check': '<svg class="status-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  'rotate-ccw': '<svg class="status-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>'
};

export const DEBUG = new URLSearchParams(window.location.search).get('debug') === 'true';

export function $(id) {
  return document.getElementById(id);
}

export function initUi() {
  if (DEBUG) $('debugPanel').classList.remove('hidden');
  showScreen('welcomeScreen');
}

export function showScreen(screenId) {
  SCREEN_IDS.forEach((id) => $(id).classList.toggle('is-active', id === screenId));
  $('sessionLabel').textContent = SCREEN_LABELS[screenId] || 'In progress';
  $('sessionDot').classList.toggle('is-recording', screenId === 'interviewScreen');
}

export function setStatus(message, options = {}) {
  const statusText = $('statusText');
  if (statusText) statusText.textContent = message;

  const lowerMessage = String(message || '').toLowerCase();
  const isSpeaking = options.speaking === true || lowerMessage.includes('question being asked') || lowerMessage.includes('played again');
  const isListening = options.listening === true || lowerMessage.includes('listening');

  const listeningBars = $('listeningBars');
  if (listeningBars) listeningBars.classList.toggle('hidden', !(isSpeaking || isListening));

  // Update status icon
  const iconContainer = $('statusIcon');
  if (iconContainer) {
    const iconKey = options.icon || (isListening ? 'audio-lines' : 'loader-circle');
    const svg = STATUS_ICONS[iconKey] || STATUS_ICONS['loader-circle'];
    iconContainer.outerHTML = svg.replace('class="status-icon', `id="statusIcon" class="status-icon`);
  }

  updateAvatarState(message, { ...options, speaking: isSpeaking, listening: isListening });
}

export function setReadiness(cameraText, micText) {
  $('cameraBadge').textContent = cameraText;
  $('micBadge').textContent = micText;
}

export function renderQuestion({ question, stageLabel, index, total }) {
  $('questionCounter').textContent = `Question ${index} of ${total}`;
  $('stageLabel').textContent = stageLabel || 'Interview Question';
  $('questionText').textContent = question;
  $('instructionText').textContent = 'Answer naturally after the question has been asked.';

  // Update circular progress ring: show progress up to (index-1)/total
  updateProgressRing((index - 1) / total);

  setStatus('Preparing question...', { icon: 'loader-circle' });
}

export function markQuestionComplete(index, total) {
  // Update circular progress ring to index/total
  updateProgressRing(index / total);
}

function updateProgressRing(fraction) {
  const arc = $('progressArc');
  if (!arc) return;
  const offset = RING_CIRCUMFERENCE * (1 - Math.min(1, Math.max(0, fraction)));
  arc.style.strokeDashoffset = offset;
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
  if (options.speaking) {
    avatarStage.classList.add('is-speaking');
    return;
  }

  if (options.listening || text.includes('listening')) {
    avatarStage.classList.add('is-listening');
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
