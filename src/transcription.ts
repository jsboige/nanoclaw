import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

interface AsrConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

let cachedConfig: AsrConfig | null | undefined = undefined;

function loadConfig(): AsrConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;

  const env = readEnvFile(['ASR_BASE_URL', 'ASR_API_KEY', 'ASR_MODEL']);
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
  };
  return cachedConfig;
}

export function isTranscriptionEnabled(): boolean {
  return loadConfig() !== null;
}

/**
 * Transcribe an audio file via an OpenAI-compatible /audio/transcriptions endpoint.
 * Returns the transcript text, or null if transcription is disabled or fails.
 *
 * Bearer auth via ASR_API_KEY, endpoint via ASR_BASE_URL (e.g. https://whisper-api.myia.io/v1).
 * Supports ogg/opus directly (faster-whisper decodes natively — no re-encoding needed).
 */
export async function transcribeAudioFile(
  localPath: string,
): Promise<string | null> {
  const config = loadConfig();
  if (!config) return null;

  if (!fs.existsSync(localPath)) {
    logger.warn({ localPath }, 'Transcription: file not found');
    return null;
  }

  try {
    const buffer = fs.readFileSync(localPath);
    const filename = path.basename(localPath);
    const ext = path.extname(filename).toLowerCase();
    const mime = mimeForExt(ext);

    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), filename);
    form.append('model', config.model);

    const url = `${config.baseUrl}/audio/transcriptions`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      logger.warn(
        { status: resp.status, body: body.slice(0, 200) },
        'Transcription request failed',
      );
      return null;
    }

    const data = (await resp.json()) as { text?: string };
    const text = (data.text || '').trim();
    if (!text) {
      logger.debug({ localPath }, 'Transcription returned empty text');
      return null;
    }

    logger.info(
      { localPath, chars: text.length },
      'Transcribed voice message',
    );
    return text;
  } catch (err) {
    logger.error({ localPath, err }, 'Transcription error');
    return null;
  }
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

/** For tests: reset the cached config so env changes take effect. */
export function resetTranscriptionConfigForTests(): void {
  cachedConfig = undefined;
}
