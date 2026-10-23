import test from 'node:test';
import assert from 'node:assert/strict';
import { createInvestigation, reviseInvestigation, validateInvestigation, advanceInvestigation, renderInvestigation } from '../src/index.mjs';
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
    const start=createInvestigation('Topic',{questions:[{id:'q1',parentId:null,question:'Question A?'}]});
    const answered=await advanceInvestigation(start,{action:'investigate',branchIds:['q1'],lease:fixture.lease});
    const revised=reviseInvestigation(answered,{sources:[{uri:'https://example.org/new',text:'New capture'}]});
    const report=await advanceInvestigation(revised,{action:'synthesize',lease:fixture.lease});
    assert.doesNotMatch((await fixture.record()).prompt,/SOURCE-CONTEXT-ONLY/);
    assert.match(renderInvestigation(report),/Historical attempts \(excluded from this report\)/);
  } finally { await fixture.cleanup(); }
});
