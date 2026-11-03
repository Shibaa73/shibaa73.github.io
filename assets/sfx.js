/* Shared sound effects (synthesised with WebAudio, no files).  window.SFX.play('click'|'hover'|'tick'|'ok'|'good'|'miss'|'boom'|'pass'|'win'|'pop'|'hint'|'start'|'join'|'submit')
   Volume follows the site volume menu (SITE.sfxLevel). Buttons, cards and links get click/hover sounds automatically;
   give an element data-sfx="off" to silence it, or data-sfx="name" to play another sound. */
(()=>{
if(window.SFX)return;
let ctx=null,master=null;
const level=()=>{try{const s=window.SITE||(window.parent&&window.parent.SITE);if(s&&s.sfxLevel)return Math.max(0,Math.min(1,s.sfxLevel()))}catch(e){}return 1};
const get=()=>{if(!ctx){const C=window.AudioContext||window.webkitAudioContext;if(!C)return null;try{ctx=new C();master=ctx.createGain();master.connect(ctx.destination)}catch(e){return null}}
  if(ctx.state==='suspended')ctx.resume().catch(()=>{});return ctx};
// one note: frequency (optionally gliding to f2), start offset, length, type, peak volume
const tone=(f,t0,len,type,v,f2)=>{const c=ctx,o=c.createOscillator(),g=c.createGain(),t=c.currentTime+t0;o.type=type||'sine';o.frequency.setValueAtTime(f,t);if(f2)o.frequency.exponentialRampToValueAtTime(f2,t+len);
  g.gain.setValueAtTime(0.0001,t);g.gain.exponentialRampToValueAtTime(Math.max(.0002,v),t+.012);g.gain.exponentialRampToValueAtTime(.0001,t+len);o.connect(g);g.connect(master);o.start(t);o.stop(t+len+.03)};
const noise=(t0,len,v,hp)=>{const c=ctx,n=Math.floor(c.sampleRate*len),b=c.createBuffer(1,n,c.sampleRate),d=b.getChannelData(0);for(let i=0;i<n;i++)d[i]=(Math.random()*2-1)*(1-i/n);
  const s=c.createBufferSource(),g=c.createGain(),f=c.createBiquadFilter();s.buffer=b;f.type='lowpass';f.frequency.value=hp||900;g.gain.value=v;s.connect(f);f.connect(g);g.connect(master);s.start(c.currentTime+t0)};
const S={
  click:()=>tone(520,0,.07,'triangle',.16,380),
  hover:()=>tone(900,0,.04,'sine',.035),
  pop:()=>{tone(420,0,.09,'sine',.18,760)},
  tick:()=>tone(1100,0,.05,'square',.05),
  submit:()=>{tone(440,0,.08,'triangle',.18);tone(660,.07,.12,'triangle',.18)},
  start:()=>{[392,523,659].forEach((f,i)=>tone(f,i*.08,.16,'triangle',.17))},
  join:()=>{tone(600,0,.07,'sine',.14);tone(820,.07,.1,'sine',.14)},
  hint:()=>{tone(700,0,.1,'sine',.15,1100);tone(1100,.1,.14,'sine',.12)},
  good:()=>{[523,659,784,1046].forEach((f,i)=>tone(f,i*.07,.2,'triangle',.18))},          // full points
  ok:()=>{tone(523,0,.12,'triangle',.17);tone(698,.09,.18,'triangle',.17)},                 // some points
  miss:()=>{tone(300,0,.22,'sawtooth',.1,150)},
  pass:()=>{tone(300,0,.08,'square',.07,620);tone(620,.08,.08,'square',.06)},               // the bomb moves on
  boom:()=>{noise(0,.7,.5,700);tone(120,0,.5,'sawtooth',.22,38)},
  dive:()=>{noise(0,.55,.2,500);tone(420,0,.55,'sine',.12,110)},
  layer:o=>{const i=(o&&o.i)||0,f=300*Math.pow(1.26,i);tone(f,0,.5,'sine',.2);tone(f*2,.06,.35,'sine',.08);tone(70+i*12,0,.3,'sine',.25,45)},   // a sonar ping per layer, deeper = higher
  rumble:()=>{noise(0,1.1,.28,260);tone(48,0,1.1,'sawtooth',.14,36)},
  wysi:()=>{[0,.11,.22].forEach(t=>tone(727,t,.07,'square',.09));noise(.05,.3,.18,3000);tone(90,0,.5,'sawtooth',.14,40)},
  ozillion:()=>{[523,659,784,1046,1318,1568].forEach((f,i)=>tone(f,i*.05,1.1,'triangle',.13));[2093,2637,3136].forEach((f,i)=>tone(f,.3+i*.09,.4,'sine',.07));noise(0,.4,.25,2500)},
  win:()=>{[523,659,784,1046,1318].forEach((f,i)=>tone(f,i*.09,.34,'triangle',.18));tone(1568,.5,.5,'sine',.12)}
};
let last=0;
const play=(name,opt)=>{const lv=level();if(lv<=0||!S[name])return;const c=get();if(!c)return;
  const now=performance.now();if(name==='hover'&&now-last<70)return;if(name==='hover')last=now;
  master.gain.value=lv*lv*(name==='hover'?1:1);try{S[name](opt)}catch(e){}};
window.SFX={play,unlock:get};
// wake the audio engine on the first touch/click (browsers need a gesture)
['pointerdown','keydown','touchstart'].forEach(ev=>addEventListener(ev,()=>get(),{once:true,passive:true}));
const SEL='button,.btn,.mode,a.home-btn,select,.chip,.card,[role=button],summary,input[type=checkbox],input[type=range]';
const pick=e=>{const t=e.target&&e.target.closest&&e.target.closest(SEL);if(!t||t.disabled)return null;const a=t.getAttribute('data-sfx');return a==='off'?null:{t,a}};
document.addEventListener('pointerdown',e=>{const p=pick(e);if(!p||p.t.matches('input[type=range]'))return;play(p.a||'click')},true);
let hov=null;document.addEventListener('pointerover',e=>{if(e.pointerType==='touch')return;const p=pick(e);if(!p||p.t===hov)return;hov=p.t;if(!p.t.matches('input,select'))play('hover')},true);
document.addEventListener('pointerout',e=>{if(hov&&!hov.contains(e.relatedTarget))hov=null},true);
})();
