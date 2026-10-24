#!/usr/bin/env node

// bin/research-report-export.mjs - Export one validated report as portable HTML.
// Usage: node bin/research-report-export.mjs --input REPORT.json [--output NEW.html]
//
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { exportReportHtml } from '../src/report-export.mjs';

const maxInputBytes = 1024 * 1024;

function uniqueKeys(text) {
  let i = 0;
  const ws = () => { while (/\s/.test(text[i] ?? '') && i < text.length) i++; };
  const string = () => {
    if (text[i++] !== '"') throw new Error('invalid JSON string');
    let value = '';
    while (i < text.length) {
      const c = text[i++];
      if (c === '"') return value;
      if (c === '\\') {
        const escaped = text[i++];
        if (escaped === 'u') { value += String.fromCharCode(parseInt(text.slice(i, i + 4), 16)); i += 4; }
        else value += ({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[escaped] ?? '';
      } else value += c;
    }
    throw new Error('unterminated JSON string');
  };
  const value = () => {
    ws();
    if (text[i] === '"') { string(); return; }
    if (text[i] === '{') {
      i++; ws(); const keys = new Set();
      if (text[i] === '}') { i++; return; }
      while (i < text.length) {
        ws(); const key = string();
        if (keys.has(key)) throw new Error(`duplicate JSON key: ${key}`);
        keys.add(key); ws(); if (text[i++] !== ':') throw new Error('invalid JSON object'); value(); ws();
        const separator = text[i++]; if (separator === '}') return; if (separator !== ',') throw new Error('invalid JSON object');
      }
      throw new Error('unterminated JSON object');
    }
    if (text[i] === '[') {
      i++; ws(); if (text[i] === ']') { i++; return; }
      while (i < text.length) { value(); ws(); const separator = text[i++]; if (separator === ']') return; if (separator !== ',') throw new Error('invalid JSON array'); }
      throw new Error('unterminated JSON array');
    }
    const start = i;
    while (i < text.length && !/[\s,\]}]/.test(text[i])) i++;
    if (i === start) throw new Error('invalid JSON value');
  };
  value(); ws(); if (i !== text.length) throw new Error('trailing JSON content');
}

function parseArgs(args) {
  let input; let output;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && !input && args[i + 1]) input = args[++i];
    else if (args[i] === '--output' && !output && args[i + 1]) output = args[++i];
    else throw new Error('usage: research-report-export --input REPORT.json [--output NEW.html]');
  }
  if (!input) throw new Error('usage: research-report-export --input REPORT.json [--output NEW.html]');
  return { input, output };
}

try {
  const { input, output } = parseArgs(process.argv.slice(2));
  const inputHandle = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = await inputHandle.stat();
    if (!stat.isFile() || stat.size > maxInputBytes) throw new Error('input must be a regular non-symlink JSON file no larger than 1 MiB');
    bytes = await inputHandle.readFile();
  } finally { await inputHandle.close(); }
  if (bytes.length > maxInputBytes) throw new Error('input exceeds 1 MiB');
  const json = bytes.toString('utf8');
  if (!Buffer.from(json, 'utf8').equals(bytes)) throw new Error('input is not valid UTF-8');
  uniqueKeys(json);
  const html = exportReportHtml(JSON.parse(json));
  if (output) {
    const handle = await open(output, 'wx', 0o600);
    try { await handle.writeFile(html, 'utf8'); } finally { await handle.close(); }
  } else process.stdout.write(html);
} catch (error) {
  const message = error.code === 'ELOOP' ? 'input must be a regular non-symlink JSON file no larger than 1 MiB' : error.message;
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
