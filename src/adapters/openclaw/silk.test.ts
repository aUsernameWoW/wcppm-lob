import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pcmToWav, decodeSilkToWav, decodeVoiceIfNeeded } from "./silk.js";

test("pcmToWav: wraps PCM s16le in a valid 44-byte WAV header (mono 24k)", () => {
  const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const wav = pcmToWav(pcm, { sampleRate: 24000 });

  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length);
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.subarray(12, 16).toString("ascii"), "fmt ");
  assert.equal(wav.readUInt32LE(16), 16); // PCM fmt chunk size
  assert.equal(wav.readUInt16LE(20), 1); // audioFormat = PCM
  assert.equal(wav.readUInt16LE(22), 1); // channels = mono
  assert.equal(wav.readUInt32LE(24), 24000); // sample rate
  assert.equal(wav.readUInt32LE(28), 24000 * 2); // byte rate = rate * channels * 2
  assert.equal(wav.readUInt16LE(32), 2); // block align = channels * 2
  assert.equal(wav.readUInt16LE(34), 16); // bits per sample
  assert.equal(wav.subarray(36, 40).toString("ascii"), "data");
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
});

test("decodeSilkToWav: decodes a WeChat-style SILK file into a readable WAV", async () => {
  const { encode, isWav, getWavFileInfo } = await import("silk-wasm");

  // Synthesize ~0.2s of a tone, encode to SILK (silk-wasm round-trips the
  // WeChat \x02-prefixed variant), write it as the inbound .silk file.
  const N = 4800;
  const pcm = Buffer.alloc(N * 2);
  for (let i = 0; i < N; i++) pcm.writeInt16LE(Math.round(3000 * Math.sin(i * 0.2)), i * 2);
  const enc = await encode(pcm, 24000);

  const dir = await mkdtemp(join(tmpdir(), "silk-test-"));
  const silkPath = join(dir, "wechat-voice-123.silk");
  await writeFile(silkPath, Buffer.from(enc.data));

  const wavPath = await decodeSilkToWav(silkPath);

  assert.ok(wavPath.endsWith(".wav"), `expected a .wav path, got ${wavPath}`);
  const wav = await readFile(wavPath);
  assert.equal(isWav(wav), true);
  const info = getWavFileInfo(wav);
  assert.equal(info.fmt.sampleRate, 24000);
  assert.equal(info.fmt.numberOfChannels, 1);
  assert.equal(info.fmt.bitsPerSample, 16);
});

test("decodeVoiceIfNeeded: voice → decodes to WAV and re-types as audio/wav", async () => {
  const r = await decodeVoiceIfNeeded(
    { mediaPath: "/tmp/v.silk", mediaType: "audio/silk" },
    "voice",
    async (p) => p.replace(/\.silk$/, ".wav"),
    { warn() {} },
  );
  assert.equal(r.mediaPath, "/tmp/v.wav");
  assert.equal(r.mediaType, "audio/wav");
});

test("decodeVoiceIfNeeded: non-voice kinds pass through untouched (decoder not called)", async () => {
  let called = false;
  const r = await decodeVoiceIfNeeded(
    { mediaPath: "/tmp/i.jpg", mediaType: "image/jpeg" },
    "image",
    async (p) => {
      called = true;
      return p;
    },
    { warn() {} },
  );
  assert.equal(called, false);
  assert.equal(r.mediaPath, "/tmp/i.jpg");
  assert.equal(r.mediaType, "image/jpeg");
});

test("decodeVoiceIfNeeded: decode failure degrades to the raw SILK (logged, never throws)", async () => {
  const warns: string[] = [];
  const r = await decodeVoiceIfNeeded(
    { mediaPath: "/tmp/v.silk", mediaType: "audio/silk" },
    "voice",
    async () => {
      throw new Error("boom");
    },
    { warn: (m) => warns.push(m) },
  );
  assert.equal(r.mediaPath, "/tmp/v.silk");
  assert.equal(r.mediaType, "audio/silk");
  assert.equal(warns.length, 1);
});
