// TurnKey shared formatting utilities — address display and "submitted at"
// timestamps, used identically by index.html (CRM), quote.html (public
// quote page) and booking.html (public booking widget) so the same record
// never reads differently depending which page rendered it. Loaded
// alongside pricing-engine.js/map-snapshot.js — same plain-<script>,
// no-build-step pattern (see CLAUDE.md).
window.TK_FORMAT = (function(){
  // Every field is optional and gracefully omitted — never a dangling ", "
  // or a lone "—" glued onto a real value. Accepts either a record-shaped
  // object ({address, suburb, ...}) or a plain string.
  function address(input,opts){
    opts=opts||{};
    var addr,suburb;
    if(typeof input==='string'){addr=input;suburb=null;}
    else{addr=input&&input.address;suburb=input&&input.suburb;}
    var parts=[addr,suburb].map(function(s){return (s||'').trim();}).filter(Boolean);
    if(!parts.length)return 'fallback' in opts?opts.fallback:'';
    return parts.join(', ');
  }
  // {date:'Monday 3 August 2026', time:'4:15 PM', full:'Monday 3 August 2026, 4:15 PM'}
  // Reads the Date in the viewer's own local timezone (same as every other
  // timestamp already rendered in this app) — the source value is always a
  // timestamptz/ISO string, which already carries its UTC offset, so no
  // separate stored "timezone" field is needed to reproduce the correct
  // wall-clock moment for whoever is looking at it.
  function submitted(dateInput){
    if(!dateInput)return null;
    var d=dateInput instanceof Date?dateInput:new Date(dateInput);
    if(isNaN(d.getTime()))return null;
    var days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    var months=['January','February','March','April','May','June','July','August','September','October','November','December'];
    var date=days[d.getDay()]+' '+d.getDate()+' '+months[d.getMonth()]+' '+d.getFullYear();
    var h=d.getHours(),m=d.getMinutes();
    var ap=h>=12?'PM':'AM';
    var h12=h%12; if(h12===0)h12=12;
    var time=h12+':'+String(m).padStart(2,'0')+' '+ap;
    return {date:date,time:time,full:date+', '+time};
  }
  return {address:address,submitted:submitted};
})();
