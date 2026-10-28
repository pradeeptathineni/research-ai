import test from 'node:test';
import assert from 'node:assert/strict';
import { createInvestigation, reviseInvestigation, advanceInvestigationPlan, planInvestigation, validateInvestigation } from '../src/index.mjs';
import { fakeCodex, message } from './fake-codex.mjs';

const output = answer => ({ events: [message(JSON.stringify({ findings:[`${answer} finding`], gaps:['coverage remains fallible'], sources:[{uri:'https://example.org/a'}], answer })), {type:'turn.completed'}] });
const source = { uri:'https://example.org/a', text:'Caller supplied retained text.' };

test('reviewed adaptive plan keeps compatible work, charges only new branches, and invalidates changed scope', async () => {
  const fixture=await fakeCodex({sessions:[output('First'),output('Second')]});
  try {
    let state=createInvestigation('Offline question', {scope:'Local scope', questions:[{id:'q1',parentId:null,question:'What does source A say?'}], sources:[source], budget:{searches:0,documents:4,seconds:90,calls:4}});
    let plan=planInvestigation(state);
    state=await advanceInvestigationPlan(state,plan,{confirmedPlanDigest:plan.digest,action:'investigate',branchIds:['q1'],lease:fixture.lease});
    state=reviseInvestigation(state,{budget:{searches:0,documents:4,seconds:90,calls:4},questions:[{id:'q1',parentId:null,question:'What does source A say?'},{id:'q2',parentId:null,question:'What limitation is documented?'}]});
    plan=planInvestigation(state);
    assert.deepEqual(plan.completedBranchIds,['q1']);
    assert.deepEqual(plan.remainingBranchIds,['q2']);
    const before=state.used.calls;
    await assert.rejects(advanceInvestigationPlan(state,plan,{confirmedPlanDigest:'wrong',action:'investigate',branchIds:['q2'],lease:fixture.lease}),/confirmation of the current plan digest/);
    state=await advanceInvestigationPlan(validateInvestigation(JSON.parse(JSON.stringify(state))),plan,{confirmedPlanDigest:plan.digest,action:'investigate',branchIds:['q2'],lease:fixture.lease});
    assert.equal(state.used.calls,before+1);
    assert.match((await fixture.session(1)).prompt,/First finding/, 'compatible completed findings stay available to new scoped questions');
    assert.deepEqual(planInvestigation(state).completedBranchIds,['q1','q2']);
    const current=planInvestigation(state);
    await assert.rejects(advanceInvestigationPlan(state,current,{confirmedPlanDigest:current.digest,action:'investigate',branchIds:['q1'],lease:fixture.lease}),/already complete/);
    assert.equal((await fixture.probes()).filter(args=>args[0]==='exec').length,2);

    const changed=reviseInvestigation(state,{scope:'Changed scope'});
    assert.deepEqual(planInvestigation(validateInvestigation(JSON.parse(JSON.stringify(changed)))).completedBranchIds,[]);
    assert.deepEqual(planInvestigation(changed).remainingBranchIds,['q1','q2']);
  } finally { await fixture.cleanup(); }
});
