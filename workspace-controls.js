/* Accessible single-select pickers. Native controls remain the form/data source. */
(function(root){
  'use strict';
  const instances=new Map();let active=null,serial=0;
  const normalize=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const visible=el=>!!el.getClientRects().length&&!el.closest('[hidden]');
  const make=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!=null)el.textContent=text;return el;};
  function labelFor(select){
    if(select.getAttribute('aria-label'))return select.getAttribute('aria-label');
    const label=select.labels?.[0];
    if(label){const copy=label.cloneNode(true);copy.querySelectorAll('select,input,button,.ux-select').forEach(el=>el.remove());if(copy.textContent.trim())return copy.textContent.trim();}
    return select.title||'Choose an option';
  }
  function enhance(select){
    if(instances.has(select)||select.multiple||select.size>1||select.dataset.nativeControl!=null)return;
    const wrapper=make('span','ux-select'),trigger=make('button','ux-select-trigger');
    const label=labelFor(select),id='ux-options-'+(++serial),nativeTabindex=select.getAttribute('tabindex');
    trigger.type='button';trigger.setAttribute('role','combobox');trigger.setAttribute('aria-haspopup','listbox');trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-controls',id);
    select.before(wrapper);wrapper.append(select,trigger);select.classList.add('ux-native-select');select.tabIndex=-1;select.setAttribute('aria-hidden','true');
    const instance={select,wrapper,trigger,label,id,nativeTabindex,sync(){
      trigger.textContent=select.selectedOptions[0]?.textContent||'Choose…';
      trigger.disabled=select.disabled;trigger.setAttribute('aria-label',label+': '+trigger.textContent);
      trigger.setAttribute('aria-required',String(select.required));
      trigger.setAttribute('aria-invalid',String(select.getAttribute('aria-invalid')==='true'));
      wrapper.classList.toggle('ux-select-disabled',select.disabled);
    }};
    instances.set(select,instance);instance.sync();
    select.addEventListener('change',instance.sync);select.addEventListener('focus',()=>trigger.focus());
    select.addEventListener('invalid',()=>{trigger.setAttribute('aria-invalid','true');trigger.focus();});
    trigger.addEventListener('click',()=>active?.instance===instance?close():open(instance));
    trigger.addEventListener('keydown',event=>{
      if(['ArrowDown','ArrowUp','Enter',' '].includes(event.key)){event.preventDefault();open(instance);}
    });
  }
  function position(){
    if(!active)return;const {instance,panel,topLayer}=active,rect=instance.trigger.getBoundingClientRect();
    if(!instance.select.isConnected||!visible(instance.trigger)){close(false);return;}
    const viewport=root.visualViewport,viewTop=viewport?.offsetTop||0,viewLeft=viewport?.offsetLeft||0;
    const width=viewport?.width||innerWidth,height=viewport?.height||innerHeight;
    const maxHeight=Math.min(340,height-24),preferred=Math.min(Math.max(rect.width,240),width-24);
    let left=Math.max(viewLeft+12,Math.min(rect.left,viewLeft+width-preferred-12));
    let top=rect.bottom+6;
    if(top+Math.min(panel.scrollHeight,maxHeight)>viewTop+height-12)top=Math.max(viewTop+12,rect.top-Math.min(panel.scrollHeight,maxHeight)-6);
    if(!topLayer&&panel.parentElement.tagName==='DIALOG'){
      const parent=panel.parentElement.getBoundingClientRect();left-=parent.left;top-=parent.top;
    }
    Object.assign(panel.style,{left:left+'px',top:top+'px',width:preferred+'px',maxHeight:maxHeight+'px'});
  }
  function open(instance){
    close(false);if(instance.select.disabled||!visible(instance.trigger))return;
    const panel=make('div','ux-select-panel'),search=make('input','ux-select-search'),list=make('div','ux-select-options');
    search.type='search';search.placeholder='Search options…';search.autocomplete='off';search.setAttribute('aria-label','Search '+instance.label.toLowerCase());search.setAttribute('role','combobox');search.setAttribute('aria-expanded','true');search.setAttribute('aria-controls',instance.id);
    list.id=instance.id;list.setAttribute('role','listbox');list.setAttribute('aria-label',instance.label);
    panel.append(search,list);const dialog=instance.trigger.closest('dialog[open]');(dialog||document.body).append(panel);
    let topLayer=false;
    if(typeof panel.showPopover==='function'){panel.setAttribute('popover','manual');panel.showPopover();topLayer=true;}
    active={instance,panel,search,list,topLayer,options:[],index:0};
    instance.trigger.setAttribute('aria-expanded','true');instance.wrapper.classList.add('ux-select-open');
    function draw(){
      if(active?.instance!==instance)return;const query=normalize(search.value);
      const options=[...instance.select.options].filter(option=>!option.hidden&&(!query||normalize(option.textContent).includes(query)));
      active.options=options;active.index=Math.max(0,options.findIndex(option=>option.selected&&!option.disabled));
      list.replaceChildren();let group=null;
      for(const option of options){
        const groupName=option.parentElement.tagName==='OPTGROUP'?option.parentElement.label:null;
        if(groupName&&groupName!==group)list.append(make('div','ux-select-group',groupName));group=groupName;
        const item=make('div','ux-select-option'),text=make('span','',option.textContent),check=make('span','ux-select-check',option.selected?'✓':'');
        const disabled=option.disabled||option.parentElement.disabled;
        item.id=instance.id+'-'+options.indexOf(option);item.setAttribute('role','option');item.setAttribute('aria-selected',String(option.selected));item.setAttribute('aria-disabled',String(!!disabled));
        item.append(text,check);item.addEventListener('pointerdown',event=>event.preventDefault());
        item.addEventListener('click',()=>{if(!disabled)choose(option);});list.append(item);
      }
      if(!options.length)list.append(make('p','ux-select-empty','No matching options. Try another search.'));
      highlight();position();
    }
    function highlight(){
      if(active?.instance!==instance)return;
      const items=[...list.querySelectorAll('[role=option]')];
      items.forEach((item,index)=>item.classList.toggle('ux-option-focus',index===active.index));
      const selected=items[active.index];if(selected){search.setAttribute('aria-activedescendant',selected.id);selected.scrollIntoView({block:'nearest'});}else search.removeAttribute('aria-activedescendant');
    }
    function choose(option){
      if(!active||active.instance!==instance||!instance.select.isConnected)return;
      instance.select.value=option.value;instance.sync();close();
      instance.select.dispatchEvent(new Event('input',{bubbles:true}));instance.select.dispatchEvent(new Event('change',{bubbles:true}));
    }
    search.addEventListener('input',draw);
    panel.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}
      if(event.key==='Tab'){
        const scope=instance.trigger.closest('dialog,.modal')||document;
        const controls=[...scope.querySelectorAll('button,input,textarea,a[href],[tabindex="0"]')].filter(el=>visible(el)&&!el.disabled&&!panel.contains(el)&&!el.classList.contains('ux-native-select'));
        const index=controls.indexOf(instance.trigger),next=controls[index+(event.shiftKey?-1:1)];
        close(false);if(next){event.preventDefault();next.focus();}return;
      }
      if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
        event.preventDefault();const n=active.options.length;if(!n)return;
        const step=event.key==='ArrowUp'?-1:1;
        let index=event.key==='Home'?0:event.key==='End'?n-1:(active.index+step+n)%n;
        for(let count=0;count<n;count++){
          const option=active.options[index];if(!option.disabled&&!option.parentElement.disabled)break;
          index=(index+step+n)%n;
        }
        active.index=index;highlight();
      }
      if(event.key==='Enter'){
        event.preventDefault();const option=active.options[active.index];if(option&&!option.disabled&&!option.parentElement.disabled)choose(option);
      }
    });
    draw();search.focus({preventScroll:true});position();
  }
  function close(restore=true){
    if(!active)return;const {instance,panel}=active;active=null;
    if(typeof panel.hidePopover==='function'&&panel.matches(':popover-open'))panel.hidePopover();panel.remove();
    instance.trigger.setAttribute('aria-expanded','false');instance.wrapper.classList.remove('ux-select-open');
    if(restore&&instance.trigger.isConnected)instance.trigger.focus({preventScroll:true});
  }
  function scan(node){
    if(node.nodeType!==1)return;
    if(node.matches('select'))enhance(node);node.querySelectorAll('select').forEach(enhance);
  }
  document.addEventListener('pointerdown',event=>{if(active&&!active.panel.contains(event.target)&&!active.instance.wrapper.contains(event.target))close(false);},true);
  document.addEventListener('reset',event=>setTimeout(()=>event.target.querySelectorAll('select').forEach(select=>instances.get(select)?.sync()),0));
  document.addEventListener('scroll',position,true);root.addEventListener('resize',position);root.visualViewport?.addEventListener('resize',position);
  const observer=new MutationObserver(changes=>{
    for(const change of changes){
      if(change.type==='childList')change.addedNodes.forEach(scan);
      const select=change.target.matches?.('select')?change.target:change.target.closest?.('select');
      if(select)instances.get(select)?.sync();
    }
    for(const [select,instance] of instances){
      if(!select.isConnected){if(active?.instance===instance)close(false);instances.delete(select);}
    }
  });
  observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['selected','disabled','required','label','value']});
  scan(document.body);
  root.TK_UI={close,refresh(){scan(document.body);instances.forEach(instance=>instance.sync());}};
})(window);
