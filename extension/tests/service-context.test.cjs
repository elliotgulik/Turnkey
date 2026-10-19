const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const extension = path.resolve(__dirname, '..');

function engines() {
  const scope = {window:{}};
  vm.createContext(scope);
  for (const file of ['pricing-engine.js','cost-engine.js']) vm.runInContext(fs.readFileSync(path.join(extension,'vendor',file),'utf8'),scope);
  return scope.window;
}

test('one closed house outline supplies distinct area and perimeter; windows never use geometry', async () => {
  const {measureGeometry,EARTH_RADIUS} = await import('../geometry.js');
  const {measurementQuantity,measurementForService} = await import('../content/panel/measurements.js');
  const {TK_PRICING:{SERVICES}} = engines();
  const degree = 180 / Math.PI / EARTH_RADIUS;
  const points = [[0,0],[20,0],[20,10],[0,10]].map(([x,y]) => ({lat:y*degree,lng:x*degree}));
  for (const kind of ['area','perimeter']) {
    const result = measureGeometry(points,{kind});
    const measurement = {type:kind,size:result.value,quantities:{area:result.groundArea,perimeter:result.perimeter},geoPts:result.points};
    assert.equal(measurementQuantity(measurement,SERVICES.driveway),200);
    assert.equal(measurementQuantity(measurement,SERVICES.housewash),60);
    assert.equal(measurementQuantity(measurement,SERVICES.windows),null);
    assert.equal(measurementQuantity(measurement,SERVICES.fence),null);
    const house = measurementForService(measurement,'housewash',SERVICES.housewash);
    assert.equal(house.size,60); assert.equal(house.unit,'m'); assert.equal(house.type,'perimeter');
  }
  assert.equal(measurementQuantity({type:'area',size:200},SERVICES.housewash),null,'older area-only records must not be relabelled as metres');
  const elevated = points.map((point,i) => ({...point,altitude:i===1||i===2 ? 15 : 0}));
  const surface = measureGeometry(elevated,{kind:'perimeter',mode:'surface'});
  assert.ok(surface.surfaceArea>surface.groundArea);
});

test('itemised cost allocation preserves fractional totals and never creates a negative rounding line',async () => {
  const {instantPricing} = await import('../content/panel/quote-pricing.js');
  const {TK_PRICING:pricing,TK_COST:cost} = engines();
  const lines = [{svc:'driveway',qty:200},{svc:'housewash',qty:60},{svc:'windows',qty:12}];
  for (const price of [undefined,650.37,1]) {
    const model = instantPricing(pricing,cost,lines,{price,targetMargin:0.6});
    assert.equal(model.lines.reduce((sum,l)=>sum+Math.round(l.fixedPrice*100),0),Math.round(model.total*100));
    if (price!==undefined) assert.equal(model.total,price);
    assert.equal(Math.round(pricing.linesBaseTotal(model.lines)*100),Math.round(model.total*100));
    const weights = model.breakdown.lines.map(l=>l.recommendedPrice);
    const totalWeight=weights.reduce((a,b)=>a+b,0);
    model.lines.forEach((line,i)=>assert.ok(Math.abs(line.fixedPrice-model.total*weights[i]/totalWeight)<=0.010001));
  }
  const many=instantPricing(pricing,cost,Array.from({length:300},()=>({svc:'windows',qty:1})),{price:1});
  assert.ok(many.lines.every(line=>line.fixedPrice>=0));
  assert.equal(many.lines.reduce((sum,l)=>sum+Math.round(l.fixedPrice*100),0),100);
  assert.throws(()=>instantPricing(pricing,cost,[{svc:'windows',qty:1.5}]),/whole-number manual pane count/);
});

test('linked context includes all fields, original requests and legacy notes without executable HTML',async () => {
  const {requestedServices,renderCustomerContext} = await import('../content/panel/customer-context.js');
  const customer={name:'<img src=x onerror=alert(1)>',phone:'021 " &',email:'a<b@example.net',address:'<Street>',notes:'Gate <code>',source:'Wix'};
  const job={details:{jobNotes:'Rear deck <script>',requestedServices:[{name:'Roof treatment',service_id:'roof'},'Other <request>'],windowsRequested:true}};
  const html=renderCustomerContext(customer,job,engines().TK_PRICING.SERVICES);
  for (const value of ['&lt;img','021 &quot; &amp;','a&lt;b@example.net','&lt;Street&gt;','Gate &lt;code&gt;','Rear deck &lt;script&gt;','Roof treatment','Other &lt;request&gt;','Window Cleaning','Wix']) assert.ok(html.includes(value),value);
  assert.ok(!html.includes('<img')); assert.ok(!html.includes('<script>'));
  assert.deepEqual(requestedServices({notes:'Services requested: House wash, Windows. Gate closed.'}).map(s=>s.service_id),['housewash','windows']);
});


test('account guards invalidate identity/tenant/deployment changes, but allow ordinary token rotation',async()=>{
  const {connectionChanged}=await import('../api/storage.js');
  assert.equal(connectionChanged({tk_session:{oldValue:{userId:'same',accessToken:'old'},newValue:{userId:'same',accessToken:'fresh'}}}),false);
  assert.equal(connectionChanged({tk_session:{oldValue:{userId:'old'},newValue:{userId:'new'}}}),true);
  assert.equal(connectionChanged({tk_session:{oldValue:{userId:'old'},newValue:undefined}}),true);
  assert.equal(connectionChanged({tk_profile:{oldValue:{business_id:'old'},newValue:{business_id:'new'}}}),true);
  assert.equal(connectionChanged({tk_config:{oldValue:{supabaseUrl:'one'},newValue:{supabaseUrl:'two'}}}),true);
});
