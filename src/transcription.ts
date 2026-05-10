import { log } from './log.js';
import { readEnvFile } from './env.js';

interface AsrConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  language?: string;
  prompt?: string;
}

let cachedConfig: AsrConfig | null | undefined = undefined;

function loadConfig(): AsrConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;

  const env = readEnvFile(['ASR_BASE_URL', 'ASR_API_KEY', 'ASR_MODEL', 'ASR_LANGUAGE', 'ASR_PROMPT']);
  const baseUrl = process.env.ASR_BASE_URL || env.ASR_BASE_URL;
  const apiKey = process.env.ASR_API_KEY || env.ASR_API_KEY;

  if (!baseUrl || !apiKey) {
    cachedConfig = null;
    return null;
  }

  cachedConfig = {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model: process.env.ASR_MODEL || env.ASR_MODEL || 'whisper-1',
    language: process.env.ASR_LANGUAGE || env.ASR_LANGUAGE || undefined,
    prompt: process.env.ASR_PROMPT || env.ASR_PROMPT || undefined,
  };
  return cachedConfig;
}

export function isTranscriptionEnabled(): boolean {
  return loadConfig() !== null;
}

// [PATCH-myia #20] Retry on transient ASR failures.
// Observed 2026-05-10: 5× fetch failed (SSL/network) + 2× 500 Internal Server
// Error spread across the day, while the same endpoint also produced 142
// successful transcriptions. The drops are silent from the user's POV (no
// 🎤 echo, agent never sees the [Voice: ...] inline) → the bot looks like
// it ignored the voice message. Retrying transient failures fixes the
// user-visible symptom without masking persistent outages.
const TRANSCRIBE_MAX_ATTEMPTS = 3;
const TRANSCRIBE_RETRY_BACKOFF_MS = [200, 600];

function buildTranscribeForm(buffer: Buffer, filename: string, mimeType: string, config: AsrConfig): FormData {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  form.append('model', config.model);
  if (config.language) form.append('language', config.language);
  if (config.prompt) form.append('prompt', config.prompt);
  return form;
}

/**
 * Transcribe an in-memory audio buffer via an OpenAI-compatible
 * /audio/transcriptions endpoint. Returns transcript text, or null if
 * transcription is disabled or fails.
 *
 * v2 chat-sdk-bridge already holds the audio buffer from att.fetchData() —
 * no disk round-trip needed. Bearer auth via ASR_API_KEY, endpoint via
 * ASR_BASE_URL (e.g. https://whisper-api.myia.io/v1). Supports ogg/opus
 * directly (faster-whisper decodes natively).
 *
 * Retries up to 3 attempts on transient failures (network errors,
 * 5xx server errors). Returns null on persistent failure or 4xx.
 */
export async function transcribeAudioBuffer(
  buffer: Buffer,
  filename: string,
  mimeType?: string,
): Promise<string | null> {
  const config = loadConfig();
  if (!config) return null;

  const mime = mimeType || mimeForExt(extFromName(filename));
  const url = `${config.baseUrl}/audio/transcriptions`;

  for (let attempt = 1; attempt <= TRANSCRIBE_MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}` },
        body: buildTranscribeForm(buffer, filename, mime, config),
      });

      if (resp.ok) {
        const data = (await resp.json()) as { text?: string };
        const text = (data.text || '').trim();
        if (!text) {
          log.debug('Transcription returned empty text', { filename });
          return null;
        }
        if (attempt > 1) {
          log.info('Transcribed voice message (after retry)', { filename, chars: text.length, attempt });
        } else {
          log.info('Transcribed voice message', { filename, chars: text.length });
        }
        return text;
      }

      const body = await resp.text().catch(() => '');
      const isTransient = resp.status >= 500 && resp.status < 600;
      if (isTransient && attempt < TRANSCRIBE_MAX_ATTEMPTS) {
        const backoff = TRANSCRIBE_RETRY_BACKOFF_MS[attempt - 1];
        log.warn('Transcription request failed (retrying)', {
          status: resp.status,
          attempt,
          backoffMs: backoff,
          body: body.slice(0, 200),
        });
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      log.warn('Transcription request failed', { status: resp.status, attempt, body: body.slice(0, 200) });
      return null;
    } catch (err) {
      // Network errors (TypeError "fetch failed", DNS, SSL handshake) — retry.
      if (attempt < TRANSCRIBE_MAX_ATTEMPTS) {
        const backoff = TRANSCRIBE_RETRY_BACKOFF_MS[attempt - 1];
        log.warn('Transcription network error (retrying)', { filename, attempt, backoffMs: backoff, err });
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      log.error('Transcription error', { filename, attempt, err });
      return null;
    }
  }
  return null;
}

function extFromName(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

function mimeForExt(ext: string): string {
  switch (ext) {
    case '.ogg':
    case '.oga':
      return 'audio/ogg';
    case '.opus':
      return 'audio/opus';
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.m4a':
      return 'audio/mp4';
    case '.flac':
      return 'audio/flac';
    default:
      return 'application/octet-stream';
  }
}

/** For tests: reset cached config so env changes take effect. */
export function resetTranscriptionConfigForTests(): void {
  cachedConfig = undefined;
}
