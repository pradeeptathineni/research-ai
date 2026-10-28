#!/usr/bin/env node
// Stateless CLI over the same canonical guided-investigation state and bounded runner.
import { createInvestigation, reviseInvestigation, validateInvestigation, planInvestigation,
  advanceInvestigationPlan, renderInvestigation } from '../src/index.mjs';

const actions=['create','validate','plan','revise','advance','render'];
const usage=`Usage: research-investigation --action ${actions.join('|')}\nRead one JSON object from stdin; emit JSON except render (Markdown by default).\nadvance requires {state, plan, confirmedPlanDigest, branchIds}; state must contain caller-provided frozen sources. See docs/investigation-adaptive.md.`;
const fail=error=>{process.stderr.write(`${error?.message??error}\n`);process.exitCode=1;};
async function read(){const chunks=[];let bytes=0;for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>2*1024*1024)throw new Error('stdin exceeds the 2 MiB request limit');chunks.push(chunk);}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
function fields(value,required,optional=[]){if(!value||typeof value!=='object'||Array.isArray(value)||required.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>!required.includes(k)&&!optional.includes(k)))throw new Error(`request requires only ${required.join(', ')}${optional.length?` and optional ${optional.join(', ')}`:''}`);}
async function main(){
  const args=process.argv.slice(2);
  if(args.length===1&&args[0]==='--help'){process.stdout.write(`${usage}\n`);return;}
  if(args.length!==2||args[0]!=='--action'||!actions.includes(args[1]))throw new Error('choose one supported --action; use --help');
  const [action,input]=[args[1],await read()];
  if(action==='create'){fields(input,['topic'],['options']);process.stdout.write(`${JSON.stringify(createInvestigation(input.topic,input.options??{}),null,2)}\n`);return;}
  if(action==='validate'){fields(input,['state']);process.stdout.write(`${JSON.stringify(validateInvestigation(input.state),null,2)}\n`);return;}
  if(action==='plan'){fields(input,['state']);process.stdout.write(`${JSON.stringify(planInvestigation(input.state),null,2)}\n`);return;}
  if(action==='render'){fields(input,['state'],['format']);process.stdout.write(renderInvestigation(input.state,{format:input.format??'markdown'}));return;}
  if(action==='revise'){fields(input,['state','edit']);process.stdout.write(`${JSON.stringify(reviseInvestigation(input.state,input.edit),null,2)}\n`);return;}
  fields(input,['state','plan','confirmedPlanDigest','branchIds'],['lease','model','effort']);
  const state=await advanceInvestigationPlan(input.state,input.plan,{confirmedPlanDigest:input.confirmedPlanDigest,action:'investigate',branchIds:input.branchIds,...Object.fromEntries(['lease','model','effort'].filter(k=>input[k]!==undefined).map(k=>[k,input[k]]))});
  process.stdout.write(`${JSON.stringify(state,null,2)}\n`);
}
main().catch(fail);
