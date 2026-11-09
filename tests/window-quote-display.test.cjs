const{test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const publicHtml=fs.readFileSync('quote.html','utf8'),crmHtml=fs.readFileSync('index.html','utf8');
function section(html,a,b){return html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));}
function setup(){const c=vm.createContext({window:{},escapeHtml:s=>String(s),money:n=>'NZ$'+n});vm.runInContext(fs.readFileSync('pricing-engine.js','utf8'),c);vm.runInContext(fs.readFileSync('format-utils.js','utf8'),c);c.TK_PRICING=c.window.TK_PRICING;c.TK_FORMAT=c.window.TK_FORMAT;return c;}
test('public quote hides window counts and unit rates while preserving line prices and other service measurements',()=>{
 const c=setup();vm.runInContext(section(publicHtml,'function pubPropertySummary(services){','function pubPriceBreakdown(q){'),c);
 const start=publicHtml.indexOf('function pubPriceBreakdown(q){'),end=publicHtml.indexOf('\n}',start)+2;vm.runInContext(publicHtml.slice(start,end),c);
 const services=[{svc:'windows',qty:37,fixedPrice:148},{svc:'driveway',qty:12,fixedPrice:60}];
 const before=JSON.stringify(services),summary=c.pubPropertySummary(services),breakdown=c.pubPriceBreakdown({services,amount:208});
 assert.doesNotMatch(summary,/37|panes/);assert.match(summary,/Included/);assert.match(summary,/12/);
 assert.doesNotMatch(breakdown,/37|panes/);assert.match(breakdown,/148/);assert.match(breakdown,/60/);assert.equal(JSON.stringify(services),before);
});
test('customer document renderers hide windows counts in PDF, HTML and email descriptions',()=>{
 assert.match(crmHtml,/var sub=s\.svc==='windows'\?'Service total'/);
 assert.match(crmHtml,/var desc=s\.svc==='windows'\?TK_PRICING\.lineLabel\(s\)/);
 assert.match(crmHtml,/esc\(s\.svc==='windows'\?'Service total'/);
});
