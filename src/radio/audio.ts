export const SAMPLE_RATE = 22_050;
export const BYTES_PER_SECOND = SAMPLE_RATE * 2;

export function wavHeader(pcmBytes: number): Buffer {
  if (
    !Number.isSafeInteger(pcmBytes) ||
    pcmBytes < 0 ||
    pcmBytes % 2 ||
    pcmBytes > 0xffffffff - 36
  ) {
    throw new Error(
      "WAV data must contain complete 16-bit samples and fit a RIFF file",
    );
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(pcmBytes + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(BYTES_PER_SECOND, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBytes, 40);
  return header;
}

/** Accept PCM WAV with optional metadata chunks, but never silently resample. */
export function wavPcm(wav: Buffer): Buffer {
  if (
    wav.length < 12 ||
    wav.toString("latin1", 0, 4) !== "RIFF" ||
    wav.toString("latin1", 8, 12) !== "WAVE"
  ) {
    throw new Error("Expected a RIFF WAV file");
  }
  const end = wav.readUInt32LE(4) + 8;
  if (end > wav.length) throw new Error("Truncated WAV file");
  let validFormat = false;
  let pcm: Buffer | undefined;
  for (let position = 12; position !== end;) {
    if (end - position < 8) throw new Error("Truncated WAV chunk header");
    const name = wav.toString("latin1", position, position + 4);
    const size = wav.readUInt32LE(position + 4);
    const start = position + 8;
    if (start + size + (size % 2) > end) throw new Error("Truncated WAV chunk");
    if (name === "fmt ") {
      if (
        size < 16 ||
        wav.readUInt16LE(start) !== 1 ||
        wav.readUInt16LE(start + 2) !== 1 ||
        wav.readUInt32LE(start + 4) !== SAMPLE_RATE ||
        wav.readUInt32LE(start + 8) !== BYTES_PER_SECOND ||
        wav.readUInt16LE(start + 12) !== 2 ||
        wav.readUInt16LE(start + 14) !== 16
      ) {
        throw new Error("Replay requires PCM16 mono WAV at 22050 Hz");
      }
      validFormat = true;
    }
    if (name === "data") {
      if (pcm) throw new Error("WAV contains multiple data chunks");
      pcm = wav.subarray(start, start + size);
    }
    position = start + size + (size % 2);
  }
  if (!validFormat || !pcm)
    throw new Error("WAV is missing its format or data chunk");
  if (pcm.length % 2)
    throw new Error("WAV contains an incomplete 16-bit sample");
  return pcm;
}

/** A fixed byte ring avoids retaining a large backing Buffer through small slices. */
export class PcmRing {
  private readonly data: Buffer;
  private position = 0;
  private length = 0;

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity % 2)
      throw new Error("Invalid PCM ring capacity");
    this.data = Buffer.alloc(capacity);
  }

  push(chunk: Buffer): void {
    if (chunk.length % 2)
      throw new Error("PCM chunks must contain complete samples");
    if (!this.capacity) return;
    chunk = chunk.subarray(-this.capacity);
    const first = Math.min(chunk.length, this.capacity - this.position);
    chunk.copy(this.data, this.position, 0, first);
    chunk.copy(this.data, 0, first);
    this.position = (this.position + chunk.length) % this.capacity;
    this.length = Math.min(this.capacity, this.length + chunk.length);
  }

  snapshot(): Buffer {
    const output = Buffer.alloc(this.length);
    const start = (this.position - this.length + this.capacity) % this.capacity;
    const first = Math.min(this.length, this.capacity - start);
    this.data.copy(output, 0, start, start + first);
    this.data.copy(output, first, 0, this.length - first);
    return output;
  }
}

/** Native process pipe chunks need not end on a sample boundary. */
export class PcmFramer {
  private tail: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer {
    const input = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
    const length = input.length - (input.length % 2);
    this.tail = Buffer.from(input.subarray(length));
    return input.subarray(0, length);
  }
}

export function secondsToBytes(seconds: number): number {
  return Math.floor(seconds * SAMPLE_RATE) * 2;
}

/** A clip joins nearby calls and stops at a fixed maximum even during a long burst. */
export class CaptureWindow {
  private readonly data: Buffer;
  private length: number;
  private target: number;

  constructor(
    pre: Buffer,
    postBytes: number,
    private readonly maxBytes: number,
  ) {
    this.data = Buffer.alloc(maxBytes);
    this.length = pre.copy(this.data);
    this.target = Math.min(pre.length + postBytes, maxBytes);
  }

  extend(postBytes: number): void {
    this.target = Math.min(this.length + postBytes, this.maxBytes);
  }

  get byteLength(): number {
    return this.length;
  }

  push(chunk: Buffer): boolean {
    const take = Math.min(chunk.length, this.target - this.length);
    this.length += chunk.copy(this.data, this.length, 0, take);
    return this.length >= this.target;
  }

  finish(): Buffer {
    return Buffer.from(this.data.subarray(0, this.length));
  }
}
