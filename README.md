# Podcast Transcript Desk

A local Windows-friendly tool for turning podcast links into full transcripts and short summaries.

## Default Pipeline

The default pipeline uses SiliconFlow only:

```text
Audio transcription: FunAudioLLM/SenseVoiceSmall
Summary: Qwen/Qwen3.5-4B
```

## Run

Edit `.env` first:

```text
SILICONFLOW_API_KEY=your_siliconflow_api_key
```

Then run:

```powershell
npm start
```

Open the URL printed in the terminal, for example:

```text
Podcast transcript desk running at http://127.0.0.1:5173
```

If port `5173` is busy, the server tries `5174`, `5175`, and later ports.

## Portable Use On Another PC

1. Install Node.js 18 or newer on the target PC.
2. Unzip this project.
3. Edit `.env` and fill `SILICONFLOW_API_KEY`.
4. Run:

```powershell
.\start-portable.ps1
```

The package includes local `yt-dlp` and `ffmpeg-static`.

## Speaker Labels

Speaker labeling is enabled by default after transcription.

```text
ENABLE_SPEAKER_LABELING=true
SPEAKER_LABEL_MODEL=Qwen/Qwen3.5-4B
```

It is a text-based post-process. It can infer names from introductions and context, but it is not true voiceprint diarization. Set this to disable it:

```text
ENABLE_SPEAKER_LABELING=false
```

## Tool Checks

```powershell
npm run tools:check
npm run check
```

## Optional OpenAI Fallback

To use OpenAI instead, add these to `.env`:

```text
TRANSCRIPTION_PROVIDER=openai
SUMMARY_PROVIDER=openai
OPENAI_API_KEY=your_openai_api_key
```

## Environment Variables

```text
SILICONFLOW_API_KEY=required by default
TRANSCRIPTION_PROVIDER=siliconflow
SUMMARY_PROVIDER=siliconflow
SILICONFLOW_TRANSCRIPTION_MODEL=FunAudioLLM/SenseVoiceSmall
SILICONFLOW_SUMMARY_MODEL=Qwen/Qwen3.5-4B
ENABLE_SPEAKER_LABELING=true
SPEAKER_LABEL_MODEL=Qwen/Qwen3.5-4B
HOST=127.0.0.1
PORT=5173
MAX_AUDIO_BYTES=524288000
TRANSCRIBE_LIMIT=50331648
YTDLP_TIMEOUT_MS=1800000
YTDLP_SOCKET_TIMEOUT_SECONDS=30
YTDLP_RETRIES=10
YTDLP_IMPERSONATE=chrome
TRANSCRIPTION_API_MAX_ATTEMPTS=3
TRANSCRIPTION_API_RETRY_DELAY_MS=1500
```
