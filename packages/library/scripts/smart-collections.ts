import { resolve } from 'node:path';
import {
  createSmartCollection,
  freezeSmartCollection,
  listSmartCollections,
  openSmartCollection,
  runSmartCollection,
  triageSmartCollection,
  updateSmartCollection,
} from '../packages/corpus/src/smart-collections.js';

const args = process.argv.slice(2);
if (args[0] !== '--root') throw new Error('explicit_root_required');
args.shift();
const selected = args.shift();
if (!selected) throw new Error('explicit_root_required');
const root = resolve(selected);
const command = args.shift();
const target = args.shift();
const input = args.shift();
const parse = (value: string | undefined): unknown => JSON.parse(value ?? 'null');
try {
  let result: unknown;
  switch (command) {
    case 'list':
      result = await listSmartCollections(root);
      break;
    case 'create':
      result = await createSmartCollection(root, parse(target));
      break;
    case 'open':
      result = await openSmartCollection(root, target ?? '');
      break;
    case 'update':
      result = await updateSmartCollection(root, target ?? '', parse(input));
      break;
    case 'run':
      result = await runSmartCollection(root, target ?? '');
      break;
    case 'triage':
      result = await triageSmartCollection(root, target ?? '', parse(input));
      break;
    case 'freeze':
      result = await freezeSmartCollection(root, target ?? '', parse(input));
      break;
    default:
      throw new Error(
        'Use list|create JSON|open UUID|update UUID JSON|run UUID|triage UUID JSON|freeze UUID JSON',
      );
  }
  console.log(JSON.stringify(result, null, 2));
} catch (failure) {
  console.error(
    JSON.stringify({
      code: failure instanceof Error ? failure.message : 'smart_collection_failed',
    }),
  );
  process.exitCode = 1;
}
