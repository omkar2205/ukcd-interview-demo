import { base64ToBlob } from './api.js';
import { blobToUploadPack, normaliseVideoMimeType } from './recorder.js';
import {
  $, DEBUG, debug, markQuestionComplete, renderQuestion, setStatus,
  setUploadProgress, showCompletion, showScreen, updateTimer
} from './ui.js';

const SILENCE_MS = 3000;
const MIN_ANSWER_MS = 4500;
const MAX_ANSWER_MS = 65000;
const MAX_WAIT_FOR_VOICE_MS = 14000;
const NO_RESPONSE_AUTO_ADVANCE_MS = 24000;
const MIN_TRANSCRIPT_CHARS = 10;
const VOICE_LEVEL_THRESHOLD = 0.026;
const DEFAULT_TARGET_TOTAL_QUESTIONS = 10;
const DEFAULT_SAFETY_CAP_QUESTIONS = 14;

export const INTERVIEW_STAGES = [
  {
    key: 'Introduction',
    prompt: 'Ask a warm opening question asking the applicant to introduce themselves and confirm their chosen programme. Do not mention any institution name unless explicitly provided by the applicant.',
    fallbackQuestion: 'Please introduce yourself and confirm the programme you are applying for.'
  },
  {
    key: 'Programme Motivation',
    prompt: 'Ask a natural programme motivation question. The wording may vary, but it must focus only on the chosen programme, not the institution.',
    fallbackQuestion: 'Why have you chosen this programme?'
  },
  {
    key: 'Academic or Work Background',
    prompt: 'Ask how the applicant’s previous study, work, skills, or experience connects to the programme. Use friendly professional wording.',
    fallbackQuestion: 'How does your previous study or work experience relate to this programme?'
  },
  {
    key: 'Course Knowledge and Subject Interest',
    prompt: 'Ask what the applicant knows about the course content, modules, skills, or subject areas. Do not invent module names.',
    fallbackQuestion: 'What do you know about this programme, and which subject area interests you most?'
  },
  {
    key: 'Academic Readiness',
    prompt: 'Ask about assignments, projects, exams, independent learning, time management, or managing study alongside other responsibilities.',
    fallbackQuestion: 'Can you describe how you manage your time and prepare for assignments, projects, or exams?'
  },
  {
    key: 'Career and Practical Readiness',
    prompt: 'Ask how the programme supports future career goals and include practical readiness such as computer access, study tools, attendance, travel, or support needs if appropriate.',
    fallbackQuestion: 'How will this programme support your future career goals, and how are you preparing to study successfully?'
  }
];

export class InterviewController {
  constructor({ api, recorder, student }) {
    this.api = api;
    this.recorder = recorder;
    this.student = student;
    this.responses = [];
    this.stageIndex = -1;
    this.currentQuestion = '';
    this.currentFocus = 'Introduction';
    this.currentQuestionType = 'core';
    this.phase = 'idle';
    this.startedAt = null;
    this.timerHandle = null;
    this.recognition = null;
    this.recognitionActive = false;
    this.recognitionSupported = false;
    this.answerFinal = '';
    this.answerInterim = '';
    this.answerStartedAt = null;
    this.lastVoiceAt = null;
    this.heardVoice = false;
    this.answerTimer = null;
    this.completingAnswer = false;
    this.targetTotalQuestions = DEFAULT_TARGET_TOTAL_QUESTIONS;
    this.safetyCapQuestions = DEFAULT_SAFETY_CAP_QUESTIONS;
  }

  async start() {
    this.responses = [];
    this.stageIndex = -1;
    this.startedAt = Date.now();
    this.timerHandle = window.setInterval(() => updateTimer(this.startedAt), 1000);
    updateTimer(this.startedAt);
    this.recorder.start();
    this.initialiseSpeechRecognition();
    this.startRecognitionLoop();
    showScreen('interviewScreen');
    this.recorder.attachPreview($('interviewPreview'));
    this.setSkipButton(true);
    await this.nextQuestion();
  }

  async replayQuestion() {
    if (!this.currentQuestion || this.phase === 'finalising') return;
    window.clearInterval(this.answerTimer);
    this.completingAnswer = false;
    this.setSkipButton(true);
    setStatus('The question will be played again.', { icon: 'rotate-ccw' });
    await wait(800);
    await this.speakQuestion(this.currentQuestion);
  }

