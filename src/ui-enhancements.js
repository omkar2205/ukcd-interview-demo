import { $, markQuestionComplete, setStatus } from './ui.js';
import { InterviewController, INTERVIEW_STAGES } from './interview.js';

const originalStart = InterviewController.prototype.start;
const originalSpeakQuestion = InterviewController.prototype.speakQuestion;
const originalStartListeningWindow = InterviewController.prototype.startListeningWindow;
const originalCompleteCurrentAnswer = InterviewController.prototype.completeCurrentAnswer;
const originalFinish = InterviewController.prototype.finish;

InterviewController.prototype.start = async function patchedStart() {
  const skipButton = $('skipQuestionBtn');
  if (skipButton) {
    skipButton.disabled = true;
    skipButton.onclick = () => this.skipQuestion();
  }

  return originalStart.call(this);
};

InterviewController.prototype.speakQuestion = async function patchedSpeakQuestion(question) {
  toggleSkipButton(true);
  return originalSpeakQuestion.call(this, question);
};

InterviewController.prototype.startListeningWindow = function patchedStartListeningWindow() {
  originalStartListeningWindow.call(this);
  toggleSkipButton(false);
};

InterviewController.prototype.completeCurrentAnswer = async function patchedCompleteCurrentAnswer(reason) {
  toggleSkipButton(true);
  return originalCompleteCurrentAnswer.call(this, reason);
};

InterviewController.prototype.finish = async function patchedFinish(status) {
  toggleSkipButton(true);
  return originalFinish.call(this, status);
};

InterviewController.prototype.skipQuestion = async function skipQuestion() {
  if (!this.currentQuestion || this.phase === 'finalising' || this.phase === 'ended' || this.completingAnswer) return;

  if (this.phase !== 'listening') {
    setStatus('Please wait until the question has finished.', { icon: 'loader-circle' });
    return;
  }

  this.completingAnswer = true;
  toggleSkipButton(true);
  window.clearInterval(this.answerTimer);

  this.responses.push({
    questionNumber: this.stageIndex + 1,
    question: this.currentQuestion,
    answer: 'Question skipped by applicant.',
    focusArea: this.currentFocus,
    stage: this.currentFocus,
    captureReason: 'skipped'
  });

  markQuestionComplete(this.stageIndex + 1, INTERVIEW_STAGES.length);
  setStatus('Question skipped.', { icon: 'check' });
  await wait(450);
  await this.nextQuestion();
};

function toggleSkipButton(disabled) {
  const skipButton = $('skipQuestionBtn');
  if (skipButton) skipButton.disabled = disabled;
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
