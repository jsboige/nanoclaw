import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock env reader
vi.mock('./env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { readEnvFile } from './env.js';
import {
  isTranscriptionEnabled,
  resetTranscriptionConfigForTests,
  transcribeAudioFile,
} from './transcription.js';

const readEnvFileMock = vi.mocked(readEnvFile);

describe('transcription', () => {
  beforeEach(() => {
    resetTranscriptionConfigForTests();
    delete process.env.ASR_BASE_URL;
    delete process.env.ASR_API_KEY;
    delete process.env.ASR_MODEL;
    readEnvFileMock.mockReset();
    readEnvFileMock.mockReturnValue({});

    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('fake-audio'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetTranscriptionConfigForTests();
  });

  describe('isTranscriptionEnabled', () => {
    it('returns false when ASR_BASE_URL is missing', () => {
      readEnvFileMock.mockReturnValue({ ASR_API_KEY: 'k' });
      expect(isTranscriptionEnabled()).toBe(false);
    });

    it('returns false when ASR_API_KEY is missing', () => {
      readEnvFileMock.mockReturnValue({
        ASR_BASE_URL: 'https://asr.example/v1',
      });
      expect(isTranscriptionEnabled()).toBe(false);
    });

    it('returns true when both are set', () => {
      readEnvFileMock.mockReturnValue({
        ASR_BASE_URL: 'https://asr.example/v1',
        ASR_API_KEY: 'secret',
      });
      expect(isTranscriptionEnabled()).toBe(true);
    });
  });

  describe('transcribeAudioFile', () => {
    const validEnv = {
      ASR_BASE_URL: 'https://asr.example/v1',
      ASR_API_KEY: 'secret-token',
    };

    it('returns null when not configured', async () => {
      readEnvFileMock.mockReturnValue({});
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await transcribeAudioFile('/tmp/voice.oga');

      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns null when file does not exist', async () => {
      readEnvFileMock.mockReturnValue(validEnv);
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await transcribeAudioFile('/tmp/missing.oga');

      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('posts multipart form with bearer auth and returns transcript', async () => {
      readEnvFileMock.mockReturnValue(validEnv);

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ text: '  Hello world  ' }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await transcribeAudioFile('/tmp/voice.oga');

      expect(result).toBe('Hello world');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://asr.example/v1/audio/transcriptions');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer secret-token');
      expect(init.body).toBeInstanceOf(FormData);
      const form = init.body as FormData;
      expect(form.get('model')).toBe('whisper-1');
      expect(form.get('file')).toBeInstanceOf(Blob);
    });

    it('strips trailing slashes from base URL', async () => {
      readEnvFileMock.mockReturnValue({
        ASR_BASE_URL: 'https://asr.example/v1///',
        ASR_API_KEY: 'k',
      });

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ text: 'ok' }),
      });
      vi.stubGlobal('fetch', fetchMock);

      await transcribeAudioFile('/tmp/v.oga');

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('https://asr.example/v1/audio/transcriptions');
    });

    it('uses custom model when ASR_MODEL is set', async () => {
      readEnvFileMock.mockReturnValue({
        ...validEnv,
        ASR_MODEL: 'large-v3-turbo',
      });

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ text: 'ok' }),
      });
      vi.stubGlobal('fetch', fetchMock);

      await transcribeAudioFile('/tmp/v.oga');

      const form = fetchMock.mock.calls[0][1].body as FormData;
      expect(form.get('model')).toBe('large-v3-turbo');
    });

    it('returns null on non-OK response', async () => {
      readEnvFileMock.mockReturnValue(validEnv);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          text: vi.fn().mockResolvedValue('unauthorized'),
        }),
      );

      const result = await transcribeAudioFile('/tmp/v.oga');
      expect(result).toBeNull();
    });

    it('returns null on empty transcript', async () => {
      readEnvFileMock.mockReturnValue(validEnv);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue({ text: '   ' }),
        }),
      );

      const result = await transcribeAudioFile('/tmp/v.oga');
      expect(result).toBeNull();
    });

    it('returns null when fetch throws', async () => {
      readEnvFileMock.mockReturnValue(validEnv);

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));

      const result = await transcribeAudioFile('/tmp/v.oga');
      expect(result).toBeNull();
    });

    it('prefers process.env over .env file values', async () => {
      readEnvFileMock.mockReturnValue({
        ASR_BASE_URL: 'https://file.example/v1',
        ASR_API_KEY: 'from-file',
      });
      process.env.ASR_BASE_URL = 'https://env.example/v1';
      process.env.ASR_API_KEY = 'from-env';

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ text: 'ok' }),
      });
      vi.stubGlobal('fetch', fetchMock);

      await transcribeAudioFile('/tmp/v.oga');

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://env.example/v1/audio/transcriptions');
      expect(init.headers.Authorization).toBe('Bearer from-env');
    });
  });
});
