// Existing live service deployment used by the admissions workflow.
const SERVICE_URL = 'https://script.google.com/macros/s/AKfycbzoWg2qqUeVKyNJHkSyOMkVxVAgvX_8W372oNHV8rzHXnFP8OXBeemZN1yAoTZq00-6Lg/exec';

export class InterviewApi {
  constructor(debug = () => {}) {
    this.debug = debug;
  }

  async getQuestionAudio(question) {
    const result = await jsonpRequest(SERVICE_URL, {
      action: 'tts',
      text: question
    }, 26000);

    if (!result || !result.ok || !result.audioBase64) {
      throw new Error(result && result.message ? result.message : 'No audio returned.');
    }

    return {
      audioBase64: result.audioBase64,
      mimeType: result.mimeType || 'audio/mpeg',
      byteLength: result.byteLength || 0
    };
  }

  async getNextQuestion(payload) {
    const requestBody = {
      action: 'nextQuestion',
      student: payload.student,
      questionNumber: payload.questionNumber,
      responses: payload.responses
    };

    this.debug('Requesting next question', {
      questionNumber: requestBody.questionNumber,
      responseCount: requestBody.responses.length
    });

    const result = await postJson(SERVICE_URL, requestBody, 14000);

    if (!result || !result.ok || !result.question) {
      throw new Error(result && result.message ? result.message : 'No question returned.');
    }

    return {
      question: String(result.question).trim(),
      focusArea: result.focusArea || payload.stage || 'Suitability'
    };
  }

  async submitInterview(payload) {
    this.debug('Submitting final interview package', {
      responses: payload.responses.length,
      videoMimeType: payload.videoMimeType,
      videoSizeBytes: payload.videoSizeBytes
    });

    await fetch(SERVICE_URL, {
      method: 'POST',
      mode: 'no-cors',
      body: JSON.stringify(payload)
    });

    return true;
  }
}

export function dataUrlPayload(dataUrl) {
  const value = String(dataUrl || '');
  const comma = value.lastIndexOf(',');
  return comma === -1 ? '' : value.slice(comma + 1);
}

export function base64ToBlob(encoded, mimeType) {
  const clean = String(encoded || '').replace(/\s/g, '');
  const binary = window.atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes.buffer], { type: mimeType || 'audio/mpeg' });
}

function jsonpRequest(baseUrl, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const callbackName = `ukcd_jsonp_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const url = new URL(baseUrl);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    });
    url.searchParams.set('callback', callbackName);

    const script = document.createElement('script');
    let finished = false;
    const timer = window.setTimeout(() => {
      cleanup(() => reject(new Error('The request took longer than expected.')));
    }, timeoutMs || 12000);

    window[callbackName] = (data) => cleanup(() => resolve(data));
    script.onerror = () => cleanup(() => reject(new Error('The interview service could not be reached.')));
    script.src = url.toString();
    document.body.appendChild(script);

    function cleanup(next) {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      try {
        delete window[callbackName];
      } catch (error) {
        window[callbackName] = undefined;
      }
      if (script.parentNode) script.parentNode.removeChild(script);
      next();
    }
  });
}

async function postJson(url, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs || 12000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}.`);
    }

    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } finally {
    window.clearTimeout(timer);
  }
}
