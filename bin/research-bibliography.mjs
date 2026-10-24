#!/usr/bin/env node

// bin/research-bibliography.mjs - Format retained references or add them to a report.
// Usage: node bin/research-bibliography.mjs --input REFERENCES.json [--format text|bibtex|csl-json]
//
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { exportReportWithReferences, formatBibliography } from '../src/bibliography.mjs';

const maxInputBytes = 1024 * 1024;

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!['--input', '--format', '--report', '--bindings'].includes(key) || options[key] || !args[index + 1]) throw new Error('usage: research-bibliography --input REFERENCES.json [--format text|bibtex|csl-json] [--report REPORT.json --bindings BINDINGS.json]');
    options[key] = args[++index];
  }
  if (!options['--input']) throw new Error('usage: research-bibliography --input REFERENCES.json [--format text|bibtex|csl-json] [--report REPORT.json --bindings BINDINGS.json]');
  if (Boolean(options['--report']) !== Boolean(options['--bindings'])) throw new Error('--report and --bindings must be supplied together');
  return options;
}

async function readJson(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxInputBytes) throw new Error('input must be a regular non-symlink JSON file no larger than 1 MiB');
    const buffer = Buffer.alloc(maxInputBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const result = await handle.read(buffer, total, buffer.length - total, total);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
    }
    if (total > maxInputBytes) throw new Error('input exceeds 1 MiB');
    bytes = buffer.subarray(0, total);
  } finally { await handle.close(); }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('input is not valid UTF-8');
  uniqueKeys(text);
  return JSON.parse(text);
}

function uniqueKeys(text) {
  let index = 0;
  const whitespace = () => { while (/\s/.test(text[index] ?? '') && index < text.length) index++; };
  const string = () => {
    if (text[index++] !== '"') throw new Error('invalid JSON string');
    while (index < text.length) {
      const character = text[index++];
      if (character === '"') return;
      if (character === '\\') index += text[index++] === 'u' ? 4 : 1;
    }
    throw new Error('unterminated JSON string');
  };
  const value = () => {
    whitespace();
    if (text[index] === '"') { string(); return; }
    if (text[index] === '{') {
      index++; whitespace(); const keys = new Set();
      if (text[index] === '}') { index++; return; }
      while (index < text.length) {
        whitespace();
        const start = index; string(); const key = JSON.parse(text.slice(start, index));
        if (keys.has(key)) throw new Error(`duplicate JSON key: ${key}`);
        keys.add(key); whitespace();
        if (text[index++] !== ':') throw new Error('invalid JSON object');
        value(); whitespace();
        const separator = text[index++]; if (separator === '}') return; if (separator !== ',') throw new Error('invalid JSON object');
      }
      throw new Error('unterminated JSON object');
    }
    if (text[index] === '[') {
      index++; whitespace(); if (text[index] === ']') { index++; return; }
      while (index < text.length) { value(); whitespace(); const separator = text[index++]; if (separator === ']') return; if (separator !== ',') throw new Error('invalid JSON array'); }
      throw new Error('unterminated JSON array');
    }
    const start = index;
    while (index < text.length && !/[\s,\]}]/.test(text[index])) index++;
    if (index === start) throw new Error('invalid JSON value');
  };
  value(); whitespace(); if (index !== text.length) throw new Error('trailing JSON content');
}

try {
  const args = parseArgs(process.argv.slice(2));
  const references = await readJson(args['--input']);
  let output;
  if (args['--report']) {
    const report = await readJson(args['--report']);
    const bindings = await readJson(args['--bindings']);
    output = exportReportWithReferences(report, references, bindings);
  } else output = formatBibliography(references, { format: args['--format'] ?? 'text' });
  process.stdout.write(output);
  if (!output.endsWith('\n')) process.stdout.write('\n');
} catch (error) {
  process.stderr.write(`${error.code === 'ELOOP' ? 'input must be a regular non-symlink JSON file no larger than 1 MiB' : error.message}\n`);
  process.exitCode = 1;
}