  async skipQuestion() {
    if (!this.currentQuestion || this.phase === 'finalising' || this.phase === 'ended' || this.completingAnswer) return;

    if (this.phase !== 'listening') {
      setStatus('Please wait until the question has finished.', { icon: 'loader-circle' });
      return;
    }

    this.completingAnswer = true;
    this.setSkipButton(true);
    window.clearInterval(this.answerTimer);

    this.responses.push({
      questionNumber: this.stageIndex + 1,
      question: this.currentQuestion,
      answer: 'Question skipped by applicant.',
      focusArea: this.currentFocus,
      stage: this.currentFocus,
      questionType: this.currentQuestionType,
      captureReason: 'skipped'
    });

    markQuestionComplete(this.stageIndex + 1, this.targetTotalQuestions);
    setStatus('Question skipped.', { icon: 'check' });
    await wait(450);
    await this.nextQuestion();
  }

  async endSession() {
    await this.finish('Ended by applicant');
  }

  async nextQuestion() {
    this.stageIndex += 1;
    const questionNumber = this.stageIndex + 1;

    if (questionNumber > this.safetyCapQuestions) {
      await this.finish('Completed');
      return;
    }

    const stage = INTERVIEW_STAGES[this.stageIndex] || {
      key: 'Follow-up',
      prompt: 'Ask one useful academic follow-up question based on the applicant’s previous answers. Do not repeat previous questions.',
      fallbackQuestion: buildDynamicFallbackQuestion(questionNumber, this.responses)
    };

    setStatus('Preparing the next question...', { icon: 'loader-circle' });
    this.setSkipButton(true);

    let result = await this.loadStageQuestion(stage, questionNumber);

    this.targetTotalQuestions = Number(result.targetTotalQuestions || this.targetTotalQuestions || DEFAULT_TARGET_TOTAL_QUESTIONS);
    this.safetyCapQuestions = Number(result.safetyCapQuestions || this.safetyCapQuestions || DEFAULT_SAFETY_CAP_QUESTIONS);

    if ((result.completeInterview || result.shouldFinish) && questionNumber <= this.targetTotalQuestions) {
      debug('Backend completed before target question count; forcing follow-up question', {
        questionNumber,
        targetTotalQuestions: this.targetTotalQuestions,
        reason: result.reason || ''
      });
      result = this.buildLocalFollowUpResult(stage, questionNumber, 'backend-completed-before-target');
    }

    if (result.completeInterview || result.shouldFinish) {
      await this.finish('Completed');
      return;
    }

    const question = result.question;
    this.currentQuestion = question;
    this.currentFocus = result.focusArea || result.stage || stage.key;
    this.currentQuestionType = result.questionType || (questionNumber <= INTERVIEW_STAGES.length ? 'core' : 'follow_up');

    renderQuestion({
      question,
      stageLabel: result.stage || this.currentFocus,
      index: questionNumber,
      total: this.targetTotalQuestions,
      questionType: this.currentQuestionType
    });

    await this.speakQuestion(question);
  }

  async loadStageQuestion(stage, questionNumber) {
    const request = {
      student: this.student,
      questionNumber,
      responses: this.responses,
      stage: stage.key,
      stagePrompt: stage.prompt,
      fallbackQuestion: stage.fallbackQuestion,
      creativity: questionNumber <= INTERVIEW_STAGES.length ? 'moderate' : 'high'
    };

    debug('Next question request', {
      questionNumber: request.questionNumber,
      stage: request.stage,
      responsesCount: request.responses.length,
      creativity: request.creativity
    });

    try {
      const result = await this.api.getNextQuestion(request);

      debug('Next question response', {
        questionNumber: request.questionNumber,
        stage: request.stage,
        completeInterview: Boolean(result.completeInterview || result.shouldFinish),
        returnedQuestion: result.question || '',
        focusArea: result.focusArea || '',
        questionType: result.questionType || ''
      });

      if (result.completeInterview || result.shouldFinish) {
        return result;
      }

      const returnedQuestion = String(result.question || '').trim();

      if (isSafeApplicantQuestion(returnedQuestion, this.student, this.responses)) {
        return {
          ...result,
          question: returnedQuestion
        };
      }

      debug('Question rejected by client guardrail; using stage fallback', returnedQuestion);
    } catch (error) {
      debug('Question service fallback', error.stack || error.message);
    }

    return this.buildLocalFollowUpResult(stage, questionNumber, 'local-fallback');
  }

