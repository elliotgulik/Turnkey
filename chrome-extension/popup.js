import {parseImport,validatePayload,UNITS,LIMITS} from './measurement.js';
const file=document.querySelector('#file'), preview=document.querySelector('#preview'), send=document.querySelector('#send'), status=document.querySelector('#status');
let rows=[], generation=0;
file.addEventListener('change',async()=>{
  const current=++generation;
  rows=[]; preview.replaceChildren(); send.disabled=true; status.textContent='';
  try {
    const chosen=file.files[0]; if(!chosen) return;
    if(chosen.size>LIMITS.bytes) throw Error('File exceeds 1 MiB.');
    const items=parseImport(await chosen.text(),chosen.name.split('.').at(-1).toLowerCase());
    if(current!==generation) return;
    rows=items.map((item,index)=>{
      const section=document.createElement('section'), heading=document.createElement('h2'); heading.textContent=`${index+1}. ${item.geometry.type}`;section.append(heading);
      const serviceLabel=document.createElement('label'); serviceLabel.textContent='Service name or ID ';
      const service=document.createElement('input'); service.maxLength=80; service.placeholder='e.g. driveway';serviceLabel.append(service);section.append(serviceLabel);
      const unitLabel=document.createElement('label');unitLabel.textContent='Measurement unit ';
      const unit=document.createElement('select');
      Object.entries(UNITS).filter(([,u])=>u.kind===item.kind).forEach(([key])=>{const option=document.createElement('option');option.value=key;option.textContent={m:'metres',ft:'feet',m2:'square metres',ft2:'square feet'}[key];unit.append(option);});unitLabel.append(unit);section.append(unitLabel);
      const total=document.createElement('p'), update=()=>{total.textContent=`${(item.siValue*UNITS[unit.value].factor).toLocaleString(undefined,{maximumFractionDigits:2})} ${unit.value}`;};unit.addEventListener('change',update);update();section.append(total);
      const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 400 130');svg.setAttribute('aria-label','Coordinate outline preview; not a map');
      const groups=item.geometry.type==='Polygon'?item.geometry.coordinates:[item.geometry.coordinates], ps=groups.flat(), xs=ps.map(p=>p[0]),ys=ps.map(p=>p[1]),minX=Math.min(...xs),minY=Math.min(...ys),dx=Math.max(...xs)-minX||1,dy=Math.max(...ys)-minY||1;
      groups.forEach(group=>{const line=document.createElementNS(svg.namespaceURI,'polyline');line.setAttribute('points',group.map(p=>`${10+(p[0]-minX)/dx*380},${120-(p[1]-minY)/dy*110}`).join(' '));line.setAttribute('fill','none');line.setAttribute('stroke','#146450');line.setAttribute('stroke-width','2');svg.append(line);});section.append(svg);
      const note=document.createElement('p');note.textContent='Outline only (axes scaled independently). Expand to inspect every coordinate.';section.append(note);
      const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent='Coordinates sent to TurnKey';pre.textContent=JSON.stringify(item.geometry,null,2);details.append(summary,pre);section.append(details);preview.append(section);
      return {item,service,unit};
    });send.disabled=false;
  } catch(error) {if(current===generation) status.textContent=error.message;}
});
send.addEventListener('click',async()=>{
  send.disabled=true;
  try {
    const payload=validatePayload({version:1,measurements:rows.map(({item,service,unit})=>({geometry:item.geometry,kind:item.kind,service:service.value.trim(),unit:unit.value,value:item.siValue*UNITS[unit.value].factor}))});
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const url=new URL(tab?.url||'about:blank');
    if(!((url.protocol==='https:' && url.hostname==='turnkeycrm.net' && !url.port) || (['http:','https:'].includes(url.protocol) && url.hostname==='localhost'))) throw Error('Open an allowed TurnKey or localhost tab first.');
    const result=await chrome.tabs.sendMessage(tab.id,{type:'TK_MEASUREMENT_IMPORT',payload},{frameId:0});
    if(!result?.dispatched) throw Error(result?.error||'Import could not be dispatched. Reload the TurnKey tab.');
    status.textContent='Dispatched to the page. Confirm receipt in TurnKey; this does not confirm a saved quote.';
  }catch(error){status.textContent=error.message;}finally{send.disabled=!rows.length;}
});
