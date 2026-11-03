import fs from 'node:fs/promises';
import AppError from '../utils/AppError.js';
import config from '../config.js';

/**
 * Takes in the file path. Returns the extracted text as a string.
 * @param {string} filePath
 * @returns string: Extracted text from the file
 */
export async function extractMarkdownFromFile(filePath, filename) {
  const buffer = await fs.readFile(filePath);
  return await extractMarkdownFromBuffer(buffer, filename);
}

/**
 * Takes in a file's buffer and returns the text as markdown. To help with a structured chunking strategy.
 * @param {Buffer<ArrayBufferLike>} buffer
 * @param {string} filename
 * @returns {string} Parsed text in markdown format.
 */
export async function extractMarkdownFromBuffer(buffer, filename) {
  const form = new FormData();
  // Note: Blob is the new MDN standard when trying to send buffers via fetch
  const blob = new Blob([buffer]);
  form.append('files', blob, filename);
  form.append('to_formats', 'md');

  try {
    const res = await fetch(config.docling.endpoint, {
      method: 'POST',
      body: form,
    });

    if (!res.ok) {
      throw new Error(
        `Docling promise rejected. Status text: ${res.statusText}`,
      );
    }

    const data = await res.json();
    return cleanMarkdown(data.document.md_content);
  } catch (err) {
    throw new AppError(
      `Docling service error. Original error message: ${err.message}`,
      err.statusCode ?? 503,
      err,
    );
  }
}

function cleanMarkdown(markdown) {
  return (
    markdown
      // Remove image placeholders
      .replace(/<!--\s*image\s*-->/gi, '')
      // Remove reference list lines (e.g. "41. [Some citation](url)")
      .replace(/^\d+\.\s+\[.*?\]\(.*?\).*$/gm, '')
      // Remove bare URLs left after ref removal
      .replace(/^https?:\/\/\S+$/gm, '')
      // Remove copyright/boilerplate lines
      .replace(/^.*all rights reserved.*$/gim, '')
      .replace(/^.*no part of this.*$/gim, '')
      // Collapse 3+ newlines into 2
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