  buildLocalFollowUpResult(stage, questionNumber, reason) {
    const question = questionNumber <= INTERVIEW_STAGES.length
      ? stage.fallbackQuestion
      : buildDynamicFallbackQuestion(questionNumber, this.responses);

    debug('Using local fallback question', {
      questionNumber,
      stage: stage.key,
      question,
      reason
    });

    return {
      completeInterview: false,
      shouldFinish: false,
      question,
      focusArea: questionNumber <= INTERVIEW_STAGES.length ? stage.key : 'Follow-up',
      stage: questionNumber <= INTERVIEW_STAGES.length ? stage.key : 'Follow-up question',
      questionType: questionNumber <= INTERVIEW_STAGES.length ? 'core-fallback' : 'follow_up_fallback',
      targetTotalQuestions: this.targetTotalQuestions,
      safetyCapQuestions: this.safetyCapQuestions,
      reason
    };
  }

  async speakQuestion(question) {
    this.phase = 'speaking';
    this.resetAnswerCapture();
    this.setSkipButton(true);
    setStatus('Question being asked...', { icon: 'volume-2' });

    try {
      await this.playQuestionAudio(question);
    } catch (error) {
      debug('Question audio fallback', error.stack || error.message);
      await this.browserSpeechFallback(question);
    }

    if (this.phase === 'speaking') this.startListeningWindow();
  }

  async playQuestionAudio(question) {
    const audio = await this.api.getQuestionAudio(question);
    const blob = base64ToBlob(audio.audioBase64, audio.mimeType);
    await this.recorder.playAndRecordAudio(blob);
  }

  browserSpeechFallback(question) {
    return new Promise((resolve) => {
      try {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(question);
        utterance.lang = 'en-GB';
        utterance.rate = 0.92;
        utterance.pitch = 1;
        utterance.onend = resolve;
        utterance.onerror = resolve;
        window.speechSynthesis.speak(utterance);
        window.setTimeout(resolve, Math.max(5000, question.length * 95));
      } catch (error) {
        debug('Browser speech fallback warning', error.message);
        resolve();
      }
    });
  }

  initialiseSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognitionSupported = !!SpeechRecognition;

    if (!SpeechRecognition) {
      debug('Speech recognition unavailable; continuing with microphone activity timing.');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'en-GB';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      this.recognitionActive = true;
      debug('Speech recognition started');
    };

    recognition.onresult = (event) => {
      if (this.phase !== 'listening') return;

      let interim = '';

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcript = event.results[i][0].transcript || '';
        if (event.results[i].isFinal) this.answerFinal += `${transcript} `;
        else interim += transcript;
      }

      this.answerInterim = interim;

