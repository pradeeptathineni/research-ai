import { readFile } from 'node:fs/promises';
import { admitRecord } from '../packages/corpus/src/research-store.js';
import { loadLibrary } from '../packages/corpus/src/library.js';
import { libraryPreferences, matchLibrary } from '../packages/corpus/src/library-meaning.js';
import { loadSettings } from '../packages/corpus/src/search-settings.js';

const [operation, ...args] = process.argv.slice(2);
if (operation === 'admit') {
  if (args.length !== 2) throw new Error('Agent admission: admit DRAFT.json TYPE');
  console.log(await admitRecord(await readFile(args[0]!, 'utf8'), args[1]!));
} else if (operation === 'library-query') {
  const scope = args.includes('--public') ? 'public' : 'local';
  const question = args.filter((arg) => arg !== '--public').join(' ');
  if (!question.trim() || question.length > 2000)
    throw new Error('Library question requires 1–2000 characters.');
  const settings = await loadSettings();
  const preferences = await libraryPreferences(process.cwd());
  console.log(
    JSON.stringify(
      await matchLibrary(
        await loadLibrary(process.cwd(), { scope }),
        question,
        {},
        {
          permitted: preferences.meaningMatching,
          model: settings.model || undefined,
          effort: settings.effort || undefined,
        },
      ),
      null,
      2,
    ),
  );
} else throw new Error('research library-query QUESTION [--public] | admit DRAFT.json TYPE');
