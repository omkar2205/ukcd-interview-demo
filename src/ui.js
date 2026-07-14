const SCREEN_IDS = [
  'welcomeScreen',
  'detailsScreen',
  'checkScreen',
  'interviewScreen',
  'feedbackScreen',
  'finalisingScreen',
  'completeScreen'
];

const SCREEN_LABELS = {
  welcomeScreen: 'Ready to begin',
  detailsScreen: 'Applicant details',
  checkScreen: 'Pre-interview lobby',
  interviewScreen: 'Recording',
  feedbackScreen: 'Feedback',
  finalisingScreen: 'Uploading',
  completeScreen: 'Completed'
};

// SVG progress ring circumference (r=92, C=2πr)
const RING_CIRCUMFERENCE = 2 * Math.PI * 92;

// Status icon SVG templates (inline, no external icon dependency)
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
  hideInterviewHeadings();
  showScreen('welcomeScreen');
}

function hideInterviewHeadings() {
  const interviewerLabel = document.querySelector('.interviewer-label');
  if (interviewerLabel) {
    interviewerLabel.textContent = '';
    interviewerLabel.setAttribute('aria-hidden', 'true');
    interviewerLabel.style.display = 'none';
  }

  const stageLabel = $('stageLabel');
  if (stageLabel) {
    stageLabel.textContent = '';
    stageLabel.setAttribute('aria-hidden', 'true');
    stageLabel.style.display = 'none';
  }
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

  const iconContainer = $('statusIcon');
  if (iconContainer) {
    const iconKey = options.icon || (isListening ? 'audio-lines' : 'loader-circle');
    const svg = STATUS_ICONS[iconKey] || STATUS_ICONS['loader-circle'];
    iconContainer.outerHTML = svg.replace('class="status-icon', 'id="statusIcon" class="status-icon');
  }

  updateAvatarState(message, { ...options, speaking: isSpeaking, listening: isListening });
}

export function setReadiness(cameraText, micText) {
  $('cameraBadge').textContent = cameraText;
  $('micBadge').textContent = micText;
}

export function renderQuestion({ question, index, total }) {
  $('questionCounter').textContent = `Question ${index}`;
  hideInterviewHeadings();
  $('questionText').textContent = question;

  const instructionText = $('instructionText');
  if (instructionText) instructionText.textContent = '';

  const denominator = Number(total || 10);
  const safeFraction = denominator > 0 ? Math.min(0.95, (index - 1) / denominator) : 0;
  updateProgressRing(safeFraction);

  setStatus('Preparing question...', { icon: 'loader-circle' });
}

export function markQuestionComplete(index, total) {
  const denominator = Number(total || 10);
  const safeFraction = denominator > 0 ? Math.min(0.98, index / denominator) : 0;
  updateProgressRing(safeFraction);
}

export function setUploadProgress(percent, message) {
  const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const bar = $('uploadProgressBar');
  const label = $('uploadProgressPercent');
  const text = $('uploadProgressText');
  const progress = document.querySelector('.upload-progress');
  const dino = ensureUploadDino(progress);

  if (bar) bar.style.width = `${value}%`;
  if (label) label.textContent = `${value}%`;
  if (text && message) text.textContent = message;
  if (progress) progress.setAttribute('aria-valuenow', String(value));

  if (dino) {
    // Keep the skull visible at the beginning while allowing a slight overhang at 100%.
    dino.style.left = `${Math.max(5, value)}%`;
    dino.classList.toggle('is-complete', value >= 100);
  }
}

