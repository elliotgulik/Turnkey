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
  // Returns a ready-to-fetch Static Maps URL, or null if there's nothing to
  // show at all. Two cases:
  //  1. Mapped outline exists — auto-fit to it (unchanged), plus a marker
  //     pinned at the outline's centroid so the image still answers "which
  //     part of this is my house" at a glance, not just "here's a shape".
  //  2. No outline (older quotes, quick-quote leads that were never drawn
  //     on the map, or ones built on a plain non-geo grid) — opts.fallbackAddress
  //     lets Google geocode+center+pin a plain address string directly, so
  //     these quotes/invoices get a real close-up property photo instead of
  //     no image at all.
  function buildUrl(areaPolys,mapsKey,opts){
    opts=opts||{};
    if(!mapsKey)return null;
    const size=opts.size||'640x400';
    const scale=opts.scale||2;
    const withGeo=(areaPolys||[]).filter(a=>a.geoPts&&a.points&&a.geoPts.length===a.points.length&&a.geoPts.every(Boolean));
    const paths=withGeo.map(pathParam).filter(Boolean);
    if(paths.length){
      let url='https://maps.googleapis.com/maps/api/staticmap?size='+size+'&scale='+scale+'&maptype=satellite';
      paths.forEach(p=>{url+='&path='+encodeURIComponent(p);});
      // No explicit center/zoom — Static Maps auto-fits the viewport to every
      // path point given, which is exactly the "zoom to fit all mapped
      // features" behaviour the property map itself also needs.
      const allPts=withGeo.reduce((s,a)=>s.concat(a.geoPts.filter(Boolean)),[]);
      if(allPts.length){
        const cLat=allPts.reduce((s,p)=>s+p.lat,0)/allPts.length;
        const cLng=allPts.reduce((s,p)=>s+p.lng,0)/allPts.length;
        url+='&markers='+encodeURIComponent('color:red|'+cLat+','+cLng);
      }
      url+='&key='+encodeURIComponent(mapsKey);
      return url;
    }
    if(opts.fallbackAddress){
      // zoom 20: close enough that a typical residential property fills
      // most of the frame, with a small amount of surrounding context —
      // Google geocodes the address string itself, no separate lookup needed.
      const addr=opts.fallbackAddress;
      return 'https://maps.googleapis.com/maps/api/staticmap?size='+size+'&scale='+scale+
        '&maptype=satellite&center='+encodeURIComponent(addr)+'&zoom=20'+
        '&markers='+encodeURIComponent('color:red|'+addr)+
        '&key='+encodeURIComponent(mapsKey);
    }
    return null;
  }
  return {buildUrl};
})();
