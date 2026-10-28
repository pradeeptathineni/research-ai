import test from 'node:test';
import assert from 'node:assert/strict';
import { createInvestigation, reviseInvestigation, validateInvestigation, planInvestigation, advanceInvestigation, resumeInvestigation, renderInvestigation } from '../src/index.mjs';
import { fakeCodex, message } from './fake-codex.mjs';

const done={type:'turn.completed'};
const event=value=>({events:[message(JSON.stringify(value)),done]});

test('guided investigation uses explicit native actions and caller-owned resumable state',async()=>{
  const fixture=await fakeCodex({sessions:[event({questions:['Which constraint matters most?']}),event({questions:[{parentId:'q1',question:'How portable is export?'}]}),event({findings:['Portable archives retain content.'],gaps:['Migration fidelity needs a test.'],sources:[{uri:'https://example.org/archive'}],answer:'Archives are portable.'}),event({report:'# Finding\n\nArchives are portable. [https://example.org/archive] Coverage: one of two branches.'})]});
  try {
    const state=createInvestigation('Portable capture formats',{goal:'Compare formats',scope:'One offline-first user',questions:[{id:'q1',parentId:null,question:'Which format is portable?'}],sources:[{uri:'https://example.org/archive',text:'Frozen corpus content: this format preserves exported notes.',omissions:['Migration fidelity was not captured.']}]});
    const clarified=await advanceInvestigation(state,{action:'clarify',lease:fixture.lease});
    assert.deepEqual(clarified.clarifications,['Which constraint matters most?']);
    const edited=reviseInvestigation(clarified,{scope:'One offline-first user; preserve migration paths'});
    const expanded=await advanceInvestigation(edited,{action:'expand',lease:fixture.lease});
    assert.equal(expanded.questions.length,2);
    const reloaded=validateInvestigation(JSON.parse(JSON.stringify(expanded)));
    const found=await advanceInvestigation(reloaded,{action:'investigate',branchIds:['q1'],lease:fixture.lease});
    assert.equal(found.history.at(-1).status,'complete');
    assert.equal(found.history.at(-1).sources[0].uri,'https://example.org/archive');
    assert.equal(found.history.at(-1).identity,expanded.identity);
    assert.equal(found.history.at(-1).receipt.nativeSessions,1);
    assert.match((await fixture.session(2)).prompt,/Frozen corpus content: this format preserves exported notes\./);
    assert.equal(found.used.calls,3);
    const report=await advanceInvestigation(found,{action:'synthesize',lease:fixture.lease});
    assert.match(renderInvestigation(report),/^# Finding/);
    assert.equal(report.report.identity,report.identity);
    assert.equal(report.history.length,4);
    assert.deepEqual(await fixture.probes().then(x=>x.filter(args=>args[0]==='exec').length),4);
  } finally { await fixture.cleanup(); }
});

test('plan checkpoints bind resume to exact question, source versions, usage and attempt tail',async()=>{
  const fixture=await fakeCodex({sessions:[event({findings:['A captured finding.'],gaps:['Coverage remains partial.'],sources:[{uri:'https://example.org/a'}],answer:'Partial evidence.'}),event({findings:['Second captured finding.'],gaps:[],sources:[{uri:'https://example.org/a'}],answer:'Follow-up.'})]});
  try {
    const source={uri:'https://example.org/a',text:'Captured source version one.'};
    const start=createInvestigation('Question?',{questions:[{id:'q1',parentId:null,question:'What does the source say?'}],sources:[source],budget:{searches:2,documents:2,seconds:20,calls:2}});
    const plan=planInvestigation(start);
    assert.equal(plan.version,'investigation-plan-v1');
    assert.deepEqual(plan.remaining,{calls:2,searches:2,reads:2,seconds:20});
    assert.equal(plan.questions[0].depth,1);
    const forged=structuredClone(plan); forged.remaining.calls=99;
    await assert.rejects(resumeInvestigation(start,forged,{action:'investigate',branchIds:['q1'],lease:fixture.lease}),/stale or mismatched resume checkpoint/);
    const first=await resumeInvestigation(validateInvestigation(JSON.parse(JSON.stringify(start))),plan,{action:'investigate',branchIds:['q1'],lease:fixture.lease});
    assert.equal(first.history[0].status,'complete');
    assert.equal(first.used.calls,1);
    await assert.rejects(resumeInvestigation(first,plan,{action:'synthesize',lease:fixture.lease}),/stale or mismatched resume checkpoint/);
    const reworded=reviseInvestigation(first,{goal:'Reworded goal without a budget change'});
    assert.equal(reworded.used.calls,1);
    assert.equal(planInvestigation(reworded).remaining.calls,1);
    const changed=reviseInvestigation(first,{sources:[{...source,text:'Captured source version two.'}]});
    const changedPlan=planInvestigation(changed);
    await assert.rejects(resumeInvestigation(changed,plan,{action:'investigate',branchIds:['q1'],lease:fixture.lease}),/stale or mismatched resume checkpoint/);
    const resumed=await resumeInvestigation(changed,changedPlan,{action:'investigate',branchIds:['q1'],lease:fixture.lease});
    assert.equal(resumed.history.length,2);
    assert.equal(resumed.used.calls,2);
    assert.equal(planInvestigation(resumed).remaining.calls,0);
    const exhausted=await resumeInvestigation(resumed,planInvestigation(resumed),{action:'synthesize',lease:fixture.lease});
    assert.equal(exhausted.history.at(-1).status,'not_run');
    assert.equal(exhausted.history.at(-1).reason,'budget_exhausted');
    assert.equal((await fixture.probes()).filter(args=>args[0]==='exec').length,2);
  } finally { await fixture.cleanup(); }
});

test('resume keeps useful partial checkpoint and receipt-less unknown dispatch cannot replay',async()=>{
  const fixture=await fakeCodex({sessions:[event({findings:['Useful retained evidence.'],gaps:['One avenue remains unchecked.'],sources:[],answer:'A useful first branch.'})]});
  try {
    const state=createInvestigation('Topic',{questions:[{id:'q1',parentId:null,question:'Q1?'},{id:'q2',parentId:null,question:'Q2?'}],budget:{searches:2,documents:2,seconds:20,calls:1}});
    const partial=await resumeInvestigation(state,planInvestigation(state),{action:'investigate',branchIds:['q1','q2'],lease:fixture.lease});
    assert.equal(partial.history[0].status,'complete');
    assert.equal(partial.history[1].status,'not_run');
    assert.equal(partial.history[1].reason,'budget_exhausted');
    assert.match(renderInvestigation(partial),/A useful first branch/);
    assert.equal(planInvestigation(partial).remaining.calls,0);
    const noMore=await resumeInvestigation(partial,planInvestigation(partial),{action:'synthesize',lease:fixture.lease});
    assert.equal(noMore.history.at(-1).status,'not_run');
    assert.equal(noMore.history.at(-1).reason,'budget_exhausted');
    assert.equal((await fixture.probes()).filter(args=>args[0]==='exec').length,1);
    const unknown=structuredClone(state);
    unknown.history.push({id:'a1',identity:unknown.identity,contextIdentity:unknown.identity,revision:0,action:'investigate',branchId:'q1',question:'Q?',status:'failed',findings:[],gaps:[],sources:[],answer:'',reason:'dispatch_outcome_unknown',receipt:null});
    unknown.used.calls=1;
    const validUnknown=validateInvestigation(unknown);
    const blocked=await resumeInvestigation(validUnknown,planInvestigation(validUnknown),{action:'investigate',branchIds:['q1'],lease:fixture.lease});
    assert.equal(planInvestigation(validUnknown).blocked,true);
    assert.equal(blocked.history.at(-1).status,'not_run');
    assert.equal(blocked.history.at(-1).reason,'prior_cleanup_unconfirmed');
    assert.equal((await fixture.probes()).filter(args=>args[0]==='exec').length,1);
  } finally { await fixture.cleanup(); }
});

test('rejects malformed restored state and branch selection before native dispatch',async()=>{
  const fixture=await fakeCodex({});
  try {
    const state=createInvestigation('A bounded topic');
    assert.throws(()=>validateInvestigation({...state,used:{...state.used,calls:-1}}),/invalid_investigation/);
    await assert.rejects(advanceInvestigation(state,{action:'investigate',branchIds:['unknown'],lease:fixture.lease}),/unknown branch/);
    assert.deepEqual(await fixture.probes(),[]);
  } finally { await fixture.cleanup(); }
});

test('question edits preserve historical answers but exclude them from current synthesis',async()=>{
  const fixture=await fakeCodex({sessions:[event({findings:['OLD-QUESTION-ONLY evidence'],gaps:[],sources:[{uri:'https://example.org/old'}],answer:'Historical answer.'}),event({report:'No current-identity findings are available yet.'})]});
  try {
    const start=createInvestigation('Topic',{questions:[{id:'q1',parentId:null,question:'Original question?'}]});
    const answered=await advanceInvestigation(start,{action:'investigate',branchIds:['q1'],lease:fixture.lease});
    const edited=reviseInvestigation(answered,{questions:[{id:'q1',parentId:null,question:'Revised question?'}]});
    const report=await advanceInvestigation(edited,{action:'synthesize',lease:fixture.lease});
    assert.equal(report.history[0].question,'Original question?');
    assert.deepEqual(report.history[0].findings,['OLD-QUESTION-ONLY evidence']);
    assert.notEqual(report.history[0].identity,report.identity);
    assert.doesNotMatch((await fixture.record()).prompt,/OLD-QUESTION-ONLY/);
    assert.doesNotMatch(report.report.markdown,/OLD-QUESTION-ONLY/);
    assert.match(renderInvestigation(report),/Historical attempts \(excluded from this report\)/);
    assert.match(renderInvestigation(report),/Original question\? — complete/);
    assert.match(renderInvestigation(report),/Run coverage/);
  } finally { await fixture.cleanup(); }
});

test('append-only expansion keeps unchanged branch findings compatible',async()=>{
  const fixture=await fakeCodex({sessions:[event({findings:['BRANCH-A retained finding'],gaps:[],sources:[{uri:'https://example.org/a'}],answer:'Answer A.'}),event({questions:[{parentId:'q1',question:'Question B?'}]}),event({report:'Combined report.'})]});
  try {
    const start=createInvestigation('Topic',{questions:[{id:'q1',parentId:null,question:'Question A?'}]});
    const answered=await advanceInvestigation(start,{action:'investigate',branchIds:['q1'],lease:fixture.lease});
    const expanded=await advanceInvestigation(answered,{action:'expand',lease:fixture.lease});
    assert.notEqual(answered.identity,expanded.identity);
    assert.equal(expanded.history[0].identity,answered.identity);
    const report=await advanceInvestigation(expanded,{action:'synthesize',lease:fixture.lease});
    assert.match((await fixture.record()).prompt,/BRANCH-A retained finding/);
    assert.match(renderInvestigation(report),/## Retained branch findings[\s\S]*### Question A\?/);
    assert.doesNotMatch(renderInvestigation(report),/Historical attempts \(excluded from this report\)/);
  } finally { await fixture.cleanup(); }
});

test('source context edits make previous findings historical',async()=>{
  const fixture=await fakeCodex({sessions:[event({findings:['SOURCE-CONTEXT-ONLY'],gaps:[],sources:[{uri:'https://example.org/old'}],answer:'Old source answer.'}),event({report:'No current-source findings.'})]});
  try {
    const source={uri:'https://example.org/old',text:'Same capture bytes'};
    const start=createInvestigation('Topic',{questions:[{id:'q1',parentId:null,question:'Question A?'}],sources:[source]});
    const answered=await advanceInvestigation(start,{action:'investigate',branchIds:['q1'],lease:fixture.lease});
    const revised=reviseInvestigation(answered,{sources:[{...source,omissions:['Key contrary results omitted']}]});
    const report=await advanceInvestigation(revised,{action:'synthesize',lease:fixture.lease});
    assert.doesNotMatch((await fixture.record()).prompt,/SOURCE-CONTEXT-ONLY/);
    assert.match(renderInvestigation(report),/Historical attempts \(excluded from this report\)/);
  } finally { await fixture.cleanup(); }
});

test('malformed branch findings and over-depth expansion keep failed native receipts',async()=>{
  let fixture=await fakeCodex(event({findings:[123],gaps:[],sources:[],answer:'answer'}));
  try {
    const out=await advanceInvestigation(createInvestigation('Topic',{questions:[{id:'q1',parentId:null,question:'Q?'}]}),{action:'investigate',branchIds:['q1'],lease:fixture.lease});
    assert.equal(out.history.at(-1).status,'failed');
    assert.equal(out.history.at(-1).reason,'invalid_investigation_output');
    assert.ok(out.history.at(-1).receipt);
    assert.equal(out.used.calls,1);
  } finally { await fixture.cleanup(); }
  fixture=await fakeCodex(event({questions:[{parentId:'q4',question:'Too deep?'}]}));
  try {
    const questions=[{id:'q1',parentId:null,question:'1?'},{id:'q2',parentId:'q1',question:'2?'},{id:'q3',parentId:'q2',question:'3?'},{id:'q4',parentId:'q3',question:'4?'}];
    const out=await advanceInvestigation(createInvestigation('Topic',{questions}),{action:'expand',lease:fixture.lease});
    assert.equal(out.questions.length,4);
    assert.equal(out.history.at(-1).status,'failed');
    assert.equal(out.history.at(-1).reason,'invalid_investigation_output');
    assert.ok(out.history.at(-1).receipt);
  } finally { await fixture.cleanup(); }
});

test('restored uncertain cleanup blocks later explicit native dispatches',async()=>{
  const fixture=await fakeCodex({sessions:[event({findings:['finding'],gaps:[],sources:[],answer:'answer'}),event({findings:['should not run'],gaps:[],sources:[],answer:'answer'})]});
  try {
    const initial=createInvestigation('Topic',{questions:[{id:'q1',parentId:null,question:'Q?'}]});
    const first=await advanceInvestigation(initial,{action:'investigate',branchIds:['q1'],lease:fixture.lease});
    first.history[0].receipt.cleanup={complete:false,error:'process_group_cleanup_failed'};
    first.history[0].status='failed'; first.history[0].reason='process_group_cleanup_failed';
    const resumed=await advanceInvestigation(validateInvestigation(first),{action:'investigate',branchIds:['q1'],lease:`${fixture.lease}-other`});
    assert.equal(resumed.history.at(-1).status,'not_run');
    assert.equal(resumed.history.at(-1).reason,'prior_cleanup_unconfirmed');
    assert.equal((await fixture.probes()).filter(args=>args[0]==='exec').length,1);
  } finally { await fixture.cleanup(); }
});
