const test=require('node:test'),assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),ctx={window:{}};
vm.runInNewContext(fs.readFileSync('pricing-engine.js','utf8'),ctx);
const pricing=ctx.window.TK_PRICING;
test('GST-inclusive document breakdown uses cents and preserves the agreed total',()=>{
 for(const [total,exGst,gst] of [[200,173.91,26.09],[115,100,15],[650.37,565.54,84.83],[0,0,0]]){
  assert.deepEqual(JSON.parse(JSON.stringify(pricing.gstFromInclusive(total))),{exGst,gst});
  assert.equal(Math.round((exGst+gst)*100),Math.round(total*100));
 }
});
