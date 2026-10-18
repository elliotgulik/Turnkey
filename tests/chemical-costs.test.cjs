const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
const plain=v=>JSON.parse(JSON.stringify(v));
function engine(){const c={window:{}};vm.runInNewContext(fs.readFileSync(require.resolve('../cost-engine.js'),'utf8'),c);return c.window.TK_COST;}
function functionSource(name){
 const start=html.search(new RegExp('(?:async )?function '+name+'\\('));
 return html.slice(start,html.indexOf('\n}',start)+2);
}
function crm(e,storage=new Map()){
 const c=vm.createContext({TK_COST:e,SVC_COST:e.SVC_COST,CHEMICALS:e.CHEMICALS,COST_INPUTS:e.COST_INPUTS,
  SERVICES:{roof:{label:'Roof',unit:'m²',rate:8}},currentBusinessId:'A',businessStateReady:true,
  records:[],seq:1,goals:[],goalSeq:1,followSeq:1,docTemplate:{},salesSourceSpend:{},recordBusinesses:new WeakMap(),
  localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
  businessStoreKey:()=> 'A',preserveLegacyState(){},scheduleSupabaseSync(){},renderPricing(){},toast(){},console});
 for(const name of ['saveState','loadState','savePricingConfig','applyPricingConfig','setSvcChemical','setSvcChemicalUsage','setChemPrice'])vm.runInContext(functionSource(name),c);
 return c;
}
test('multiple concentrate products sum into litres, chemical cost and recommended delivery totals',()=>{
 const e=engine();
 e.applyChemicalConfig({chemicals:{sodiumHypo:4,mossMould:7,surfactant:12},svcCost:{roof:{m2ph:60,chemicals:{sodiumHypo:0.03,mossMould:0.02,surfactant:0.001}}}});
 const b=e.costBreakdown([{svc:'roof',qty:100}],{km:0});
 assert(Math.abs(b.chem-27.2)<1e-9);assert(Math.abs(b.litres-5.1)<1e-9);assert.equal(b.labourMin,125);
 assert(Math.abs(b.costUnrounded-(b.wageCost+27.2+b.equipmentCost+b.consumablesCost))<1e-9);
 assert(e.marginPct(b.recommended,b.costUnrounded)>=55);assert.equal(b.unsetChemicals,undefined);
});
test('unset supplier prices stay null, are reported as incomplete, and differ from explicit zero',()=>{
 const e=engine();assert.equal(e.CHEMICALS.mossMould.perL,null);assert.equal(e.CHEMICALS.surfactant.perL,null);
 e.applyChemicalConfig({svcCost:{roof:{chemicals:{sodiumHypo:0.03,mossMould:0.02,surfactant:0.001}}}});
 assert.deepEqual(plain(e.costBreakdown([{svc:'roof',qty:100}]).unsetChemicals),['mossMould','surfactant']);
 assert.equal(e.costBreakdown([{svc:'roof',qty:0}]).unsetChemicals,undefined);
 const saved=plain(e.chemicalConfig());saved.chemicals.mossMould=0;saved.chemicals.surfactant=10;e.applyChemicalConfig(saved);
 assert.equal(e.costBreakdown([{svc:'roof',qty:100}]).unsetChemicals,undefined);
 assert.match(html,/Costs, recommended price and margin are incomplete/);
 assert.match(fs.readFileSync(require.resolve('../extension/content/panel/quote.js'),'utf8'),/Costs, recommended price and margin are incomplete/);
});
test('legacy softWash/degreaser values survive while explicit no-chemical selection and business resets work',()=>{
 const e=engine();e.applyChemicalConfig({chemicals:{softWash:8.5,degreaser:6.2},svcCost:{roof:{litrePerM2:0.07,m2ph:28},gutter:{litrePerM2:0.02}}});
 assert(Math.abs(e.lineChemCost({svc:'roof',qty:100})-59.5)<1e-9);
 assert(Math.abs(e.lineChemCost({svc:'gutter',qty:100})-12.4)<1e-9);
 const saved=plain(e.chemicalConfig());e.applyChemicalConfig(saved);assert.equal(e.SVC_COST.roof.m2ph,28);
 e.applyChemicalConfig({svcCost:{roof:{chemicals:{}}}});assert.equal(e.lineChemCost({svc:'roof',qty:100}),0);
 e.applyChemicalConfig({});assert.equal(e.CHEMICALS.softWash.perL,5.8);assert.equal(e.CHEMICALS.surfactant.perL,null);
 assert.equal(e.lineLitres({svc:'roof',qty:100}),5.5);
 e.applyChemicalConfig({svcCost:{roof:{chem:'degreaser',litrePerM2:0.1,chemicals:{unknown:1,sodiumHypo:-2,surfactant:Infinity}}},chemicals:{sodiumHypo:-1}});
 assert.deepEqual(plain(e.serviceChemicals('roof')),{});assert.equal(e.CHEMICALS.sodiumHypo.perL,3.2);
});
test('CRM editors persist choices to local reload and business config; Earth uses identical costs; accepted snapshots stay unchanged',async()=>{
 const storage=new Map(),e=engine(),c=crm(e,storage);let remote;
 c.sb={from:table=>{assert.equal(table,'businesses');return {upsert:async row=>{remote=plain(row);return {error:null};}};}};
 const snapshot=plain(e.costBreakdown([{svc:'roof',qty:100}]));c.records=[{stage:'accepted',estimatedCost:snapshot.cost,costSnapshot:snapshot}];
 const accepted=JSON.stringify(c.records);
 c.setSvcChemical('roof','softWash',false);c.setSvcChemical('roof','mossMould',true);c.setSvcChemicalUsage('roof','mossMould','0.02');
 c.setSvcChemical('roof','surfactant',true);c.setSvcChemicalUsage('roof','surfactant','0.001');c.setChemPrice('mossMould','7');c.setChemPrice('surfactant','12');
 c.setChemPrice('mossMould','-4');c.setSvcChemicalUsage('roof','mossMould','-2');
 assert.equal(e.CHEMICALS.mossMould.perL,7);assert.equal(e.serviceChemicals('roof').mossMould,0.02);
 await c.savePricingConfig();assert.equal(remote.id,'A');
 const fresh=engine(),reload=crm(fresh,storage);assert.equal(reload.loadState(),true);
 assert.deepEqual(plain(fresh.serviceChemicals('roof')),{mossMould:0.02,surfactant:0.001});
 const server=engine();crm(server).applyPricingConfig(remote.pricing_config);
 const {configureCosts}=await import('../extension/content/panel/quote-pricing.js');
 const earth=engine();configureCosts(earth,remote.pricing_config);
 const lines=[{svc:'roof',qty:100}];
 assert.deepEqual(plain(server.costBreakdown(lines)),plain(earth.costBreakdown(lines)));
 assert.equal(fresh.lineChemCost(lines[0]),server.lineChemCost(lines[0]));
 configureCosts(earth,{});assert.equal(earth.CHEMICALS.mossMould.perL,null);assert.deepEqual(plain(earth.serviceChemicals('roof')),{softWash:0.055});
 assert.equal(JSON.stringify(c.records),accepted);assert.equal(JSON.stringify(reload.records),accepted);
 assert.equal(fs.readFileSync(require.resolve('../cost-engine.js'),'utf8'),fs.readFileSync(require.resolve('../extension/vendor/cost-engine.js'),'utf8'));
});
