// YouTube URL handling and fail-closed, current-tab Region Capture.
// Playback remains in the embedded player. This module never requests a
// microphone, clones a video track, or connects captured audio to speakers.

const YOUTUBE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtube-nocookie.com', 'www.youtube-nocookie.com'
]);
const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const DESKTOP_HELP = 'Use a current desktop version of Chrome or Edge.';
let pageCaptureHandle = null;

function inputError(message, code, cause) {
  const error = new Error(message);
  error.name = 'YouTubeInputError';
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function timestampSeconds(value) {
  if (!value) return 0;
  const text = String(value).trim().toLowerCase();
  let seconds = 0;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    seconds = Number(text);
  } else {
    const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(text);
    if (!parts || !parts.slice(1).some(part => part !== undefined)) return 0;
    seconds = Number(parts[1] || 0) * 3600 + Number(parts[2] || 0) * 60 + Number(parts[3] || 0);
  }
  // Invalid, negative or excessive timestamps must never reach the player.
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 2147483647 ? seconds : 0;
}

/** Parse a YouTube watch/share/shorts/embed/live URL; invalid links throw. */
export function parseYouTubeURL(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text || text.length > 8192) {
    throw inputError('Paste a valid YouTube video URL.', 'invalid-url');
  }
  let url;
  try {
    // Copied links normally include a scheme; also accept familiar bare hosts.
    const hasScheme = /^[A-Za-z][A-Za-z\d+.-]*:/.test(text);
    url = new URL(hasScheme ? text : 'https://' + text);
  } catch (cause) {
    throw inputError('Paste a valid YouTube video URL.', 'invalid-url', cause);
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw inputError('Use a standard http or https YouTube video URL.', 'invalid-url');
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.split('/').filter(Boolean);
  let id;
  if (SHORT_HOSTS.has(host) && path.length === 1) {
    id = path[0];
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (path.length === 1 && path[0] === 'watch' && !host.includes('nocookie')) {
      id = url.searchParams.get('v');
    } else if (path.length === 2 && ['shorts', 'embed', 'live'].includes(path[0])) {
      id = path[1];
    }
  }
  if (!id || !VIDEO_ID.test(id)) {
    throw inputError('Use a YouTube video link, such as youtube.com/watch?v=… or youtu.be/….', 'invalid-url');
  }
  const hash = new URLSearchParams(url.hash.slice(1));
  const time = url.searchParams.get('t') ?? url.searchParams.get('start') ?? hash.get('t');
  return { id, startSeconds: timestampSeconds(time) };
}

/** Capability check only: permission, actual tab audio and crop are verified later. */
export function youtubeSupport() {
  const protocol = globalThis.location?.protocol;
  if (!globalThis.isSecureContext || !['https:', 'http:'].includes(protocol)) {
    return {
      supported: false,
      message: 'YouTube analysis needs HTTPS or localhost. Open the hosted demo in a supported desktop browser.'
    };
  }
  const media = globalThis.navigator?.mediaDevices;
  if (typeof media?.getDisplayMedia !== 'function') {
    return { supported: false, message: 'This browser cannot share a tab for YouTube analysis. ' + DESKTOP_HELP };
  }
  if (typeof globalThis.CropTarget?.fromElement !== 'function' ||
      typeof media.setCaptureHandleConfig !== 'function') {
    return {
      supported: false,
      message: 'This browser cannot verify and isolate the YouTube player with tab audio. ' + DESKTOP_HELP +
        ' Whole-page capture and microphone input are not used.'
    };
  }
  return {
    supported: true,
    message: 'Share this tab and enable “Share tab audio”. Only the player region and captured soundtrack will be analysed.'
  };
}

function stopTracks(stream) {
  for (const track of stream?.getTracks?.() || []) {
    try { track.stop(); } catch (_) { /* Continue releasing every track. */ }
  }
}

function configureCaptureHandle() {
  if (!pageCaptureHandle) {
    const crypto = globalThis.crypto;
    if (typeof crypto?.randomUUID === 'function') {
      pageCaptureHandle = 'mcd-youtube-' + crypto.randomUUID();
    } else if (typeof crypto?.getRandomValues === 'function') {
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      pageCaptureHandle = 'mcd-youtube-' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    } else {
      throw inputError('This browser cannot verify the shared tab. ' + DESKTOP_HELP, 'unsupported');
    }
  }
  try {
    globalThis.navigator.mediaDevices.setCaptureHandleConfig({
      handle: pageCaptureHandle,
      exposeOrigin: true,
      permittedOrigins: [globalThis.location.origin]
    });
  } catch (cause) {
    throw inputError('This browser cannot verify the shared tab. Open the demo directly in its own tab. ' + DESKTOP_HELP,
      'unsupported', cause);
  }
}

function isOwnTab(track) {
  try {
    const handle = track.getCaptureHandle();
    return track.getSettings().displaySurface === 'browser' &&
      handle?.handle === pageCaptureHandle && handle?.origin === globalThis.location.origin;
  } catch (_) {
    return false;
  }
}

function liveTrack(track) {
  return !!track && track.readyState === 'live' && track.enabled !== false;
}

