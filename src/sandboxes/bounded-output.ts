/** Bound retained UTF-8 data while consuming it, before concatenation. */
export function outputLimiter(maxBytes: number): (chunk: string) => void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid sandbox output budget.');
  let bytes = 0;
  return (chunk) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxBytes) throw new Error('Sandbox output exceeded its transport budget. Narrow the operation.');
  };
}

/** The bytes of a stream, refusing rather than truncating when it is larger than `maxBytes`. */
export async function readBoundedBytes(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const reader = stream.getReader();
  let bytes = 0;
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error(`The file is larger than ${maxBytes} bytes.`);
      parts.push(chunk.value);
    }
    return Buffer.concat(parts);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function readBoundedText(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = stream.getReader();
  let bytes = 0;
  const parts: string[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error('File exceeds the bounded editing/read budget. Use a smaller file.');
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** Count the file without retaining it; retain only the requested UTF-16 window and its boundary characters. */
export async function readTextWindow(stream: ReadableStream<Uint8Array>, offset: number, limit: number): Promise<{ text: string; start: number; total: number }> {
  const start = Math.max(0, offset - 1);
  const end = offset + limit + 1;
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts: string[] = [];
  let total = 0;
  const take = (text: string) => {
    const from = Math.max(0, start - total);
    const to = Math.min(text.length, end - total);
    if (to > from) parts.push(text.slice(from, to));
    total += text.length;
    if (!Number.isSafeInteger(total)) throw new Error('The file length exceeds safe range addressing.');
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      take(decoder.decode(chunk.value, { stream: true }));
    }
    take(decoder.decode());
    return { text: parts.join(''), start, total };
  } finally { await reader.cancel(); reader.releaseLock(); }
}
