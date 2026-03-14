/**
 * Decompress Emscripten's LZ4-compressed file_packager data.
 *
 * file_packager.py --lz4 splits data into 2048-byte chunks, compresses each
 * with LZ4 block format, and records offsets/successes in the JS metadata.
 */

const CHUNK_SIZE = 2048;

/**
 * Decode a single LZ4 block (not frame format).
 * Returns number of bytes written to output.
 */
function lz4BlockDecode(input: Uint8Array, output: Uint8Array): number {
  let ip = 0;
  let op = 0;

  while (ip < input.length) {
    const token = input[ip++];
    // Literal length
    let literalLen = token >> 4;
    if (literalLen === 15) {
      let b: number;
      do {
        b = input[ip++];
        literalLen += b;
      } while (b === 255);
    }

    // Copy literals
    for (let i = 0; i < literalLen; i++) {
      output[op++] = input[ip++];
    }

    // Check if we're at the end (last sequence has no match)
    if (ip >= input.length) break;

    // Match offset (2 bytes, little-endian)
    const offset = input[ip] | (input[ip + 1] << 8);
    ip += 2;
    if (offset === 0) break;

    // Match length
    let matchLen = (token & 0x0f) + 4;
    if ((token & 0x0f) === 15) {
      let b: number;
      do {
        b = input[ip++];
        matchLen += b;
      } while (b === 255);
    }

    // Copy match (byte-by-byte to handle overlapping)
    const matchStart = op - offset;
    for (let i = 0; i < matchLen; i++) {
      output[op++] = output[matchStart + i];
    }
  }

  return op;
}

/**
 * Decompress an Emscripten LZ4-packed .data file.
 *
 * @param compressedData - The raw .data file contents
 * @param offsets - Byte offsets for each chunk in the .data file
 * @param successes - 1 if chunk is LZ4-compressed, 0 if stored raw
 * @returns Decompressed data as a Buffer
 */
export function decompressPackage(
  compressedData: Buffer | Uint8Array,
  offsets: number[],
  successes: number[]
): Buffer {
  const numChunks = offsets.length;
  const chunks: Buffer[] = [];

  for (let i = 0; i < numChunks; i++) {
    const chunkStart = offsets[i];
    const chunkEnd = (i + 1 < numChunks) ? offsets[i + 1] : compressedData.length;
    const chunkData = compressedData.subarray(chunkStart, chunkEnd);

    if (successes[i]) {
      // LZ4 block compressed
      const output = Buffer.alloc(CHUNK_SIZE);
      const decompressedSize = lz4BlockDecode(chunkData, output);
      chunks.push(Buffer.from(output.subarray(0, decompressedSize)));
    } else {
      // Stored raw
      chunks.push(Buffer.from(chunkData.subarray(0, CHUNK_SIZE)));
    }
  }

  return Buffer.concat(chunks);
}
