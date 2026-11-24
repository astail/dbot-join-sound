/**
 * Discord から受け取る音声は 48kHz ステレオの s16le PCM。文字起こしには 16kHz モノラルで
 * 十分なので、左右を平均し、3 サンプルずつ平均して間引く。
 */
export function pcm48kStereoToWav16kMono(pcm: Buffer): Buffer {
  const frames = Math.floor(pcm.length / 4); // 1 フレーム = L（2 バイト）+ R（2 バイト）
  const samples = Math.floor(frames / 3);
  const out = Buffer.allocUnsafe(44 + samples * 2);
  writeWavHeader(out, samples * 2, 16_000, 1);
  for (let i = 0; i < samples; i++) {
    let acc = 0;
    for (let j = 0; j < 3; j++) {
      const offset = (i * 3 + j) * 4;
      acc += (pcm.readInt16LE(offset) + pcm.readInt16LE(offset + 2)) / 2;
    }
    const value = Math.round(acc / 3);
    out.writeInt16LE(Math.max(-32_768, Math.min(32_767, value)), 44 + i * 2);
  }
  return out;
}

function writeWavHeader(buf: Buffer, dataBytes: number, sampleRate: number, channels: number): void {
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate
  buf.writeUInt16LE(channels * 2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
}

// s16le PCM の RMS（0〜32768）。物音だけの区間を捨てるのに使う
export function pcmRms(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return 0;
  let acc = 0;
  for (let i = 0; i < samples; i++) {
    const value = pcm.readInt16LE(i * 2);
    acc += value * value;
  }
  return Math.sqrt(acc / samples);
}
