# UKCD Digital Interview

Static GitHub Pages app for the UKCD Digital Interview applicant flow.

## Structure

- `index.html` - page shell, Tailwind CDN setup, applicant screens, Lucide icons.
- `styles/main.css` - premium academic visual system and responsive refinements.
- `src/app.js` - page wiring, validation, media readiness checks.
- `src/api.js` - existing Apps Script web app integration.
- `src/recorder.js` - camera/microphone capture, MP4-first recording selection, upload packaging.
- `src/interview.js` - fixed-stage automatic interview loop.
- `src/ui.js` - screen state, applicant-facing messages, hidden debug panel.

## Behaviour

The applicant confirms details, completes a readiness check, then answers a fixed-stage interview. Questions are played aloud one at a time. The browser records only the applicant camera and microphone; interviewer question audio is not mixed into the saved video.

The final submission keeps the existing payload shape used by the current Apps Script and Sheet workflow:

- `student`
- `responses`
- `summary`
- `videoBase64`
- `videoMimeType`
- `videoOriginalMimeType`
- `videoSizeBytes`
- optional `recordingDebug` when `?debug=true`

Additional fields such as `interviewStages` and `processingRequested` are included for downstream processing while preserving the existing columns.

## Debug Mode

Debug output is hidden by default and is enabled only when the page URL includes:

```text
?debug=true
```

## Deployment

This app is designed to run directly from GitHub Pages with no build step. Tailwind CSS and Lucide icons are loaded from CDNs.
