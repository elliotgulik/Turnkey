import {validatePayload} from './chrome-extension/measurement.js';

// Page messages are untrusted. Import only into an open, editable quote after review.
let reviewing=false;
window.addEventListener('message',event=>{
  if(event.source!==window||event.origin!==location.origin||event.data?.type!=='TK_MEASUREMENT_IMPORT'||reviewing)return;
  try {
    // Check session/quote/accepted state before touching the untrusted payload at all,
    // so a stray or malicious message never gets parsed outside an eligible quote.
    const r=records.find(x=>x.id===activeLeadId),business=currentBusinessId;
    if(!r||!document.getElementById('quote-overlay')?.classList.contains('open'))throw Error('Open the intended quote before importing measurements.');
    // Matches quote-workspace's own locked(r) — isWon alone misses a customer-accepted
    // quote that staff haven't yet marked won, which must stay just as locked.
    if(isWon(r)||r.quoteStatus==='accepted')throw Error('Accepted quotes are locked. Create a new quote first.');
    if(JSON.stringify(event.data).length>1500000)throw Error('Measurement import is too large.');
    const payload=validatePayload(event.data.payload);
    const imported=payload.measurements.map(m=>{
      const svc=Object.keys(SERVICES).find(k=>k.toLowerCase()===m.service.toLowerCase()||SERVICES[k].label.toLowerCase()===m.service.toLowerCase());
      if(!svc)throw Error('Unknown service: '+m.service+'. Use the TurnKey service ID, such as driveway, roof, gutter or fence.');
      const unit=SERVICES[svc].unit, area=unit==='m²';
      if(!['m','m²'].includes(unit)||m.kind!==(area?'area':'length'))throw Error('Measurement units do not match '+SERVICES[svc].label+'.');
      if(m.geometry.type==='Polygon'&&m.geometry.coordinates.length!==1)throw Error('Outlines with holes are not supported in this editor. Export separate simple outlines.');
      const size=m.value/(m.unit==='ft2'?10.763910416709722:m.unit==='ft'?3.280839895013123:1);
      // 5 ha / 5 km comfortably covers a large commercial roof or boundary run while still
      // rejecting an accidentally city-block-scale draw (the old 100 ha / 100 km cap did not).
      if(size>(area?50000:5000))throw Error('Measurement exceeds the supported job size.');
      let coordinates=m.geometry.type==='Polygon'?m.geometry.coordinates[0].slice(0,-1):m.geometry.coordinates;
      const xs=coordinates.map(c=>c[0]),ys=coordinates.map(c=>c[1]),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys),scale=100/Math.max(maxX-minX,maxY-minY,1e-9);
      return {id:'import-'+crypto.randomUUID(),service:svc,size,unit,geoPts:coordinates.map(([lng,lat])=>({lat,lng})),
        // Placeholder on-canvas layout scaled to the real outline's proportions (not a map
        // projection) — kept distinct so a shape never collapses to one dot before any
        // map-based renderer recomputes pixel positions from geoPts.
        points:coordinates.map(([lng,lat])=>({x:400+(lng-(minX+maxX)/2)*scale,y:300-(lat-(minY+maxY)/2)*scale})),
        notes:'Imported measurement — verify on site',photoPaths:[]};
    });
    reviewing=true;
    const dialog=document.createElement('dialog');dialog.className='measurement-review';
    const title=document.createElement('h2');title.textContent='Review imported measurements';
    const context=document.createElement('p');context.textContent=(r.name||'Customer')+' · '+(r.address||'Address not set');
    const list=document.createElement('ul');imported.forEach(a=>{const li=document.createElement('li');li.textContent=SERVICES[a.service].label+' — '+a.size.toLocaleString(undefined,{maximumFractionDigits:2})+' '+a.unit;list.append(li);});
    const note=document.createElement('p');note.textContent='These ground measurements exclude roof pitch and surface condition. Import adds outlines to this quote. Review existing measurements to avoid counting the same area twice. Prices and sending remain under your control.';
    const actions=document.createElement('div');actions.className='sale-actions';
    const cancel=document.createElement('button');cancel.className='btn ghost';cancel.textContent='Cancel';
    const apply=document.createElement('button');apply.className='btn accent';apply.textContent='Add to this quote';
    const clean=()=>{dialog.close();dialog.remove();reviewing=false;};cancel.onclick=clean;dialog.oncancel=clean;
    apply.onclick=()=>{
      if(currentBusinessId!==business||activeLeadId!==r.id||!records.includes(r)||isWon(r)||r.quoteStatus==='accepted'||!document.getElementById('quote-overlay')?.classList.contains('open')){clean();toast('Quote changed. Import again into the intended quote.');return;}
      r.areaPolys=[...(r.areaPolys||[]),...imported];delete r._mapSnapshotDataUrl;
      renderQuoteMap(r);renderSvcLines();clean();toast('Measurements added. Review the map and quantities before saving.');
    };
    actions.append(cancel,apply);dialog.append(title,context,list,note,actions);document.body.append(dialog);dialog.showModal();
  }catch(e){toast('Import: '+e.message);}
});