      if (this.getCurrentTranscript().trim()) {
        this.heardVoice = true;
        this.lastVoiceAt = Date.now();
      }
    };

    recognition.onerror = (event) => debug('Speech recognition warning', event.error || event.message);
    recognition.onend = () => {
      this.recognitionActive = false;
      if (this.phase !== 'ended' && this.phase !== 'finalising') {
        window.setTimeout(() => this.startRecognitionLoop(), 450);
      }
    };

    this.recognition = recognition;
  }

  startRecognitionLoop() {
    if (!this.recognitionSupported || !this.recognition || this.recognitionActive) return;

    try {
      this.recognition.start();
    } catch (error) {
      debug('Speech recognition start warning', error.message);
    }
  }

  resetAnswerCapture() {
    this.answerFinal = '';
    this.answerInterim = '';
    this.answerStartedAt = null;
    this.lastVoiceAt = null;
    this.heardVoice = false;
    this.completingAnswer = false;
    window.clearInterval(this.answerTimer);
  }

  startListeningWindow() {
    this.phase = 'listening';
    this.answerStartedAt = Date.now();
    this.lastVoiceAt = Date.now();
    setStatus('Listening...', { listening: true, icon: 'audio-lines' });
    this.setSkipButton(false);
    this.startRecognitionLoop();

    this.answerTimer = window.setInterval(() => {
      if (this.phase !== 'listening' || this.completingAnswer) return;

      const now = Date.now();
      const elapsed = now - this.answerStartedAt;
      const level = this.recorder.getVoiceLevel();
      const transcript = this.getCurrentTranscript();
      const hasTranscript = transcript.trim().length >= MIN_TRANSCRIPT_CHARS;

      if (level >= VOICE_LEVEL_THRESHOLD) {
        this.heardVoice = true;
        this.lastVoiceAt = now;
      }

      const silence = now - this.lastVoiceAt;

      if ((hasTranscript || this.heardVoice) && elapsed >= MIN_ANSWER_MS && silence >= SILENCE_MS) {
        this.completeCurrentAnswer('silence');
        return;
      }

      if (!this.heardVoice && elapsed >= MAX_WAIT_FOR_VOICE_MS) {
        setStatus('Please answer clearly now.', { listening: true, icon: 'audio-lines' });
      }

      if (!this.heardVoice && elapsed >= NO_RESPONSE_AUTO_ADVANCE_MS) {
        this.completeCurrentAnswer('no-response-timeout');
        return;
      }

      if (elapsed >= MAX_ANSWER_MS) this.completeCurrentAnswer('max-time');
    }, 350);
  }

  getCurrentTranscript() {
    return `${this.answerFinal} ${this.answerInterim}`.replace(/\s+/g, ' ').trim();
  }

  async completeCurrentAnswer(reason) {
    if (this.completingAnswer) return;
    this.completingAnswer = true;
    this.setSkipButton(true);
    window.clearInterval(this.answerTimer);
    setStatus('Answer captured.', { icon: 'check' });

    let answer = this.getCurrentTranscript();

    if (!answer || answer.length < MIN_TRANSCRIPT_CHARS) {
      answer = 'Spoken response captured in the recorded interview.';
    }

    this.responses.push({
      questionNumber: this.stageIndex + 1,
      question: this.currentQuestion,
      answer,
      focusArea: this.currentFocus,
      stage: this.currentFocus,
      questionType: this.currentQuestionType,
      captureReason: reason
    });

    debug('Answer stored', {
      questionNumber: this.stageIndex + 1,
      responsesCount: this.responses.length,
      stage: this.currentFocus,
      questionType: this.currentQuestionType,
      captureReason: reason,
      answerPreview: answer.slice(0, 120)
    });

    markQuestionComplete(this.stageIndex + 1, this.targetTotalQuestions);
    await wait(900);
    await this.nextQuestion();
  }

  async finish(status) {
    if (this.phase === 'finalising' || this.phase === 'ended') return;

    this.phase = 'finalising';
    this.setSkipButton(true);
    window.clearInterval(this.answerTimer);
    window.clearInterval(this.timerHandle);
    window.speechSynthesis.cancel();
    this.recorder.stopCurrentAudio();
    try { if (this.recognition) this.recognition.stop(); } catch (error) {}

    showScreen('finalisingScreen');
    setUploadProgress(8, 'Preparing your session for upload...');

    try {
      await wait(250);
      setUploadProgress(22, 'Finalising your recording...');
      const blob = await this.recorder.stop();

      setUploadProgress(46, 'Preparing the video file...');
      const uploadPack = await blobToUploadPack(blob);

      setUploadProgress(72, 'Uploading your interview session...');
      const payload = this.buildSubmissionPayload(status, blob, uploadPack);
      await this.api.submitInterview(payload);

      setUploadProgress(100, 'Upload complete. Finalising confirmation...');
      await wait(650);
      this.phase = 'ended';
      showCompletion(true, this.buildReferenceId());
    } catch (error) {
      debug('Final submission warning', error.stack || error.message);
      setUploadProgress(100, 'Your session has been submitted for review.');
      await wait(650);
      this.phase = 'ended';
      showCompletion(false, this.buildReferenceId());
    }
  }

  buildSubmissionPayload(status, blob, uploadPack) {
    const responses = this.responses.length ? this.responses : [{
      questionNumber: this.stageIndex + 1,
      question: this.currentQuestion || 'Interview ended',
      answer: 'Interview ended before a clear spoken response was captured.',
      focusArea: this.currentFocus || 'Interview',
      questionType: this.currentQuestionType || 'unknown'
    }];

    return {
      action: 'submitInterview',
      student: this.student,
      responses,
      summary: buildReviewSummary(status, responses),
      videoBase64: uploadPack.encoded,
      videoMimeType: normaliseVideoMimeType(blob.type || 'video/webm'),
      videoOriginalMimeType: blob.type || 'video/webm',
      videoSizeBytes: blob.size || 0,
      interviewStages: responses.map((response) => response.stage || response.focusArea || ''),
      interviewSettings: {
        minimumCoreQuestions: INTERVIEW_STAGES.length,
        targetTotalQuestions: this.targetTotalQuestions,
        safetyCapQuestions: this.safetyCapQuestions,
        dynamicFollowUpsEnabled: true,
        forcedTargetBeforeCompletion: true
      },
      processingRequested: {
        transcription: true,
        assessmentSummary: true
      },
      recordingDebug: DEBUG ? {
        chunks: this.recorder.chunks.length,
        totalRecordedBytes: this.recorder.totalBytes,
        recorderMimeType: this.recorder.recorder ? this.recorder.recorder.mimeType : '',
        dataUrlPrefix: uploadPack.prefix
      } : undefined
    };
  }

  buildReferenceId() {
    const id = (this.student.studentId || 'UKCD').replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase() || 'UKCD';
    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 12);
    return `UKCD-${id}-${stamp}`;
  }

  setSkipButton(disabled) {
    const skipButton = $('skipQuestionBtn');
    if (skipButton) skipButton.disabled = disabled;
  }
}

