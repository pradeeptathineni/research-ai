import { resolve } from 'node:path';

export function privateCommand(args: string[]) {
  if (args.shift() !== '--root' || !args[0]) throw new Error('explicit_root_required');
  return { root: resolve(args.shift()!), command: args.shift() };
}
