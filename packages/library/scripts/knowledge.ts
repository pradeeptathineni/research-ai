import { resolve } from 'node:path';
import {
  configureKnowledge,
  createTopic,
  exportTopic,
  exportTopicReferences,
  knowledgeOwners,
  listTopicReferences,
  listTopics,
  openTopic,
  readKnowledge,
  searchKnowledge,
  setTopicReference,
  topicEvidenceGraph,
  updateTopic,
} from '../packages/corpus/src/knowledge.js';

const args = process.argv.slice(2);
let root = process.cwd();
if (args[0] === '--root') {
  args.shift();
  const selected = args.shift();
  if (!selected) throw new Error('explicit_root_required');
  root = resolve(selected);
}
const [command, value, patch, ...flags] = args;
const parse = (text: string | undefined): unknown => JSON.parse(text ?? 'null');
try {
  let result: unknown;
  switch (command) {
    case 'owners':
      result = await knowledgeOwners(root);
      break;
    case 'configure':
      result = await configureKnowledge(root, { owners: parse(value) });
      break;
    case 'search':
      result = await searchKnowledge(root, value ?? '');
      break;
    case 'read':
      result = await readKnowledge(root, parse(value));
      break;
    case 'topics':
      result = await listTopics(root);
      break;
    case 'create':
      result = await createTopic(root, { name: value });
      break;
    case 'open':
      result = await openTopic(root, value ?? '');
      break;
    case 'update':
      result = await updateTopic(root, value ?? '', parse(patch));
      break;
    case 'export':
      result = (await exportTopic(root, value ?? '')).content;
      break;
    case 'graph': {
      let format = 'json';
      const options = [patch, ...flags].filter((item): item is string => Boolean(item));
      for (let index = 0; index < options.length; index++) {
        const flag = options[index]!;
        if (flag === '--format' && options[index + 1]) format = options[++index]!;
        else if (flag.startsWith('--format=')) format = flag.slice('--format='.length);
        else throw new Error(`unknown_option:${flag}`);
      }
      if (format !== 'json' && format !== 'markdown')
        throw new Error('format_must_be_json_or_markdown');
      const graph = await topicEvidenceGraph(root, value ?? '');
      if (format === 'json') result = graph;
      else {
        const titles = new Map(graph.nodes.map((node) => [node.key, node.title]));
        result = [
          `# Evidence impact map: ${graph.topic.id}`,
          '',
          `Topic revision ${graph.topic.revision}. Saved references remain with their owners.`,
          '',
          '## Records',
          ...graph.nodes.map((node) => `- **${node.title}** — ${node.state}: ${node.reason}`),
          '',
          '## Relationships',
          ...graph.edges.map(
            (edge) =>
              `- ${titles.get(edge.from)} → ${titles.get(edge.to)} (${edge.relation}, caller claim: ${edge.label})`,
          ),
          '',
          '## Possible review paths',
          ...graph.impacts.flatMap((impact) => [
            `- Trigger: ${titles.get(impact.trigger)} — ${impact.trigger_state}; ${impact.state}. ${impact.reason}`,
            ...impact.paths.map(
              ({ dependent, path }) =>
                `  - ${titles.get(dependent)}: ${path.map((key) => titles.get(key)).join(' → ')}`,
            ),
          ]),
          '',
          '## Qualifications',
          ...graph.qualifications.map((qualification) => `- ${qualification}`),
          '',
        ].join('\n');
      }
      break;
    }
    case 'reference-set':
      result = await setTopicReference(root, value ?? '', parse(patch));
      break;
    case 'references':
      result = await listTopicReferences(root, value ?? '');
      break;
    case 'references-export':
      result = await exportTopicReferences(root, value ?? '', parse(patch));
      break;
    default:
      throw new Error(
        'Use owners|configure JSON|search TEXT|read JSON|topics|create NAME|open UUID|update UUID JSON|export UUID|graph UUID [--format json|markdown]|reference-set UUID JSON|references UUID|references-export UUID JSON',
      );
  }
  if (result === undefined) throw new Error('knowledge_result_missing');
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
} catch (failure) {
  console.error(
    JSON.stringify({ code: failure instanceof Error ? failure.message : 'knowledge_failed' }),
  );
  process.exitCode = 1;
}