function captureRequestError(error) {
  if (error?.name === 'YouTubeInputError') return error;
  const messages = {
    NotAllowedError: 'Tab sharing was cancelled or denied. Try again, choose this tab and enable “Share tab audio”.',
    InvalidStateError: 'Start tab sharing with a fresh click on the YouTube share button while this tab is active.',
    NotReadableError: 'The browser or operating system could not capture this tab. Check screen-recording permission, then try again.',
    NotFoundError: 'The browser could not find a shareable tab. ' + DESKTOP_HELP,
    AbortError: 'Tab sharing was interrupted. Please try again.',
    NotSupportedError: 'This browser does not support the required tab capture. ' + DESKTOP_HELP,
    TypeError: 'This browser does not support the required tab-capture options. ' + DESKTOP_HELP
  };
  return inputError(messages[error?.name] || 'Could not start YouTube tab capture. Please share this tab with audio again.',
    'capture-failed', error);
}

/**
 * Must be called directly from a user gesture: getDisplayMedia precedes all awaits.
 * Resolves only after same-tab, soundtrack and native Region Capture checks pass.
 * Region Capture includes visible YouTube overlays; it cannot expose hidden pixels.
 * isCurrent invalidates an in-flight request when the caller changes input/stops.
 */
export async function acquireYouTubeTab(region, { isCurrent = () => true, onEnded = () => {} } = {}) {
  const support = youtubeSupport();
  if (!support.supported) throw inputError(support.message, 'unsupported');
  if (!region || region.isConnected === false || typeof region.getBoundingClientRect !== 'function') {
    throw inputError('The YouTube player is not available to capture. Load a video and try again.', 'missing-player');
  }
  const assertCurrent = () => {
    if (!isCurrent()) throw inputError('YouTube tab sharing was cancelled because the input changed.', 'cancelled');
  };
  assertCurrent();
  configureCaptureHandle();
  let stream;
  try {
    // These are chooser preferences, not guarantees; validate the returned track.
    // Keep the original player audible. Captured audio is never replayed here.
    const request = globalThis.navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', frameRate: { ideal: 30 } },
      audio: {
        suppressLocalAudioPlayback: false,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      systemAudio: 'exclude',
      windowAudio: 'exclude',
      surfaceSwitching: 'exclude',
      monitorTypeSurfaces: 'exclude'
    });
    stream = await request;
    assertCurrent();
    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = stream.getAudioTracks()[0];
    if (!liveTrack(videoTrack)) {
      throw inputError('No live tab video was shared. Try again and choose this tab.', 'missing-video');
    }
    if (typeof videoTrack.getCaptureHandle !== 'function' || typeof videoTrack.cropTo !== 'function') {
      throw inputError('This browser cannot verify and crop the shared player. ' + DESKTOP_HELP,
        'unsupported');
    }
    if (!isOwnTab(videoTrack)) {
      throw inputError('Please share this MCD tab containing the YouTube player, rather than another tab, a window or the entire screen.',
        'wrong-tab');
    }
    if (!liveTrack(audioTrack)) {
      throw inputError('No tab audio was shared. Share this tab again and enable “Share tab audio”. Your microphone will not be used.',
        'missing-audio');
    }
    try {
      const target = await globalThis.CropTarget.fromElement(region);
      assertCurrent();
      await videoTrack.cropTo(target);
    } catch (cause) {
      if (cause?.name === 'YouTubeInputError') throw cause;
      throw inputError('The browser could not isolate the YouTube player. Sharing has stopped. ' + DESKTOP_HELP +
        ' Share this tab again; the whole page will not be analysed.', 'crop-failed', cause);
    }
    assertCurrent();
    if (!liveTrack(videoTrack) || !liveTrack(audioTrack) || !isOwnTab(videoTrack)) {
      throw inputError('The shared tab or its audio changed before capture was ready. Share this tab with audio again.',
        'capture-changed');
    }

    let released = false;
    const listeners = [];
    const listen = (track, type, handler) => {
      track.addEventListener(type, handler);
      listeners.push([track, type, handler]);
    };
    const release = () => {
      if (released) return;
      released = true;
      for (const [track, type, handler] of listeners) track.removeEventListener(type, handler);
      stopTracks(stream);
    };
    const endUnexpectedly = message => {
      if (released) return;
      release();
      onEnded(message);
    };
    listen(videoTrack, 'ended', () => endUnexpectedly('Tab sharing ended. Share this tab again to resume YouTube analysis.'));
    listen(audioTrack, 'ended', () => endUnexpectedly('The shared soundtrack ended. Share this tab again with “Share tab audio” enabled.'));
    listen(videoTrack, 'capturehandlechange', () => {
      if (!isOwnTab(videoTrack)) {
        endUnexpectedly('The shared tab changed. Capture stopped to avoid analysing the wrong input. Share this MCD tab again.');
      }
    });
    return {
      stream,
      videoTrack,
      audioTrack,
      cropped: true,
      currentTabVerified: true,
      isValid: () => !released && isCurrent() && stream.active !== false &&
        liveTrack(videoTrack) && liveTrack(audioTrack) && isOwnTab(videoTrack),
      release
    };
  } catch (error) {
    stopTracks(stream);
    throw captureRequestError(error);
  }
}
