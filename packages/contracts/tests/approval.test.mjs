import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ApprovalLedger,digestAction} from '../dist/index.js';
const identity={instance_id:'private-1',mode:'personal',principal_id:'user-1'};
const action={tool_id:'calendar',operation:'create',account_id:'account-1',target:'primary',arguments_json:'{"title":"키리안과 회의","time":"10:00"}'};
const rejects=(fn,code)=>assert.throws(fn,error=>error.code===code);
async function setup(){
 const ledger=new ApprovalLedger(identity,'pc-1',true);
 const draft={draft_id:'draft-1',revision:1,identity,executor_id:'pc-1',action:structuredClone(action),payload_sha256:await digestAction(action),expires_at_ms:5000};
 await ledger.registerDraft(draft);
 return {ledger,draft};
}
function receipt(approval,status='succeeded'){
 return {execution_id:approval.execution_id,draft_id:approval.draft_id,draft_revision:approval.draft_revision,identity,
 executor_id:'pc-1',payload_sha256:approval.payload_sha256,status,provider_id:'calendar',
 provider_operation_id:status==='succeeded'?'event-1':null,error_code:status==='succeeded'?null:'network_timeout',recorded_at_ms:3000};
}
test('exact payload hash covers tool, operation, account, target and argument text',async()=>{
 const base=await digestAction(action);
 for(const key of Object.keys(action)){
  const changed={...action,[key]:key==='arguments_json'?'{"time":"10:00","title":"키리안과 회의"}':action[key]+'x'};
  assert.notEqual(await digestAction(changed),base);
 }
 await assert.rejects(()=>digestAction({...action,arguments_json:'null'}));
 await assert.rejects(()=>digestAction({...action,arguments_json:'broken'}));
});
test('registered draft tampering, stale revisions and foreign executor are rejected',async()=>{
 const {ledger,draft}=await setup();
 await assert.rejects(()=>ledger.registerDraft({...draft,action:{...action,target:'other'}}),e=>e.code==='payload_digest_mismatch');
 await assert.rejects(()=>ledger.registerDraft({...draft,executor_id:'web-1'}),e=>e.code==='foreign_executor');
 await assert.rejects(()=>ledger.registerDraft({...draft,expires_at_ms:6000}),e=>e.code==='draft_revision_conflict');
 draft.action.target='caller-mutated';
 assert.equal(ledger.approve('draft-1',1,'approval-1','execution-1',1000).payload_sha256,await digestAction(action));
});
test('claim requires locally issued consent for the current exact draft, not matching wire fields alone',async()=>{
 const {ledger}=await setup();
 const approval=ledger.approve('draft-1',1,'approval-1','execution-1',1000);
 for(const modified of [
  {...approval,execution_id:'execution-2'},
  {...approval,payload_sha256:'0'.repeat(64)},
  {...approval,expires_at_ms:9000},
  {...approval,identity:{...identity,principal_id:'other'}},
  {...approval,executor_id:'web-1'},
 ]) assert.throws(()=>ledger.claim(modified,1001));
 const unrelated=new ApprovalLedger(identity,'pc-1',true);
 rejects(()=>unrelated.claim(approval,1001),'unrecognized_approval');
 assert.equal(ledger.claim(approval,1001).state,'running');
});
test('editing an approved draft or reaching its deadline requires new consent',async()=>{
 const {ledger,draft}=await setup();
 const approval=ledger.approve('draft-1',1,'approval-1','execution-1',1000);
 await ledger.registerDraft({...draft,revision:2});
 rejects(()=>ledger.claim(approval,1001),'stale_draft');
 rejects(()=>ledger.approve('draft-1',2,'approval-2','execution-2',5000),'approval_expired');
 const next=ledger.approve('draft-1',2,'approval-2','execution-2',4999);
 rejects(()=>ledger.claim(next,5000),'approval_expired');
});
test('same approval or execution ID cannot launch another operation',async()=>{
 const {ledger}=await setup();
 const approval=ledger.approve('draft-1',1,'approval-1','execution-1',1000);
 ledger.claim(approval,1001);
 rejects(()=>ledger.claim(approval,1002),'execution_already_claimed');
 rejects(()=>ledger.approve('draft-1',1,'approval-2','execution-1',1003),'approval_reused');
 ledger.recordReceipt(receipt(approval),'pc-1');
 rejects(()=>ledger.claim(approval,1004),'execution_already_claimed');
});
test('unknown result remains non-retryable and may later receive actual success evidence',async()=>{
 const {ledger}=await setup();
 const approval=ledger.approve('draft-1',1,'approval-1','execution-1',1000);
 ledger.claim(approval,1001);
 assert.equal(ledger.recordReceipt(receipt(approval,'unknown'),'pc-1').state,'unknown');
 rejects(()=>ledger.claim(approval,1002),'execution_already_claimed');
 assert.equal(ledger.recordReceipt(receipt(approval),'pc-1').state,'succeeded');
 assert.equal(ledger.recordReceipt(receipt(approval),'pc-1').state,'succeeded');
 rejects(()=>ledger.recordReceipt(receipt(approval,'failed'),'pc-1'),'terminal_receipt_conflict');
});
test('restart restores in-flight claims as unknown; changed payload cannot reuse execution ID',async()=>{
 const {ledger,draft}=await setup();
 const approval=ledger.approve('draft-1',1,'approval-1','execution-1',1000);
 ledger.claim(approval,1001);
 const restored=new ApprovalLedger(identity,'pc-1',true,JSON.parse(JSON.stringify(ledger.snapshot())));
 assert.equal(restored.get('execution-1').state,'unknown');
 const action2={...action,target:'other'};
 await restored.registerDraft({...draft,action:action2,payload_sha256:await digestAction(action2),revision:2});
 rejects(()=>restored.approve('draft-1',2,'approval-2','execution-1',1002),'approval_reused');
 assert.equal(restored.recordReceipt(receipt(approval),'pc-1').state,'succeeded');
});
test('receipt requires authenticated executor, matching claim and actual provider identifier',async()=>{
 const {ledger}=await setup();
 const approval=ledger.approve('draft-1',1,'approval-1','execution-1',1000);
 rejects(()=>ledger.recordReceipt(receipt(approval),'pc-1'),'unrecognized_receipt');
 ledger.claim(approval,1001);
 rejects(()=>ledger.recordReceipt(receipt(approval),'other'),'foreign_executor');
 rejects(()=>ledger.recordReceipt({...receipt(approval),payload_sha256:'0'.repeat(64)},'pc-1'),'unrecognized_receipt');
 assert.throws(()=>ledger.recordReceipt({...receipt(approval),provider_operation_id:null},'pc-1'));
 assert.equal(ledger.get('execution-1').state,'running');
});
test('public/web identity cannot obtain local execution by naming a PC executor',()=>{
 rejects(()=>new ApprovalLedger({...identity,mode:'public_demo'},'pc-1',true),'local_execution_not_granted');
 rejects(()=>new ApprovalLedger(identity,'pc-1',false),'local_execution_not_granted');
});
test('snapshots are independent and terminal evidence is required on restore',async()=>{
 const {ledger}=await setup();
 const approval=ledger.approve('draft-1',1,'approval-1','execution-1',1000);
 ledger.claim(approval,1001);
 const snapshot=ledger.snapshot();
 snapshot.claims[0].state='succeeded';
 assert.equal(ledger.get('execution-1').state,'running');
 rejects(()=>new ApprovalLedger(identity,'pc-1',true,snapshot),'missing_execution_evidence');
});

test('wire key order does not change duplicate draft or receipt identity', async () => {
 const {ledger,draft}=await setup();
 const reversed=Object.fromEntries(Object.entries(draft).reverse());
 reversed.action=Object.fromEntries(Object.entries(draft.action).reverse());
 await ledger.registerDraft(reversed);
 const approval=ledger.approve('draft-1',1,'approval-1','execution-1',1000);
 ledger.claim(approval,1001);
 const original=receipt(approval);
 ledger.recordReceipt(original,'pc-1');
 const reordered=Object.fromEntries(Object.entries(original).reverse());
 reordered.identity=Object.fromEntries(Object.entries(original.identity).reverse());
 assert.equal(ledger.recordReceipt(reordered,'pc-1').state,'succeeded');
});
