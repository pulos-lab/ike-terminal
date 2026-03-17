import iconv from 'iconv-lite';

export function decodeWindows1250(buffer: Buffer): string {
  return iconv.decode(buffer, 'win1250');
}

export function decodeLatin1(buffer: Buffer): string {
  return iconv.decode(buffer, 'latin1');
}

/**
 * Auto-detect encoding and decode buffer.
 * Checks for UTF-8 BOM first, then falls back to win1250 (Bossa) or latin1 (mBank).
 */
export function decodeCSVBuffer(buffer: Buffer): string {
  // UTF-8 BOM
  if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return buffer.toString('utf-8');
  }
  // Try win1250 first (most common for Polish brokers)
  return iconv.decode(buffer, 'win1250');
}
