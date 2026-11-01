/* Keep modal controls reachable when a phone's software keyboard opens. */
(function(){
 let pending=false;
 function update(){pending=false;const viewport=window.visualViewport,height=viewport?.height||window.innerHeight;document.documentElement.style.setProperty('--tk-visual-height',height+'px');const editing=document.activeElement?.matches('input,textarea,[contenteditable="true"]');document.body.classList.toggle('tk-keyboard-open',!!editing&&window.innerWidth<=760&&window.innerHeight-height>120);}
 function schedule(){if(!pending){pending=true;requestAnimationFrame(update);}}
 window.visualViewport?.addEventListener('resize',schedule,{passive:true});
 window.addEventListener('resize',schedule,{passive:true});
 document.addEventListener('focusin',schedule);document.addEventListener('focusout',schedule);update();
})();
