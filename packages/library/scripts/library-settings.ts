#!/usr/bin/env node

// scripts/library-settings.ts - Inspect and edit private Library saving defaults.
// Usage: node --import tsx scripts/library-settings.ts --root PRIVATE_ROOT show

import { privateCommand } from './private-cli.js';
import {
  editLibrarySettings,
  readLibrarySettings,
} from '../packages/corpus/src/library-settings.js';

const args = process.argv.slice(2);
const usage = 'Use --root PRIVATE_ROOT show, or --root PRIVATE_ROOT edit REQUEST_JSON';
try {
  if (args[0] === '--help') {
    console.log(usage);
  } else {
    const { root, command } = privateCommand(args);
    const result =
      command === 'show' && !args.length
        ? await readLibrarySettings(root)
        : command === 'edit' && args.length === 1
          ? await editLibrarySettings(root, JSON.parse(args[0]!))
          : (() => {
              throw new Error('invalid_library_settings_command');
            })();
    console.log(JSON.stringify(result, null, 2));
  }
} catch (failure) {
  const code =
    failure instanceof Error &&
    [
      'invalid_library_settings',
      'settings_changed',
      'writer_busy',
      'invalid_library_settings_command',
      'explicit_root_required',
    ].includes(failure.message)
      ? failure.message
      : 'library_settings_unavailable';
  console.error(JSON.stringify({ code }));
  process.exitCode = 1;
}
