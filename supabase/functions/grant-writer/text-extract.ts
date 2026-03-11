/**
 * text-extract.ts — Extract plain text from PDF, DOCX, and TXT files.
 *
 * Runs inside Deno edge function. Uses lightweight approaches:
 *   - PDF:  npm:pdf-parse (works in Deno via npm: specifier)
 *   - DOCX: npm:mammoth   (extracts raw text from .docx)
 *   - TXT:  direct UTF-8 decode
 *
 * Truncates output to MAX_CHARS to keep Claude prompts manageable.
 */

import pdfParse from 'npm:pdf-parse@1.1.1';
import mammoth from 'npm:mammoth@1.8.0';

const MAX_CHARS = 50_000;

export async function extractText(
  fileBytes: Uint8Array,
  mimeType: string,
): Promise<string> {
  let raw = '';

  if (mimeType === 'application/pdf') {
    const result = await pdfParse(Buffer.from(fileBytes));
    raw = result.text;
  } else if (
    mimeType ===
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(fileBytes) });
    raw = result.value;
  } else {
    // Plain text fallback
    raw = new TextDecoder('utf-8').decode(fileBytes);
  }

  // Normalize whitespace and truncate
  raw = raw.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();

  if (raw.length > MAX_CHARS) {
    raw = raw.slice(0, MAX_CHARS) + '\n\n[…truncated at 50 000 characters]';
  }

  return raw;
}
