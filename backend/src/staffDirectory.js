// Display identities only. Keep every underlying booking/account ID as an alias.
const clean = value => String(value || '').trim();
const key = value => clean(value).toLowerCase().replace(/\s+/g, ' ');
const email = value => key(value);
export function humanStaff(row) {
  const name=clean(row.name);
  return row.active !== 0 && row.active !== '0' && row.active !== false && row.hideFromSchedule !== 1 && row.hideFromSchedule !== '1' && row.hideFromSchedule !== true &&
    !(/\bapi\s*key\b|\bintegration\b/i.test(name) || /^(zapier|make|apingo\s*\.?|my custom calendar|test test)$/i.test(name));
}
export function staffDirectory(localRows=[],remoteRows=[]) {
  const remote=remoteRows.filter(humanStaff), used=new Set(), result=[];
  const matching=(local)=>{
    const byEmail=local.email?remote.filter(r=>email(r.email)===email(local.email)):[];
    if(byEmail.length===1)return byEmail[0];
    const byName=local.name&&!local.name.includes('@')?remote.filter(r=>key(r.name)===key(local.name)):[];
    return byName.length===1?byName[0]:null;
  };
  for(const local of localRows.filter(humanStaff)){
    const match=matching(local);
    if(match&&used.has(match.id))continue;
    if(!match&&remote.length&&(!local.name||local.name.includes('@')))continue;
    const name=clean(match?.name)||clean(local.name)||clean(local.email).split('@')[0].replace(/[._-]+/g,' ');
    if(!name)continue;
    if(match)used.add(match.id);
    result.push({...local,name,aliases:[...new Set([local.id,...(local.aliases||[]),...(match?[match.id]:[])])],...(match?{serviceM8Id:match.id}: {})});
  }
  for(const row of remote){
    if(used.has(row.id)||!row.name||row.name.includes('@'))continue;
    used.add(row.id);result.push({...row,aliases:[row.id,...(row.aliases||[])]});
  }
  return result.sort((a,b)=>a.name.localeCompare(b.name));
}
export function mappedStaff(rows,generation){return rows.filter(row=>row.connection_generation===generation).map(row=>({
 id:'servicem8:'+row.external_uuid,name:clean(row.snapshot?.name).slice(0,160),email:clean(row.snapshot?.email).slice(0,254),
 active:row.snapshot?.active,hideFromSchedule:row.snapshot?.hideFromSchedule,role:'servicem8',source:'servicem8',readOnly:true,
}));}