function buildDynamicFallbackQuestion(questionNumber, previousResponses = []) {
  const followUps = [
    'Could you expand on your previous answer and give a specific academic example?',
    'What part of this programme do you think will be most challenging for you, and how will you manage it?',
    'Can you give an example of how your previous study or experience has prepared you for this programme?',
    'How do you usually manage independent learning, deadlines, and preparation for assessments?',
    'What specific skills do you expect to develop through this programme, and how will you use them after completion?',
    'Can you explain one practical step you have already taken to prepare for starting this programme?',
    'Which subject area within this programme interests you most, and why?',
    'How will you stay engaged and organised if you find part of the course difficult?'
  ];

  const previousQuestions = previousResponses
    .map((response) => String(response.question || '').trim().toLowerCase())
    .filter(Boolean);

  const startIndex = Math.max(0, questionNumber - INTERVIEW_STAGES.length - 1);

  for (let offset = 0; offset < followUps.length; offset += 1) {
    const question = followUps[(startIndex + offset) % followUps.length];
    if (!previousQuestions.includes(question.toLowerCase())) return question;
  }

  return 'Can you give one more specific example that shows how you are prepared for this programme?';
}

function isSafeApplicantQuestion(question, student = {}, previousResponses = []) {
  const text = String(question || '').trim();
  if (text.length < 10 || text.length > 320) return false;

  const lower = text.toLowerCase();
  const forbidden = /\b(?:ai|groq|google\s+drive|google\s+sheets|api|backend|base64|developer|score|scoring model)\b/i;
  if (forbidden.test(text)) return false;

  if (/\bukcd\b/i.test(text)) return false;

  const explicitInstitution = String(
    student.institution ||
    student.university ||
    student.targetUniversity ||
    student.chosenInstitution ||
    ''
  ).trim();

  const knownInstitutionLeak = /\b(?:university of kent|kingston university|canterbury christ church|cccu)\b/i;
  if (knownInstitutionLeak.test(text)) return false;

  const institutionWording = /\b(?:chosen university|this university|the university|chosen institution|this institution)\b/i;
  if (!explicitInstitution && institutionWording.test(text)) return false;

  const previousQuestions = previousResponses.map((response) => String(response.question || '').trim().toLowerCase()).filter(Boolean);
  if (previousQuestions.includes(lower)) return false;

  return true;
}

function buildReviewSummary(status, responses) {
  const answerText = responses.map((response) => response.answer || '').join(' ');
  const wordCount = answerText.trim() ? answerText.trim().split(/\s+/).length : 0;

  return [
    `Interview status: ${status}`,
    `Questions answered: ${responses.length}`,
    `Captured spoken response word count: ${wordCount}`,
    'Review note: This pilot summary is for admissions review support. Final decisions should follow the agreed review process.'
  ].join('\n');
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
