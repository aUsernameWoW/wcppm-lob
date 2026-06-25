/**
 * WeChat voice arrives as SILK (the `\x02#!SILK_V3` variant). OpenClaw's
 * speech-to-text providers can't read SILK, so the adapter decodes it to WAV
 * before handing the agent a MediaPath — transcription then stays OpenClaw's
 * job (we only deliver bytes, exactly like image understanding). Decoding is
 * pure WASM (`silk-wasm`), so there is no native binary / ffmpeg dependency.
 */
import { decode } from "silk-wasm";

/** WeChat voice is encoded at 24 kHz, mono, 16-bit. */
const WECHAT_SILK_SAMPLE_RATE = 24000;

export interface PcmWavOpts {
  sampleRate: number;
  channels?: number;
  bitsPerSample?: number;
}

/**
 * Wrap raw PCM (s16le) in a minimal 44-byte canonical WAV container. Pure — no
 * I/O — so the header math is unit-tested independently of the SILK decoder.
 */
export function pcmToWav(pcm: Buffer, opts: PcmWavOpts): Buffer {
  const { sampleRate, channels = 1, bitsPerSample = 16 } = opts;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4); // RIFF chunk size
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  header.writeUInt16LE(1, 20); // audioFormat = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/**
 * Decode a WeChat SILK voice file to a sibling `.wav`. Returns the wav path.
 * Throws on a malformed/undecodable SILK file (callers degrade gracefully).
 */
export async function decodeSilkToWav(silkPath: string): Promise<string> {
  const { readFile, writeFile } = await import("node:fs/promises");
  const silk = await readFile(silkPath);
  const { data } = await decode(silk, WECHAT_SILK_SAMPLE_RATE);
  const wav = pcmToWav(Buffer.from(data), { sampleRate: WECHAT_SILK_SAMPLE_RATE });
  const wavPath = silkPath.replace(/\.silk$/i, "") + ".wav";
  await writeFile(wavPath, wav);
  return wavPath;
}

/**
 * Post-process a fetched inbound attachment: a voice (SILK) attachment is
 * decoded to WAV and re-typed `audio/wav` so OpenClaw's STT pipeline transcribes
 * it; every other kind passes through untouched. A decode failure degrades to
 * the raw SILK bytes (logged) rather than throwing — never drop the message.
 */
export async function decodeVoiceIfNeeded(
  media: { mediaPath: string; mediaType?: string },
  mediaKind: string | undefined,
  decodeVoice: (silkPath: string) => Promise<string>,
  log: { warn: (msg: string) => void },
): Promise<{ mediaPath: string; mediaType?: string }> {
  if (mediaKind !== "voice") return media;
  try {
    const wavPath = await decodeVoice(media.mediaPath);
    return { mediaPath: wavPath, mediaType: "audio/wav" };
  } catch (err) {
    log.warn(`wechatpadpro: SILK decode failed for ${media.mediaPath}, forwarding raw bytes: ${String(err)}`);
    return media;
  }
}
