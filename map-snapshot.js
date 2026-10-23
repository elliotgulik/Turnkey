// Customer-facing property geometry only. No rates, costs, margins or notes.
// buildUrl remains compatible with existing callers. buildSnapshot produces a
// Compressed imagery for jsPDF, with an honest measured-outline fallback.
(function (global) {
  'use strict';
  const esc = v => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number = v => typeof v === 'number' ? (Number.isFinite(v) ? v : null) : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null;
  const geoPoint = p => {
    const lat = number(p?.lat), lng = number(p?.lng);
    return lat !== null && lng !== null && Math.abs(lat) <= 85.05112878 && Math.abs(lng) <= 180 ? {lat, lng} : null;
  };
  const pixelPoint = p => {
    const x = number(p?.x), y = number(p?.y);
    return x !== null && y !== null && Math.abs(x) <= 1e7 && Math.abs(y) <= 1e7 ? {x, y} : null;
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function points(input, parse, closed) {
    if (!Array.isArray(input) || input.length > 20000) return null;
    const out = input.map(parse);
    // Never join across a missing/invalid vertex: that invents a new scope.
    if (out.some(p => !p)) return null;
    if (closed && out.length > 1 && same(out[0], out[out.length - 1])) out.pop();
    return new Set(out.map(p => JSON.stringify(p))).size >= (closed ? 3 : 2) ? out : null;
  }
  function getAreas(input) {
    const services = global.TK_PRICING?.SERVICES || {};
    return (Array.isArray(input) && input.length <= 256 ? input : []).flatMap(a => {
      if (!a || typeof a !== 'object') return [];
      const service = a.service || a.svc, svc = services[service];
      if (!svc || !['closed', 'open'].includes(svc.shape)) return [];
      const closed = svc.shape === 'closed', geoPts = points(a.geoPts, geoPoint, closed), pixelPts = points(a.points || a.pts, pixelPoint, closed);
      if (!geoPts && !pixelPts) return [];
      const size = number(a.size);
      return [{ service, label: String(svc.label || service), color: /^#[a-f0-9]{6}$/i.test(svc.color || '') ? svc.color : '#138a72', closed, geoPts, pixelPts, measurement: size !== null && size >= 0 ? size + ' ' + String(svc.unit || '') : 'Measurement unavailable' }];
    });
  }
  function dimensions(opts = {}) {
    const match = /^(\d{1,3})x(\d{1,3})$/.exec(opts.size || '640x400');
    return { width: match ? Math.max(180, Math.min(640, Number(match[1]))) : 640, height: match ? Math.max(160, Math.min(640, Number(match[2]))) : 400, scale: Number(opts.scale) === 1 ? 1 : 2 };
  }
  function world(p, anchor) {
    // Unwrap longitude around the first point for date-line properties.
    let lng = p.lng;
    while (lng - anchor > 180) lng -= 360;
    while (lng - anchor < -180) lng += 360;
    const sin = Math.sin(p.lat * Math.PI / 180);
    return { x: (lng + 180) / 360, y: .5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI) };
  }
  function centroid(pts) {
    const lng = pts[0].lng;
    const x = pts.reduce((n,p) => n + (((p.lng - lng + 540) % 360) - 180 + lng),0) / pts.length;
    return { lat: pts.reduce((n,p) => n + p.lat,0) / pts.length, lng: ((x + 540) % 360) - 180 };
  }
  function encodePath(pts) {
    let lat=0,lng=0;
    const encode=n=>{let value=n<0?~(n<<1):n<<1,out='';while(value>=32){out+=String.fromCharCode((32|(value&31))+63);value>>>=5;}return out+String.fromCharCode(value+63);};
    return pts.map(p=>{const a=Math.round(p.lat*1e5),b=Math.round(p.lng*1e5),out=encode(a-lat)+encode(b-lng);lat=a;lng=b;return out;}).join('');
  }
  function buildUrl(input, mapsKey, opts = {}) {
    if (typeof mapsKey !== 'string' || !mapsKey.trim()) return null;
    const {width, height, scale} = dimensions(opts), areas = getAreas(input).filter(a => a.geoPts);
    const params = new URLSearchParams({size: width + 'x' + height, scale: String(scale), maptype:'satellite', format:'png'});
    for (const [i,a] of areas.entries()) {
      const pts = a.closed ? [...a.geoPts, a.geoPts[0]] : a.geoPts;
      const color = a.color.replace('#','0x');
      params.append('path', 'color:' + color + '|weight:3' + (a.closed ? '|fillcolor:' + color + '33' : '') + '|' + (opts.encoded ? 'enc:'+encodePath(pts) : pts.map(p => p.lat.toFixed(6) + ',' + p.lng.toFixed(6)).join('|')));
      if (opts.labels && i < 35) {
        const c = centroid(a.geoPts);
        params.append('markers', 'color:' + color + '|label:' + (i + 1).toString(36).toUpperCase() + '|' + c.lat.toFixed(6) + ',' + c.lng.toFixed(6));
      }
    }
    if (areas.length) {
      // A path-only Static Maps request can auto-fit to a very broad viewport.
      // Set an explicit, bounds-derived camera so a typical house/driveway
      // fills the image while retaining comfortable space around the outline.
      const pts = areas.flatMap(a => a.geoPts);
      const projected = pts.map(p => world(p, pts[0].lng));
      const bounds = projected.reduce((b,p) => ({minX:Math.min(b.minX,p.x),maxX:Math.max(b.maxX,p.x),minY:Math.min(b.minY,p.y),maxY:Math.max(b.maxY,p.y)}), {minX:Infinity,maxX:-Infinity,minY:Infinity,maxY:-Infinity});
      const spanX = Math.max(bounds.maxX-bounds.minX, 1e-7), spanY = Math.max(bounds.maxY-bounds.minY, 1e-7);
      const zoom = Math.max(3, Math.min(21, Math.floor(Math.log2(Math.min(width/(256*spanX), height/(256*spanY)) * .82))));
      const centerY = (bounds.minY+bounds.maxY)/2;
      const centerLat = Math.atan(Math.sinh(Math.PI*(1-2*centerY))) * 180/Math.PI;
      const centerLng = (((bounds.minX+bounds.maxX)/2)*360)-180;
      params.set('center', centerLat.toFixed(7)+','+centerLng.toFixed(7));
      params.set('zoom', String(zoom));
    }
    if (!areas.length) {
      // Pixel sketches have no geographic anchor. Address-only imagery must
      // never be mistaken for a measured outline; buildSnapshot uses a diagram.
      if (typeof opts.fallbackAddress !== 'string' || !opts.fallbackAddress.trim()) return null;
      params.set('center', opts.fallbackAddress.trim()); params.set('zoom','20');
      params.append('markers','color:red|' + opts.fallbackAddress.trim());
    } else if (!opts.labels) {
      const c = centroid(areas.flatMap(a => a.geoPts));
      params.append('markers','color:red|' + c.lat.toFixed(6) + ',' + c.lng.toFixed(6));
    }
    params.set('key',mapsKey);
    const url = 'https://maps.googleapis.com/maps/api/staticmap?' + params;
    // Google rejects URLs longer than 16,384 characters. Fall back to the
    // complete local diagram rather than dropping vertices or whole shapes.
    return url.length <= 16384 ? url : !opts.encoded ? buildUrl(input,mapsKey,{...opts,encoded:true}) : null;
  }
  function layout(input, opts = {}) {
    const all = getAreas(input);
    if (!all.length) return null;
    const geo = all.every(a => a.geoPts), mixed = !geo && all.some(a=>a.geoPts);
    const {width, height, scale} = dimensions(opts);
    const mapHeight = height, fullHeight = height + 36 + all.length * 22;
    // Geographic and unanchored sketches must never share a pretend map
    // frame. Keep both visible in explicitly labelled, separate panels.
    const groups=mixed?[all.filter(a=>a.geoPts),all.filter(a=>!a.geoPts)]:[all];
    const shapes=[],panels=[];
    groups.forEach((group,groupIndex)=>{
      const useGeo=!!group[0].geoPts,panelWidth=width/groups.length,left=groupIndex*panelWidth;
      const anchor=useGeo?group[0].geoPts[0].lng:0;
      const raw=group.map(a=>useGeo?a.geoPts.map(p=>world(p,anchor)):a.pixelPts);
      const flat=raw.flat();
      const bounds=flat.reduce((b,p)=>({minX:Math.min(b.minX,p.x),maxX:Math.max(b.maxX,p.x),minY:Math.min(b.minY,p.y),maxY:Math.max(b.maxY,p.y)}),{minX:Infinity,maxX:-Infinity,minY:Infinity,maxY:-Infinity});
      const {minX,maxX,minY,maxY}=bounds;
      const factor=Math.min((panelWidth-48)/Math.max(maxX-minX,1e-10),(mapHeight-64)/Math.max(maxY-minY,1e-10));
      group.forEach((a,i)=>shapes.push({...a,tag:(all.indexOf(a)+1).toString(36).toUpperCase(),points:raw[i].map(p=>({x:left+panelWidth/2+(p.x-(minX+maxX)/2)*factor,y:mapHeight/2+(p.y-(minY+maxY)/2)*factor}))}));
      if(mixed)panels.push({x:left+12,label:useGeo?'Geographic outlines':'Unanchored sketch'});
    });
    shapes.sort((a,b)=>parseInt(a.tag,36)-parseInt(b.tag,36));
    return {width,height:fullHeight,mapHeight,scale,shapes,geo,panels};
  }

  function svgFor(plan) {
    if (!plan) return null;
    const {width,height,mapHeight,shapes} = plan;
    const geometry = shapes.map(a => {
      const pts = a.points.map(p => p.x.toFixed(2)+','+p.y.toFixed(2)).join(' ');
      const center = a.points.reduce((c,p) => ({x:c.x+p.x/a.points.length,y:c.y+p.y/a.points.length}),{x:0,y:0});
      return `<${a.closed?'polygon':'polyline'} points="${pts}" fill="${a.closed?a.color+'33':'none'}" stroke="${a.color}" stroke-width="3" stroke-linejoin="round"/><text x="${center.x.toFixed(2)}" y="${center.y.toFixed(2)}" text-anchor="middle" fill="#172b3a" stroke="#fff" stroke-width="4" paint-order="stroke">${a.tag}</text>`;
    }).join('');
    const panels=(plan.panels||[]).map(p=>`<text x="${p.x}" y="18" fill="#52616c">${p.label}</text>`).join('');
    const legend = shapes.map((a,i) => `<text x="18" y="${mapHeight+47+i*22}" fill="${a.color}">${esc(a.tag+' · '+a.label+' · '+a.measurement)}</text>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fff"/><g font-family="Arial,sans-serif" font-size="13">${geometry}${panels}<text x="18" y="${mapHeight+20}" fill="#52616c">Measured outline — not aerial imagery</text>${legend}</g></svg>`;
  }
  function buildSvg(input, opts) { return svgFor(layout(input,opts)); }
  function buildSvgUrl(input, opts) { const svg = buildSvg(input,opts); return svg ? 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg) : null; }
  async function loadImage(blob, timeoutMs) {
    const url = URL.createObjectURL(blob);
    try {
      return await new Promise((resolve,reject) => {
        const image = new Image(), timer = setTimeout(() => { image.src=''; reject(Error('Image timeout')); },timeoutMs);
        image.onload = () => { clearTimeout(timer); resolve(image); };
        image.onerror = () => { clearTimeout(timer); reject(Error('Image unavailable')); };
        image.src = url;
      });
    } finally { URL.revokeObjectURL(url); }
  }
  async function buildSnapshot(input, mapsKey, opts = {}) {
    const plan = layout(input,opts);
    if (!plan) return null;
    // Keep unanchored sketches separate; they must not suppress real imagery
    // for the measured shapes that do have geographic coordinates.
    if (!plan.geo && plan.shapes.some(a=>a.geoPts)) {
      const valid=getAreas(input), normalized=a=>({service:a.service,size:number(a.measurement.split(' ')[0]),geoPts:a.geoPts,points:a.pixelPts});
      const parts=await Promise.all([true,false].map(geo=>buildSnapshot(valid.filter(a=>!!a.geoPts===geo).map(normalized),mapsKey,opts)));
      const canvas=document.createElement('canvas');canvas.width=plan.width*plan.scale;canvas.height=parts.reduce((h,p)=>h+p.height,0)*plan.scale;
      const ctx=canvas.getContext('2d');ctx.scale(plan.scale,plan.scale);
      let y=0;
      for(const part of parts){const image=new Image();image.src=part.dataUrl;await image.decode();ctx.drawImage(image,0,y,part.width,part.height);y+=part.height;}
      const hasImagery=parts.some(p=>p.hasImagery);
      return {dataUrl:canvas.toDataURL(hasImagery?'image/jpeg':'image/png',.82),width:plan.width,height:y,hasImagery,areaCount:valid.length};
    }
    const canvas = document.createElement('canvas'); canvas.width=plan.width*plan.scale; canvas.height=plan.height*plan.scale;
    const ctx = canvas.getContext('2d'); if (!ctx) throw Error('Snapshot canvas unavailable');
    ctx.scale(plan.scale,plan.scale); ctx.fillStyle='#fff'; ctx.fillRect(0,0,plan.width,plan.height);
    const timeoutMs = Math.max(100,Math.min(10000,Number(opts.timeoutMs)||5000));
    let hasImagery=false;
    const url = plan.geo && plan.shapes.length <= 35 && buildUrl(input,mapsKey,{...opts,size:plan.width+'x'+plan.mapHeight,labels:true});
    if (url) {
      const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),timeoutMs);
      try {
        const response=await (opts.fetchImpl || global.fetch.bind(global))(url,{signal:controller.signal,credentials:'omit',referrerPolicy:'strict-origin-when-cross-origin'});
        if (!response.ok) throw Error('Map unavailable');
        const blob=await response.blob();
        if (!/^image\/(png|jpeg|webp)$/i.test(blob.type) || blob.size>16*1024*1024) throw Error('Map image unavailable');
        const image=await loadImage(blob,timeoutMs);
        // Preserve the complete Google image, including attribution; legend
        // sits below it, rather than covering or cropping the provider logo.
        ctx.drawImage(image,0,0,plan.width,plan.mapHeight); hasImagery=true;
      } catch { /* Local measured geometry remains available offline. */ }
      finally { clearTimeout(timer); }
    }
    if (!hasImagery) {
      const image=await loadImage(new Blob([svgFor(plan)],{type:'image/svg+xml'}),timeoutMs);
      ctx.drawImage(image,0,0,plan.width,plan.height);
    } else {
      ctx.font='13px Arial'; ctx.fillStyle='#52616c'; ctx.fillText('Satellite imagery — measured property areas',18,plan.mapHeight+20);
      plan.shapes.forEach((a,i)=>{ctx.fillStyle=a.color;ctx.fillText(a.tag+' · '+a.label+' · '+a.measurement,18,plan.mapHeight+47+i*22);});
    }
    return { dataUrl:canvas.toDataURL(hasImagery?'image/jpeg':'image/png',.82), width:plan.width, height:plan.height, hasImagery, areaCount:plan.shapes.length };
  }
  global.TK_MAP_SNAPSHOT = {buildUrl, getAreas, buildSvg, buildSvgUrl, buildSnapshot};
})(typeof window !== 'undefined' ? window : globalThis);
