/* Task navigation and search share the current authenticated workspace; no extra data store. */
(function(root){
  'use strict';
  const main=document.querySelector('.app main');if(!main)return;
  root.TK_SETTINGS_EXPERIENCE?.install();
  const previousMore=root.openMoreSheet;
  root.openMoreSheet=function(){
    const result=previousMore.apply(this,arguments),body=document.getElementById('more-body');
    if(body&&!body.querySelector('[data-ux-work-tools]')){
      const tools=document.createElement('div');tools.dataset.uxWorkTools='';tools.innerHTML='<div class="more-group-label">Work tools</div>';
      for(const [label,icon,run] of [['Work hours','calendar',()=>root.TK_JOB_WORK.openCalendar()],['Equipment & service','jobsflow',()=>root.TK_JOB_WORK.openEquipment()]]){
        const button=document.createElement('button');button.type='button';button.className='more-row';
        button.innerHTML='<span class="nav-ico" aria-hidden="true">'+(typeof NAV_ICONS!=='undefined'?NAV_ICONS[icon]:'')+'</span><span class="mr-label"></span><span class="mr-chev">›</span>';button.querySelector('.mr-label').textContent=label;
        button.addEventListener('click',()=>{closeModal('more-overlay');run();});tools.append(button);
      }
      body.prepend(tools);
    }
    return result;
  };
  const make=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!=null)el.textContent=text;return el;};
  const context=()=>({biz:typeof currentBusinessId!=='undefined'?currentBusinessId:null,user:typeof currentUserId!=='undefined'?currentUserId:null,version:typeof businessSessionVersion!=='undefined'?businessSessionVersion:0,ready:typeof businessStateReady!=='undefined'&&businessStateReady,role:typeof currentUserRole!=='undefined'?currentUserRole:null});
  const same=(a,b)=>a.biz===b.biz&&a.user===b.user&&a.version===b.version&&b.ready;
  const names={dashboard:'Dashboard',leads:'Leads',pipeline:'Pipeline',customers:'Customers',operations:'Jobs & invoices',calendar:'Calendar',inbox:'Conversations',sales:'Analytics',goals:'Goals',pricing:'Pricing & costs',detail:'Customer workspace'};
  const header=make('header','ux-workspace-bar');header.innerHTML='<div class="ux-workspace-location"><span class="ux-workspace-business">Your workspace</span><strong id="ux-current-page">Dashboard</strong></div><div class="ux-workspace-tools"><button type="button" class="ux-search-launch" aria-label="Search your workspace"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><span>Search anything</span><kbd>⌘ K</kbd></button><button type="button" class="btn primary ux-create-launch">＋ Create</button></div>';
  main.prepend(header);
  const dialog=make('dialog','ux-command');dialog.id='workspace-command';dialog.setAttribute('aria-labelledby','ux-command-heading');
  dialog.innerHTML='<div class="ux-command-head"><h2 id="ux-command-heading">Find anything</h2><button type="button" class="x" aria-label="Close search">×</button></div><label class="ux-command-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input type="search" autocomplete="off" placeholder="Search customers, addresses, jobs or pages" aria-label="Search customers and pages"></label><div class="ux-command-results" role="listbox" aria-label="Search results"></div><footer class="ux-command-foot"><span>↑ ↓ to browse · Enter to open</span><span>Esc to close</span></footer>';
  document.body.append(dialog);
  const input=dialog.querySelector('input'),results=dialog.querySelector('[role=listbox]');let scope=null,choices=[],index=0,mode='all',returnFocus=null;
  const manager=c=>['owner','manager'].includes(c.role);
  function close(){if(dialog.open)dialog.close();input.value='';results.replaceChildren();choices=[];scope=null;if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});}
  function actions(c){
    const all=[{label:'Book a job',hint:'Choose customer, crew and time',icon:'calendar',run:()=>openCalendarJobModal(todayISO())},{label:'Compose email',hint:'Conversations',icon:'inbox',run:()=>openComposeModal({})}];
    if(manager(c))all.unshift({label:'New lead',hint:'Capture a customer enquiry',icon:'leads',run:()=>openLeadModal()},{label:'Build a quote',hint:'Choose a customer and open Google Earth',icon:'pricing',run:()=>document.querySelector('[data-sale-action="quote-home"]')?.click()});
    return manager(c)?all:all.filter(a=>a.label==='Compose email');
  }
  function highlight(){
    [...results.querySelectorAll('[role=option]')].forEach((el,i)=>{el.classList.toggle('selected',i===index);el.setAttribute('aria-selected',String(i===index));});
    const row=results.querySelectorAll('[role=option]')[index];if(row){input.setAttribute('aria-activedescendant',row.id);row.scrollIntoView({block:'nearest'});}else input.removeAttribute('aria-activedescendant');
  }
  function select(i){
    const now=context();if(!scope||!same(scope,now)){close();return;}
    const choice=choices[i];if(!choice)return;close();choice.run();
  }
  function draw(){
    results.replaceChildren();choices=[];index=0;const c=context();
    if(!scope||!same(scope,c)){results.append(make('p','ux-search-empty','Sign in and load your business to search.'));return;}
    const q=input.value.trim().toLocaleLowerCase();
    const add=(label,list)=>{
      if(!list.length)return;results.append(make('h3','ux-result-group',label));
      list.forEach(choice=>{
        const i=choices.length;choices.push(choice);const row=make('button','ux-command-result');row.type='button';row.id='ux-result-'+i;row.setAttribute('role','option');row.tabIndex=-1;
        const icon=make('span','ux-result-icon');icon.innerHTML=typeof NAV_ICONS!=='undefined'?NAV_ICONS[choice.icon]||NAV_ICONS.customers:'';
        const text=make('span','ux-result-copy');text.append(make('strong','',choice.label),make('small','',choice.hint));row.append(icon,text,make('span','ux-result-enter','↵'));row.addEventListener('click',()=>select(i));results.append(row);
      });
    };
    const matches=x=>!q||[x.label,x.hint].join(' ').toLocaleLowerCase().includes(q);
    add('Quick actions',actions(c).filter(matches));
    if(mode!=='create'){
      add('Pages',Object.entries(names).filter(([key])=>key!=='detail'&&(manager(c)||['operations','calendar','inbox'].includes(key))).map(([key,label])=>({label,hint:'Go to '+label.toLowerCase(),icon:key==='operations'?'jobsflow':key,run:()=>switchView(key)})).filter(matches));
      const recordsNow=typeof records!=='undefined'?records:[];
      const found=recordsNow.filter(r=>{
        if(typeof recordBusinesses!=='undefined'&&recordBusinesses.get(r)!==c.biz)return false;
        if(!manager(c)&&r.assignedStaffId!==c.user&&!(r.assignedStaffIds||[]).includes(c.user))return false;
        return !q||[r.name,r.address,r.suburb,r.email,r.phone,r.source].join(' ').toLocaleLowerCase().includes(q);
      }).slice(0,q?20:5);
      add(q?'Customers & opportunities':'Recent opportunities',found.map(r=>({label:r.name||'Unnamed customer',hint:[r.address||r.email,root.TK_PIPELINE?.stages.find(s=>s.key===root.TK_PIPELINE.key(r))?.label].filter(Boolean).join(' · '),icon:'customers',run:()=>{
        const current=context();if(!same(c,current))return;
        const live=records.find(x=>x.id===r.id&&x.jobId===r.jobId);if(live&&recordBusinesses.get(live)===c.biz)openDetail(live.id);
      }})));
    }
    if(!choices.length)results.append(make('p','ux-search-empty','No results. Try a customer name, address, email or page name.'));
    highlight();
  }
  function open(which='all'){
    root.TK_UI?.close(false);returnFocus=document.activeElement;mode=which;scope=context();input.value='';
    dialog.querySelector('h2').textContent=which==='create'?'What would you like to create?':'Find anything';
    input.placeholder=which==='create'?'Choose or search an action':'Search customers, addresses, jobs or pages';
    if(!dialog.open)dialog.showModal();draw();input.focus();
  }
  header.querySelector('.ux-search-launch').addEventListener('click',()=>open());header.querySelector('.ux-create-launch').addEventListener('click',()=>open('create'));
  dialog.querySelector('.x').addEventListener('click',close);dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close();}});
  input.addEventListener('input',draw);input.addEventListener('keydown',event=>{
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();if(choices.length){index=event.key==='Home'?0:event.key==='End'?choices.length-1:(index+(event.key==='ArrowUp'?-1:1)+choices.length)%choices.length;highlight();}}
    if(event.key==='Enter'){event.preventDefault();select(index);}
  });
  document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();if(dialog.open)close();else open();}});
  const originalAuth=root.showAuth;root.showAuth=function(){close();root.TK_UI?.close(false);return originalAuth.apply(this,arguments);};
  function updateHeader(){
    const c=context(),view=main.querySelector('.view.active')?.id.replace('view-','')||'dashboard';
    const name=names[view]||'Workspace',business=typeof currentBusinessProfile!=='undefined'&&currentBusinessProfile?.name||'Your workspace';
    const title=header.querySelector('#ux-current-page'),company=header.querySelector('.ux-workspace-business');
    if(title.textContent!==name)title.textContent=name;if(company.textContent!==business)company.textContent=business;
    header.querySelector('.ux-create-launch').hidden=!manager(c);header.querySelector('.ux-search-launch').disabled=!c.ready;
    if(dialog.open&&!same(scope||{},c))close();
  }
  new MutationObserver(updateHeader).observe(document.querySelector('.app'),{subtree:true,attributes:true,attributeFilter:['class','style']});updateHeader();

  // Keep Pricing focused on one task and one service at a time, retaining all existing inputs.
  let pricingTab='rates';const openServiceGroups=new Set();
  function enhancePricing(){
    const view=document.getElementById('view-pricing');if(!view||view.querySelector('.ux-pricing-tabs'))return;
    const groups={rates:[],chemicals:[],delivery:[],services:[],overheads:[],history:[]};
    [...view.children].forEach(el=>{
      if(el.classList.contains('rate-card'))groups.rates.push(el);
      else if(el.classList.contains('panel')){
        const title=el.querySelector('h4')?.textContent||'';
        const key=/Chemical/i.test(title)?'chemicals':/Productivity/i.test(title)?'services':/Labour/i.test(title)?'delivery':/overhead/i.test(title)?'overheads':'history';groups[key].push(el);
      }
    });
    const tabs=make('div','ux-pricing-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Pricing setup');
    const labels={rates:'Service prices',chemicals:'Chemical prices',delivery:'Labour & travel',services:'Service setup',overheads:'Overheads',history:'History'};
    if(!groups[pricingTab]?.length)pricingTab='rates';
    function pick(key){pricingTab=key;for(const [name,els] of Object.entries(groups)){els.forEach(el=>el.hidden=name!==key);const btn=tabs.querySelector('[data-pricing-tab="'+name+'"]');if(btn){btn.classList.toggle('active',name===key);btn.setAttribute('aria-selected',String(name===key));}}}
    for(const [key,els] of Object.entries(groups)){
      if(!els.length)continue;const btn=make('button','',labels[key]);btn.type='button';btn.dataset.pricingTab=key;btn.setAttribute('role','tab');btn.addEventListener('click',()=>pick(key));tabs.append(btn);
    }
    const first=view.querySelector('.rate-card,.panel');if(first)first.before(tabs);
    for(const panel of groups.services){
      let section=null;
      [...panel.children].forEach(row=>{
        if(!row.classList.contains('rate-tier'))return;
        const label=row.querySelector('label');
        if(!label?.querySelector('input[type=checkbox]')){
          const name=label?.textContent||'Service',details=make('details','ux-service-cost'),summary=make('summary','',name);
          details.open=openServiceGroups.has(name);details.append(summary);row.before(details);details.append(row);section=details;
          details.addEventListener('toggle',()=>details.open?openServiceGroups.add(name):openServiceGroups.delete(name));
        }else section?.append(row);
      });
    }
    pick(pricingTab);
  }
  const oldPricing=root.renderPricing;root.renderPricing=function(){const result=oldPricing.apply(this,arguments);enhancePricing();return result;};
  root.TK_WORKSPACE={search:open,closeSearch:close,refresh:updateHeader};
})(window);
