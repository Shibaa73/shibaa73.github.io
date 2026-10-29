/* Shared page polish: drifting circles behind the page, a hit-circle in the title of osu pages (<body data-osu>), ripples on buttons and cards. */
(()=>{
const RM=matchMedia('(prefers-reduced-motion: reduce)').matches;
if(!document.querySelector('.ambient')){const a=document.createElement('div');a.className='ambient';a.setAttribute('aria-hidden','true');a.innerHTML='<i></i><i></i><i></i>';document.body.prepend(a)}
const h=document.querySelector('header h1');
if(h&&document.body.hasAttribute('data-osu')&&!h.querySelector('.logo')){const l=document.createElement('span');l.className='logo';l.setAttribute('aria-hidden','true');h.prepend(l)}
const SEL='button.primary,button.secondary,.dlgbtns button,.tabs button,.seg button,.btn,a.card,.play';
document.addEventListener('pointerdown',e=>{if(RM)return;const b=e.target.closest&&e.target.closest(SEL);if(!b||b.disabled)return;
  if(getComputedStyle(b).position==='static')b.style.position='relative';b.style.overflow='hidden';
  const r=b.getBoundingClientRect(),s=Math.max(r.width,r.height)*2,i=document.createElement('i');i.className='rp';
  i.style.cssText='width:'+s+'px;height:'+s+'px;left:'+(e.clientX-r.left-s/2)+'px;top:'+(e.clientY-r.top-s/2)+'px';b.append(i);setTimeout(()=>i.remove(),650)});
})();
