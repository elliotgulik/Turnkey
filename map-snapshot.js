// TurnKey shared map-snapshot builder — turns a job's saved areaPolys into a
// single flat image URL (Google Static Maps, with each measured shape baked
// directly onto the image via the `path=` parameter) for contexts that need
// a plain image rather than an interactive map: the PDF quote, the doc
// preview, and CRM quote history. Loaded alongside pricing-engine.js (for
// SERVICES.shape/color) by index.html and quote.html.
window.TK_MAP_SNAPSHOT = (function(){
  // Builds one Static Maps `path=` fragment for a single area. Closed
  // shapes (driveway/roof/patio/housewash) repeat their first point at the
  // end so the outline actually closes; open shapes (fence/gutter) don't.
  function pathParam(area){
    const svc=window.TK_PRICING&&TK_PRICING.SERVICES[area.service];
    if(!svc||svc.shape==='none')return null;
    const pts=(area.geoPts||[]).filter(Boolean);
    if(pts.length<2)return null;
    const coords=pts.map(p=>p.lat+','+p.lng);
    if(svc.shape==='closed')coords.push(coords[0]);
    const color=(svc.color||'#138a72').replace('#','0x');
    const fill=svc.shape==='closed'?'|fillcolor:'+color+'33':'';
    return 'color:'+color+'|weight:3'+fill+'|'+coords.join('|');
  }
  // Returns a ready-to-fetch Static Maps URL, or null if there's nothing
  // geo-referenced to draw (older quotes, or ones built on a plain grid) —
  // callers treat null as "no snapshot for this quote", not an error.
  function buildUrl(areaPolys,mapsKey,opts){
    opts=opts||{};
    if(!mapsKey)return null;
    const withGeo=(areaPolys||[]).filter(a=>a.geoPts&&a.points&&a.geoPts.length===a.points.length&&a.geoPts.every(Boolean));
    if(!withGeo.length)return null;
    const paths=withGeo.map(pathParam).filter(Boolean);
    if(!paths.length)return null;
    const size=opts.size||'640x400';
    const scale=opts.scale||2;
    let url='https://maps.googleapis.com/maps/api/staticmap?size='+size+'&scale='+scale+'&maptype=satellite';
    paths.forEach(p=>{url+='&path='+encodeURIComponent(p);});
    // No explicit center/zoom — Static Maps auto-fits the viewport to every
    // path point given, which is exactly the "zoom to fit all mapped
    // features" behaviour the property map itself also needs.
    url+='&key='+encodeURIComponent(mapsKey);
    return url;
  }
  return {buildUrl};
})();
