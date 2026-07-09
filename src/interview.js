import { base64ToBlob } from './api.js';
import { blobToUploadPack, normaliseVideoMimeType } from './recorder.js';
import {
  $, DEBUG, debug, markQuestionComplete, renderQuestion, setStatus,
  showCompletion, showScreen, updateTimer
} from './ui.js';

const SILENCE_MS = 3000;
const MIN_ANSWER_MS = 4500;
const MAX_ANSWER_MS = 65000;
const MAX_WAIT_FOR_VOICE_MS = 14000;
const NO_RESPONSE_AUTO_ADVANCE_MS = 24000;
const MIN_TRANSCRIPT_CHARS = 10;
const VOICE_LEVEL_THRESHOLD = 0.026;

export const INTERVIEW_STAGES = [
  {
    key: 'Introduction',
    prompt: 'Confirm identity and chosen programme. Do not mention any institution name unless explicitly provided by the applicant.',
    fallbackQuestion: 'Please introduce yourself and confirm the programme you are applying for.'
  },
  {
    key: 'Programme Motivation',
    prompt: 'Explore why the applicant chose this programme. Do not mention UKCD as an institution.',
    fallbackQuestion: 'Why have you chosen this programme?'
  },
  {
    key: 'Academic or Work Background',
    prompt: 'Explore prior study or work experience linked to the chosen programme.',
    fallbackQuestion: 'How does your previous study or work experience relate to this programme?'
  },
  {
    key: 'Career Goals',
    prompt: 'Explore future career goals after completing the programme.',
    fallbackQuestion: 'How will this programme support your future career goals?'
  },
  {
    key: 'Funding and Study Preparedness',
    prompt: 'Explore funding awareness and practical study preparedness.',
    fallbackQuestion: 'How are you planning to fund your studies and living costs?'
  },
  {
    key: 'UK Study Awareness',
    prompt: 'Explore understanding of UK study expectations and student responsibilities.',
    fallbackQuestion: 'What do you understand about studying in the UK and managing your responsibilities as a student?'
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
    this.currentAudio = null;
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
    await this.nextQuestion();
  }

  async replayQuestion() {
    if (!this.currentQuestion || this.phase === 'finalising') return;
    window.clearInterval(this.answerTimer);
    this.completingAnswer = false;
    setStatus('The question will be played again.', { icon: 'rotate-ccw' });
    await wait(800);
    await this.speakQuestion(this.currentQuestion);
  }

  async endSession() {
    await this.finish('Ended by applicant');
  }

  async nextQuestion() {
    this.stageIndex += 1;
    const stage = INTERVIEW_STAGES[this.stageIndex];

    if (!stage) {
      await this.finish('Completed');
      return;
    }

    setStatus('Preparing the next question...', { icon: 'loader-circle' });
    const question = await this.loadStageQuestion(stage);
    this.currentQuestion = question;
    this.currentFocus = stage.key;

    renderQuestion({
      question,
      stageLabel: stage.key,
      index: this.stageIndex + 1,
      total: INTERVIEW_STAGES.length
    });

    await this.speakQuestion(question);
  }

  async loadStageQuestion(stage) {
    const request = {
      student: this.student,
      questionNumber: this.stageIndex + 1,
      responses: this.responses,
      stage: stage.key,
      stagePrompt: stage.prompt
    };

    debug('Next question request', {
      questionNumber: request.questionNumber,
      stage: request.stage,
      responsesCount: request.responses.length
    });

    try {
      const result = await this.api.getNextQuestion(request);
      const returnedQuestion = String(result.question || '').trim();

      debug('Next question response', {
        questionNumber: request.questionNumber,
        stage: request.stage,
        returnedQuestion,
        focusArea: result.focusArea || ''
      });

      if (isSafeApplicantQuestion(returnedQuestion, this.student, this.responses)) {
        return returnedQuestion;
      }

      debug('Question rejected by client guardrail; using stage fallback', returnedQuestion);
    } catch (error) {
      debug('Question service fallback', error.stack || error.message);
    }

    debug('Using fallback question', {
      questionNumber: this.stageIndex + 1,
      stage: stage.key,
      question: stage.fallbackQuestion
    });

    return stage.fallbackQuestion;
  }

  async speakQuestion(question) {
    this.phase = 'speaking';
    this.resetAnswerCapture();
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
    const objectUrl = URL.createObjectURL(blob);

    await new Promise((resolve, reject) => {
      const player = new Audio(objectUrl);
      this.currentAudio = player;
      let completed = false;

      const finish = (error) => {
        if (completed) return;
        completed = true;
        URL.revokeObjectURL(objectUrl);
        this.currentAudio = null;
        if (error) reject(error);
        else resolve();
      };

      player.onended = () => finish();
      player.onerror = () => finish(new Error('Question audio could not be played.'));
      player.play().catch(finish);
      window.setTimeout(() => finish(), Math.max(5000, question.length * 100));
    });
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
      captureReason: reason
    });

    debug('Answer stored', {
      questionNumber: this.stageIndex + 1,
      responsesCount: this.responses.length,
      stage: this.currentFocus,
      captureReason: reason,
      answerPreview: answer.slice(0, 120)
    });

    markQuestionComplete(this.stageIndex + 1, INTERVIEW_STAGES.length);
    await wait(900);
    await this.nextQuestion();
  }

  async finish(status) {
    if (this.phase === 'finalising' || this.phase === 'ended') return;

    this.phase = 'finalising';
    window.clearInterval(this.answerTimer);
    window.clearInterval(this.timerHandle);
    window.speechSynthesis.cancel();
    if (this.currentAudio) this.currentAudio.pause();
    try { if (this.recognition) this.recognition.stop(); } catch (error) {}

    showScreen('finalisingScreen');

    try {
      const blob = await this.recorder.stop();
      const uploadPack = await blobToUploadPack(blob);
      const payload = this.buildSubmissionPayload(status, blob, uploadPack);
      await this.api.submitInterview(payload);
      this.phase = 'ended';
      showCompletion(true, this.buildReferenceId());
    } catch (error) {
      debug('Final submission warning', error.stack || error.message);
      this.phase = 'ended';
      showCompletion(false, this.buildReferenceId());
    }
  }

  buildSubmissionPayload(status, blob, uploadPack) {
    const responses = this.responses.length ? this.responses : [{
      questionNumber: this.stageIndex + 1,
      question: this.currentQuestion || 'Interview ended',
      answer: 'Interview ended before a clear spoken response was captured.',
      focusArea: this.currentFocus || 'Interview'
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
      interviewStages: INTERVIEW_STAGES.map((stage) => stage.key),
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
}

function isSafeApplicantQuestion(question, student = {}, previousResponses = []) {
  const text = String(question || '').trim();
  if (text.length < 12 || text.length > 220) return false;

  const lower = text.toLowerCase();
  const forbidden = /\b(?:ai|groq|google\s+drive|google\s+sheets|api|backend|base64|developer)\b/i;
  if (forbidden.test(text)) return false;

  // UKCD is the interview brand/platform, not the applicant's institution.
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
