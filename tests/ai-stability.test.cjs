const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const fixtures=path.join(__dirname,'fixtures','ai-stability');
const envelope=plan=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(plan)}]}]});
for(const file of fs.readdirSync(fixtures).filter(n=>n.endsWith('.json'))){
 test('recorded provider output: '+file,async()=>{
  const {input,plan}=JSON.parse(fs.readFileSync(path.join(fixtures,file),'utf8'));
  const {pagePlannerContract}=await import('../server/lifecycle/ai-page-planner.mjs');
  const {renderPage}=await import('../server/lifecycle/render.mjs');
  const {prepareConfig}=await import('../server/lifecycle/workflow.mjs');
  const result=pagePlannerContract.parse(envelope(plan),input);
  assert.equal(result.quality.state,'passed');
  assert.deepEqual(result.config.aiLinkInsertions.map(({url,anchor})=>({url,anchor})),input.links);
  const rendered=renderPage(prepareConfig(result.config));
  assert.ok(rendered.html.length>10000);assert.ok(!rendered.html.includes('[[PP_'));
 });
}
test('specific claims are still rejected even without verified facts',async()=>{
 const {inspectContentQuality}=await import('../server/content-quality.mjs');
 const input={brief:{facts:[],claimSubjects:['casinotest1']},targets:[{targetId:'t',field:'sections.body',fieldPath:'sections.0.body',currentValue:''}]};
 for(const value of ['Alpha is licensed in Malta.','This casino accepts Visa.','casinotest1 guarantees instant withdrawals.','Check the licence: Alpha is licensed in Malta.','Read the guide and Alpha offers a free plan.','The platform has a 500 EUR bonus.','We tested the operator.','Guaranteed instant withdrawals.','Alpha має ліцензію Мальти.','Alpha гарантує миттєві виплати.']){
  assert.equal(inspectContentQuality(input,[{targetId:'t',value}]).state,'review_required',value);
 }
});
test('questions, category headings, definitions and cautious instructions are not operator claims',async()=>{
 const {inspectContentQuality}=await import('../server/content-quality.mjs');
 const input={brief:{facts:[],claimSubjects:['casinotest1']},targets:[{targetId:'t',field:'cards.bonus',fieldPath:'cards.0.bonus',currentValue:''}]};
 for(const value of ['Licensing and Regulatory Oversight','Online Offers for Evaluation','Service offers often appear attractive but require careful examination.','This site provides informational guidance without endorsing any specific offers or services.','Visit the destination page to review the current options and terms presented for 2026.','Is the casino licensed by a recognized authority?','Payment Methods|Which deposit and withdrawal options are available?','A wagering requirement is a condition that may affect bonus winnings.','Check support options','Explore casinotest1 and compare the published payment terms.','Visit the linked destination to view how param is implemented.','Гарний вигляд не є гарантією достовірності.']){
  assert.equal(inspectContentQuality(input,[{targetId:'t',value}]).state,'passed',value);
 }
});
