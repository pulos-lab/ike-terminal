import iconv from 'iconv-lite';

export function decodeWindows1250(buffer: Buffer): string {
  return iconv.decode(buffer, 'win1250');
}

export function decodeLatin1(buffer: Buffer): string {
  return iconv.decode(buffer, 'latin1');
}

/**
 * Auto-detect encoding and decode buffer.
 * Checks for UTF-8 BOM first, then validates UTF-8 content (DEGIRO uses UTF-8
 * without BOM), then falls back to win1250 (Bossa/mBank).
 */
export function decodeCSVBuffer(buffer: Buffer): string {
  // UTF-8 BOM
  if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return buffer.toString('utf-8');
  }
  // Check if buffer is valid UTF-8 with multi-byte sequences (Polish chars like ł, ą, ź).
  // Win1250 files use single-byte encoding and won't have valid UTF-8 multi-byte patterns.
  if (isValidUtf8WithMultibyte(buffer)) {
    return buffer.toString('utf-8');
  }
  // Fallback: win1250 (Bossa, mBank)
  return iconv.decode(buffer, 'win1250');
}

/**
 * Check if buffer contains valid UTF-8 multi-byte sequences.
 * Returns true only if multi-byte chars are found AND they decode correctly.
 * Pure-ASCII content returns false (ambiguous — let win1250 handle it).
 */
function isValidUtf8WithMultibyte(buffer: Buffer): boolean {
  let hasMultibyte = false;
  for (let i = 0; i < buffer.length; i++) {
    const b = buffer[i];
    if (b <= 0x7F) continue; // ASCII
    // 2-byte UTF-8: 110xxxxx 10xxxxxx
    if ((b & 0xE0) === 0xC0) {
      if (i + 1 >= buffer.length || (buffer[i + 1] & 0xC0) !== 0x80) return false;
      hasMultibyte = true;
      i += 1;
    // 3-byte UTF-8: 1110xxxx 10xxxxxx 10xxxxxx
    } else if ((b & 0xF0) === 0xE0) {
      if (i + 2 >= buffer.length || (buffer[i + 1] & 0xC0) !== 0x80 || (buffer[i + 2] & 0xC0) !== 0x80) return false;
      hasMultibyte = true;
      i += 2;
    // 4-byte UTF-8: 11110xxx 10xxxxxx 10xxxxxx 10xxxxxx
    } else if ((b & 0xF8) === 0xF0) {
      if (i + 3 >= buffer.length || (buffer[i + 1] & 0xC0) !== 0x80 || (buffer[i + 2] & 0xC0) !== 0x80 || (buffer[i + 3] & 0xC0) !== 0x80) return false;
      hasMultibyte = true;
      i += 3;
    } else {
      return false; // Invalid UTF-8 start byte
    }
  }
  return hasMultibyte;
}