function ensureUploadDino(progress) {
  if (!progress) return null;

  let style = document.getElementById('uploadDinoStyles');
  if (!style) {
    style = document.createElement('style');
    style.id = 'uploadDinoStyles';
    style.textContent = `
      .upload-progress {
        position: relative;
        height: 14px !important;
        margin-top: 34px !important;
        overflow: visible !important;
        isolation: isolate;
      }

      .upload-progress-bar {
        position: relative;
        z-index: 1;
      }

      .upload-dino-runner {
        position: absolute;
        left: 5%;
        top: 50%;
        z-index: 5;
        width: 96px;
        height: 72px;
        pointer-events: none;
        transform: translate(-78%, -50%);
        transition: left 420ms ease;
        filter: drop-shadow(0 8px 8px rgba(15, 23, 42, 0.22));
      }

      .upload-trex-skull {
        display: block;
        width: 96px;
        height: 72px;
        overflow: visible;
        animation: uploadTrexHeadBob 720ms ease-in-out infinite;
      }

      .trex-bone {
        fill: #ead9b6;
        stroke: #6f5d3e;
        stroke-width: 1.7;
        stroke-linejoin: round;
        stroke-linecap: round;
      }

      .trex-bone-light {
        fill: #f3e6c9;
        stroke: #6f5d3e;
        stroke-width: 1.4;
        stroke-linejoin: round;
      }

      .trex-cavity {
        fill: #17140f;
        stroke: #6f5d3e;
        stroke-width: 1.1;
      }

      .trex-detail {
        fill: none;
        stroke: #8b7651;
        stroke-width: 1.25;
        stroke-linecap: round;
      }

      .trex-tooth {
        fill: #fff7e5;
        stroke: #6f5d3e;
        stroke-width: 0.85;
        stroke-linejoin: round;
      }

      .trex-skull-lower {
        transform-box: view-box;
        transform-origin: 29px 43px;
        animation: uploadTrexJawChomp 360ms cubic-bezier(.45, 0, .25, 1) infinite;
      }

      .upload-dino-runner.is-complete .upload-trex-skull {
        animation: uploadTrexFinish 560ms ease both;
      }

      .upload-dino-runner.is-complete .trex-skull-lower {
        animation: uploadTrexFinalBite 560ms ease both;
      }

      @keyframes uploadTrexJawChomp {
        0%, 100% { transform: rotate(12deg); }
        48%, 58% { transform: rotate(-2deg); }
      }

      @keyframes uploadTrexHeadBob {
        0%, 100% { transform: translateY(0) rotate(-1deg); }
        50% { transform: translateY(-1.5px) rotate(1deg); }
      }

      @keyframes uploadTrexFinalBite {
        0% { transform: rotate(12deg); }
        55% { transform: rotate(-3deg); }
        100% { transform: rotate(1deg); }
      }

      @keyframes uploadTrexFinish {
        0% { transform: translateY(0) rotate(-1deg); }
        50% { transform: translateY(-3px) rotate(2deg); }
        100% { transform: translateY(0) rotate(0); }
      }

      @media (max-width: 640px) {
        .upload-dino-runner {
          width: 82px;
          height: 62px;
          transform: translate(-78%, -50%);
        }

        .upload-trex-skull {
          width: 82px;
          height: 62px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  let dino = document.getElementById('uploadDino');
  if (!dino) {
    dino = document.createElement('span');
    dino.id = 'uploadDino';
    dino.className = 'upload-dino-runner';
    dino.setAttribute('aria-hidden', 'true');
    dino.innerHTML = `
      <svg class="upload-trex-skull" viewBox="0 0 96 72" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <g class="trex-skull-upper">
          <path class="trex-bone" d="M10 38 C6 34 7 27 12 23 C17 18 25 18 31 20 C35 12 43 7 53 7 C64 7 72 12 77 20 L88 24 C92 26 93 31 90 34 L82 39 L69 40 L64 35 L54 34 L48 39 L35 40 L28 37 L20 41 Z"/>
          <path class="trex-bone-light" d="M32 20 C36 13 44 9 53 9 C62 9 69 13 73 19 L64 21 L58 18 L50 21 L42 18 Z"/>
          <path class="trex-bone" d="M18 39 L29 39 L33 44 L23 46 L14 44 Z"/>
          <path class="trex-cavity" d="M42 15 C46 11 54 11 59 15 C58 20 54 23 49 23 C45 22 42 20 42 15 Z"/>
          <path class="trex-cavity" d="M27 24 C32 21 38 22 41 26 C39 31 35 34 30 33 C27 31 26 28 27 24 Z"/>
          <path class="trex-cavity" d="M60 23 C65 20 72 22 76 26 L70 32 L61 31 C59 28 59 25 60 23 Z"/>
          <ellipse class="trex-cavity" cx="83" cy="28" rx="3.4" ry="2.4"/>
          <path class="trex-detail" d="M13 31 C18 27 22 26 27 27"/>
          <path class="trex-detail" d="M37 34 C42 29 48 27 54 28"/>
          <path class="trex-detail" d="M69 34 L82 33"/>
          <path class="trex-tooth" d="M49 39 L53 47 L57 39 Z"/>
          <path class="trex-tooth" d="M59 39 L63 47 L67 39 Z"/>
          <path class="trex-tooth" d="M70 39 L74 46 L78 39 Z"/>
          <path class="trex-tooth" d="M79 38 L82 44 L86 36 Z"/>
        </g>

        <g class="trex-skull-lower">
          <path class="trex-bone" d="M21 44 C30 48 42 50 55 50 L76 46 L87 42 L91 45 L84 52 L67 60 C55 64 42 62 32 57 L23 52 L16 48 Z"/>
          <path class="trex-bone-light" d="M31 51 C42 55 55 56 68 53 L77 50 L69 57 C56 61 43 59 33 55 Z"/>
          <path class="trex-cavity" d="M34 52 C42 54 50 55 57 54 C54 58 48 59 42 57 C38 56 35 55 34 52 Z"/>
          <path class="trex-detail" d="M22 47 C35 53 52 56 69 52"/>
          <path class="trex-tooth" d="M48 49 L52 42 L56 50 Z"/>
          <path class="trex-tooth" d="M58 50 L62 43 L66 49 Z"/>
          <path class="trex-tooth" d="M68 48 L72 42 L76 46 Z"/>
        </g>

        <circle class="trex-bone-light" cx="29" cy="43" r="3.2"/>
      </svg>
    `;
    progress.appendChild(dino);
  }

  return dino;
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
