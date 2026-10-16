/* Mount after index.html's application script. No dependencies or network side effects. */
(function (root) {
  'use strict';
  const norm = s => String(s || '').replace(/^\uFEFF/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const aliases = {
    'Name':['company name','client name','customer name','company','name'],
    'Company':['company','company name','client name','customer name','client'],
    'Company Address':['company address','client address','address','street address'],
    'Email Address':['email address','email','company email','job email address'],
    'Telephone Number':['telephone number','phone','phone number','telephone','job telephone number'],
    'Mobile Number':['mobile number','mobile','job contact mobile number','job mobile number'],
    'Job Number':['job number','job no','job id','generated_job_id'],
    'Job Status':['job status','status'],
    'Job Address':['job address','site address','job_address'],
    'Description of work':['description of work','job description','job_description'],
    'Total Invoice Amount':['total invoice amount','invoice total','total_invoice_amount'],
    'Invoice No':['invoice no','invoice number'],
    'Payment Received':['payment received','paid','payment_received'],
    'Invoice Sent':['invoice sent','invoice_sent'],
    'Item Number':['item number','item code','code','item_number'],
    'Item Name':['item name','material name','name'],
    'Price':['price','sell price','sale price','unit price']
  };
  for (const key of ['Billing Address','Billing Email Address','Billing Telephone Number','Billing Mobile Number','Contact First','Contact Last','Payment Terms','Tax Rate','Badges','Payment Amount','Payment Received Date','Quote Date','Work Order Date','Completion Date','Job Category','Work Completed','PO Number']) aliases[key]=[key];
  aliases['Billing Mobile Number'].push('Billing Contact Mobile Number');
  const canonical = s => Object.keys(aliases).find(k => norm(k) === norm(s)) || s;
  function decode(input) {
    if (typeof input === 'string') return input.replace(/^\uFEFF/, '');
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (b[0] === 0x50 && b[1] === 0x4b) throw Error('Excel workbook detected. Save the Items worksheet as CSV first.');
    const encoding = b[0]===255 && b[1]===254 ? 'utf-16le' : b[0]===254 && b[1]===255 ? 'utf-16be' : 'utf-8';
    try { return new TextDecoder(encoding, {fatal:true}).decode(b).replace(/^\uFEFF/, ''); }
    catch { throw Error('Unsupported text encoding. Save this file as UTF-8 CSV.'); }
  }
  function parse(input) {
    let text = decode(input).replace(/\r\n?/g,'\n');
    let delimiter = ',', rows=[], row=[], value='', quoted=false;
    if (/^sep=[,;\t]\n/i.test(text)) {delimiter=text[4];text=text.slice(6);}
    else if (!text.split('\n')[0].includes(',') && text.split('\n')[0].includes('\t')) delimiter='\t';
    for(let i=0;i<text.length;i++) {
      const c=text[i];
      if(c==='"') {if(quoted && text[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}
      else if(!quoted && (c===delimiter || c==='\n')) {row.push(value);value='';if(c==='\n'){rows.push(row);row=[];}}
      else value+=c;
    }
    if(quoted) throw Error('Unclosed quoted CSV field.');
    if(value || row.length){row.push(value);rows.push(row);}
    rows=rows.filter(r=>r.some(v=>v.trim()));
    const sourceHeaders=(rows.shift()||[]).map(v=>v.trim());
    // Native reports contain unnamed leading/trailing columns. Keep every cell
    // and give duplicate/unnamed columns stable unique keys instead of shifting data.
    const used=new Set(sourceHeaders.filter(Boolean).map(norm));
    const seen=new Set();
    const columns=sourceHeaders.map((name,index)=>{
      let key=name;
      if(!key || seen.has(norm(key))) {
        key=(name || 'Unnamed')+' [column '+(index+1)+']';
        while(used.has(norm(key))) key+=' copy';
      }
      used.add(norm(key));seen.add(norm(name));
      return {name,key,index};
    });
    const headers=columns.map(c=>c.key);
    rows=rows.map(r=>{
      // Accept omitted empty tail cells and extra empty trailing delimiters only.
      // Never trim an unnamed column containing data or pad a missing named field.
      if(r.length>headers.length && r.slice(headers.length).some(v=>v.trim()))
        throw Error('CSV row has data beyond its headers. Check delimiters and quoted commas.');
      if(r.length<headers.length && sourceHeaders.slice(r.length).some(Boolean))
        throw Error('CSV row is missing a named field. Check delimiters and quoted commas.');
      return headers.map((_,i)=>r[i]??'');
    });
    return {headers,rows,columns};
  }
  function mapping(headers, overrides={}) {
    const out=Object.create(null);
    for(const [key, names] of Object.entries(aliases)) {
      const explicit=overrides[key];
      out[key]=explicit ? headers.find(h=>h===explicit) : names.map(n=>headers.find(h=>norm(n)===norm(h))).find(Boolean);
      if(explicit && !out[key]) throw Error('Mapped column not found: '+explicit);
    }
    for(const h of headers) if(!out[canonical(h)]) out[canonical(h)]=h;
    return out;
  }
  function objects(file) {
    if(!file) return [];
    const map=mapping(file.headers,file.mapping);
    return file.rows.map(r=>Object.fromEntries(Object.entries(map).filter(([,h])=>h).map(([k,h])=>{
      const matched=file.columns?.find(c=>c.key===h);
      const duplicates=matched?.name && matched.key===matched.name && !file.mapping?.[k]
        ? file.columns.filter(c=>norm(c.name)===norm(matched.name)) : [];
      // A mapping for a shared source header also resolves its alias views
      // (e.g. Name and Item Name), without changing preserved raw columns.
      const shared=duplicates.length ? [...new Set(Object.values(file.mapping||{}))]
        .map(key=>file.columns.find(c=>c.key===key))
        .filter(c=>c && norm(c.name)===norm(matched.name)) : [];
      const values=shared.length===1 ? [String(r[shared[0].index]??'').trim()]
        : duplicates.length ? duplicates.map(c=>String(r[c.index]??'').trim()).filter(Boolean)
        : [String(r[file.headers.indexOf(h)]??'').trim()];
      if(new Set(values).size>1) throw Error('Conflicting duplicate header: '+matched.name+'. Choose an explicit column mapping.');
      const fallback=!file.mapping?.[k] && !values[0] ? (aliases[k]||[]).map(alias=>{
        const index=file.headers.findIndex(header=>norm(header)===norm(alias));
        return index<0?'':String(r[index]??'').trim();
      }).find(Boolean) : '';
      return [k,values[0]||fallback||''];
    })));
  }
  function detect(headers) {
    const m=mapping(headers);
    if(m['Job Number'] && m['Job Status']) return 'jobs';
    if(m['Item Number'] && m.Price) return 'items';
    if((m.Name || m['Contact First']) && (m['Company Address'] || m['Email Address'] || m['Telephone Number'] || m['Mobile Number'])) return 'clients';
    return null;
  }
  function money(v) {
    if(v==null || String(v).trim()==='') return 0;
    const raw=String(v).trim().replace(/^(?:NZD|AUD|USD)\s*/i,'').replace(/[$\s]/g,'');
    if(raw.includes(',') && !/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(raw)) throw Error('Unsupported currency grouping: '+v);
    const s=raw.replace(/,/g,'');
    if(!/^-?\d+(?:\.\d+)?$/.test(s)) throw Error('Invalid currency value: '+v);
    return Number(s);
  }
  function date(v) {
    if(!v || /^0000-00-00/.test(v)) return null;
    let m=String(v).match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[ T])/);
    if(!m){const d=String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:$|\s)/);if(d)m=[d[0],d[3],d[2].padStart(2,'0'),d[1].padStart(2,'0')];}
    if(!m) throw Error('Unsupported date (use YYYY-MM-DD or DD/MM/YYYY): '+v);
    const iso=`${m[1]}-${m[2]}-${m[3]}`;
    const stamp=new Date(iso+'T00:00:00Z');
    if(!Number.isFinite(+stamp)||stamp.toISOString().slice(0,10)!==iso) throw Error('Invalid calendar date: '+v);
    return iso;
  }
  const flag=v=>/^(1|true|yes|paid)$/i.test(String(v).trim())?'1':'0';
  function normalizeFile(file) {
    if(!file) return null;
    const rows=objects(file).map(r=>{
      if(!r.Name && r['Contact First']) r.Name=[r['Contact First'],r['Contact Last']].filter(Boolean).join(' ');
      for(const k of Object.keys(r)) {
        if(/Date$/.test(k)) r[k]=date(r[k])||'';
        if(['Total Invoice Amount','Payment Amount'].includes(k)) r[k]=String(money(r[k]));
        if(['Payment Received','Invoice Sent'].includes(k)) r[k]=flag(r[k]);
      }
      return r;
    });
    const headers=[...new Set(rows.flatMap(Object.keys))];
    return {name:file.name,headers,rows:rows.map(r=>headers.map(h=>r[h]||''))};
  }
  function payload(result) {
    return {p_source:'servicem8',p_customers:result.customers||[],p_jobs:result.jobs||[],p_quotes:[],p_invoices:result.invoices||[]};
  }
  function items(file) {
    return objects(file).map(r=>({item_number:r['Item Number'],name:r['Item Name'],price:money(r.Price)}));
  }
  function csv(rows,headers=Object.keys(rows[0]||{})) {
    const cell=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
    return '\uFEFF'+[headers,...rows.map(r=>headers.map(h=>r[h]))].map(r=>r.map(cell).join(',')).join('\r\n');
  }
  const clientExportHeaders=['Name','Company Address','Email Address','Telephone Number','Mobile Number','Billing Address','Billing Email Address','Billing Telephone Number','Billing Mobile Number','Payment Terms','Tax Rate'];
  const jobExportHeaders=['Job Number','Job Status','Company','Job Email Address','Job Telephone Number','Job Address','Scheduled Date','Quoted Total','TurnKey Customer ID','TurnKey Quote ID','Details JSON','Record JSON'];
  function exportClients(customers) {
    return customers.map(c=>({
      'Name':c.name||'', 'Company Address':[c.address,c.suburb].filter(Boolean).join('\n'),
      'Email Address':c.email||'', 'Telephone Number':c.phone||'',
      'Mobile Number':c.details?.mobileNumber||'', 'Billing Address':c.details?.billingAddress||'',
      'Billing Email Address':c.details?.billingEmail||'', 'Billing Telephone Number':c.details?.billingPhone||'',
      'Billing Mobile Number':c.details?.billingMobile||'', 'Payment Terms':c.details?.paymentTerms||'',
      'Tax Rate':c.details?.taxRate||''
    }));
  }
  function exportJobs(jobs,customers) {
    const byId=new Map(customers.map(c=>[String(c.id),c]));
    return jobs.map(j=>{
      const c=byId.get(String(j.customer_id))||{},d=j.details||{};
      return {'Job Number':j.id,'Job Status':j.status,'Company':c.name||d.name||'',
        'Job Email Address':c.email||'', 'Job Telephone Number':c.phone||'',
        'Job Address':d.address||c.address||'', 'Scheduled Date':j.scheduled_date||'',
        'Quoted Total':d.total??'', 'TurnKey Customer ID':j.customer_id||'',
        'TurnKey Quote ID':j.quote_id||'', 'Details JSON':JSON.stringify(d),'Record JSON':JSON.stringify(j)};
    });
  }
  function exportContext() {
    return {db:typeof sb!=='undefined'?sb:null,businessId:typeof currentBusinessId!=='undefined'?currentBusinessId:null};
  }
  async function prepareExport(kind,context=exportContext()) {
    if(!['clients','jobs'].includes(kind)) throw Error('Choose clients or jobs to export.');
    const {db,businessId}=context;
    if(!db || !businessId) throw Error('Sign in to your TurnKey business before exporting.');
    const current=context.isCurrent || (()=>true);
    const read=async table=>{
      const rows=[];
      for(let offset=0;;offset+=1000) {
        if(!current()) throw Error('Your business changed. Reopen the export window.');
        const {data,error}=await db.from(table).select('*').eq('business_id',businessId).order('id').range(offset,offset+999);
        if(error || !Array.isArray(data)) throw Error('Could not read your '+table+'. Retry the export.');
        // Explicit tenant filter plus RLS; never include a mis-scoped response.
        if(data.some(r=>r.business_id!==businessId)) throw Error('Export returned records outside your business.');
        rows.push(...data);
        if(data.length<1000) return rows;
      }
    };
    const customers=await read('customers');
    const records=kind==='clients'?exportClients(customers):exportJobs(await read('jobs'),customers);
    if(!current()) throw Error('Your business changed. Reopen the export window.');
    return {filename:kind==='clients'?'turnkey-servicem8-clients.csv':'turnkey-jobs-archive.csv',
      count:records.length,text:csv(records,kind==='clients'?clientExportHeaders:jobExportHeaders)};
  }
  function openExport() {
    const existing=root.document.getElementById('tk-servicem8-export');
    if(existing) {existing.focus();return existing;}
    const context=exportContext();
    context.isCurrent=()=>{const now=exportContext();return now.businessId===context.businessId && now.db===context.db;};
    const dialog=root.document.createElement('dialog');
    dialog.id='tk-servicem8-export';
    dialog.setAttribute('aria-labelledby','tk-servicem8-export-title');
    dialog.style.cssText='max-width:620px;width:calc(100% - 32px);border:1px solid #ddd;border-radius:16px;padding:24px;color:var(--ink,#222);background:var(--paper,#fff)';
    dialog.innerHTML='<h3 id="tk-servicem8-export-title">Export TurnKey data</h3><p><b>Clients CSV:</b> ServiceM8-supported client import fields. In ServiceM8, open Clients → Bulk Import and review the field mapping against its current template.</p><p><b>Jobs CSV:</b> full TurnKey job archive, including all stored job fields in Record JSON. This is not a native ServiceM8 jobs import file. Separate invoice records and attachments are not included. Use the connected-account handoff for approved jobs.</p><div class="sale-actions"><button type="button" class="btn primary" data-export="clients">Export clients CSV</button><button type="button" class="btn ghost" data-export="jobs">Export jobs CSV</button></div><p role="status" aria-live="polite"></p><button type="button" class="btn ghost" data-export-close>Close</button>';
    const status=dialog.querySelector('[role="status"]');
    const buttons=Array.from(dialog.querySelectorAll('[data-export]'));
    let closed=false;
    for(const button of buttons) button.addEventListener('click',async()=>{
      buttons.forEach(b=>b.disabled=true);status.textContent='Preparing CSV…';
      try {
        const result=await prepareExport(button.dataset.export,context);
        if(closed) return;
        const url=root.URL.createObjectURL(new Blob([result.text],{type:'text/csv;charset=utf-8'}));
        const a=root.document.createElement('a');a.href=url;a.download=result.filename;
        dialog.appendChild(a);a.click();a.remove();
        root.setTimeout(()=>root.URL.revokeObjectURL(url),1000);
        status.textContent=result.count+' '+button.dataset.export+' exported.';
      } catch(e) {if(!closed) status.textContent=e.message;}
      finally {buttons.forEach(b=>b.disabled=false);}
    });
    const close=()=>{closed=true;dialog.close();dialog.remove();};
    dialog.querySelector('[data-export-close]').addEventListener('click',close);
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    root.document.body.appendChild(dialog);dialog.showModal();return dialog;
  }
  const escapeHtml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const api={decode,parse,mapping,objects,detect,money,date,normalizeFile,payload,items,csv,exportClients,exportJobs,prepareExport,openExport};
  if(typeof module==='object' && module.exports) module.exports=api;
  root.TK_SERVICEM8_IMPORT=api;
  // Adapt existing wizard globals without changing its protected source.
  if(typeof root.sm8Process==='function') {
    const upload=root.sm8RenderUpload;
    root.sm8RenderUpload=()=>{
      const html=upload();
      const uploadHtml=importWizard.files.jobs ? html.replace('disabled onclick="sm8Validate()', ' onclick="sm8Validate()') : html;
      return uploadHtml+'<div class="panel"><h4>Export TurnKey data</h4><p>Clients: ServiceM8 client import fields; review mapping in Bulk Import. Jobs: full TurnKey archive CSV, not a ServiceM8 job import file.</p><button type="button" class="btn ghost sm" onclick="TK_SERVICEM8_IMPORT.openExport()">Export clients CSV / Export jobs CSV…</button></div>';

    };
    const process=root.sm8Process;
    root.sm8Process=(customers,jobs)=>{
      const result=process(normalizeFile(customers),normalizeFile(jobs));
      // Job-only imports must retain contact data when reconciliation creates clients.
      const byName=new Map(result.customers.map(c=>[String(c.name).trim().toLowerCase().replace(/\s+/g,' '),c]));
      const customerRefs=new Map(result.jobs.map(j=>[j.ref,j.customer_ref]));
      for(const row of objects(jobs)) {
        const customer=byName.get(String(row.Company||customerRefs.get(row['Job Number'])||'').trim().toLowerCase().replace(/\s+/g,' '));
        if(!customer) continue;
        customer.email ||= row['Email Address']||row['Billing Email Address']||null;
        customer.phone ||= row['Telephone Number']||row['Mobile Number']||row['Billing Telephone Number']||row['Billing Mobile Number']||null;
        if(!customer.address && row['Job Address']) {
          const address=root.sm8ParseAddress(row['Job Address']);
          customer.address=address.address;customer.suburb ||= address.suburb;
        }
      }
      return result;
    };
    root.sm8DetectFileType=detect;
    root.sm8CleanDate=date;
    root.sm8FilesChosen=async function(el) {
      importWizard.sm8UploadWarnings=[];
      for(const file of Array.from(el.files||[])) {
        try {
          if(file.size>25*1024*1024) throw Error('File exceeds 25MB.');
          const parsed=parse(await file.arrayBuffer()),type=detect(parsed.headers);
          if(!parsed.rows.length) throw Error('The CSV has no data rows.');
          if(type==='items') throw Error('Item catalogue recognised. Review with TK_SERVICEM8_IMPORT.items(); run_import has no items parameter.');
          if(!type) throw Error('Unrecognised headers. Supply an explicit column mapping.');
          normalizeFile(parsed); // Reject invalid values before enabling the validation step.
          importWizard.files[type==='clients'?'customers':'jobs']={...parsed,name:escapeHtml(file.name)};
        } catch(e) {importWizard.sm8UploadWarnings.push(escapeHtml(file.name+': '+e.message));}
      }
      renderImportWizard();
    };
  }
})(typeof window==='object'?window:globalThis);
