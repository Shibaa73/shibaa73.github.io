/* Shared on every page: background music (random track from a YouTube playlist, loops forever)
   and the volume button/menu (top right). SITE.playSfx(url) plays a sound at the SFX volume. */
(()=>{
// inside the home page's frame the shell (index.html) already owns the music + volume button
try{if(window.parent!==window&&window.parent.SITE&&window.parent.SITE.shell)return}catch(e){}
const PLAYLIST='PLEimrAJXv9ps',VK='site:vol2',IK='site:ids',TK='site:track';
const ls={get(k){try{return JSON.parse(localStorage.getItem(k))}catch(e){return null}},set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}};
// Optional per-song loudness fix: attenuate loud songs, e.g. GAIN={'dQw4w9WgXcQ':0.6}. (Can't be measured automatically from a YouTube embed.)
const GAIN={};
let title='',ducked=false;
const vol=Object.assign({music:.1,sfx:1},ls.get(VK)||{});
window.SITE={shell:true,playSfx(src){const a=new Audio(src);a.volume=vol.sfx;a.play().catch(()=>{});return a}};

SITE.sfxLevel=()=>vol.sfx;                                // apps: current SFX volume (0-1)
SITE.duck=b=>{ducked=b;if(p)p.setVolume(level())};       // apps with their own audio mute the music (no pause/skip)
/* ---------- volume button + menu ---------- */
const st=document.createElement('style');
st.textContent=`#siteVol{position:fixed;top:16px;right:16px;z-index:50;font-family:'Inter',sans-serif}
#siteVol>button{width:38px;height:38px;display:grid;place-items:center;padding:0;background:var(--panel-2,#452c3a);border:1px solid var(--border,rgba(255,220,230,.09));border-radius:10px;color:var(--gold,#d99cae);cursor:pointer;transition:border-color .15s}
#siteVol>button:hover{border-color:var(--gold-dim,#8f5c6b)}
#siteVol button:focus-visible,#siteVol input:focus-visible{outline:2px solid var(--teal,#c98aa0);outline-offset:3px}
#siteVol svg{width:20px;height:20px}
#siteSkip{padding:7px;border-radius:9px;border:1px solid var(--border,rgba(255,220,230,.09));background:var(--panel-2,#452c3a);color:var(--text,#f3e6ea);font:600 .8rem 'Inter',sans-serif;cursor:pointer}
#siteSkip:hover{border-color:var(--gold-dim,#8f5c6b)}
#siteNow{display:grid;gap:2px;font-size:.78rem;color:var(--muted,#a58891)}
#siteNow b{font-weight:500;font-size:.85rem;color:var(--text,#f3e6ea);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#siteMenu{position:absolute;top:46px;right:0;width:260px;padding:16px;display:grid;gap:14px;background:var(--panel,#3a2531);border:1px solid var(--border,rgba(255,220,230,.09));border-radius:14px;box-shadow:0 12px 32px rgba(0,0,0,.35);color:var(--text,#f3e6ea)}
#siteMenu[hidden]{display:none}
#siteMenu label{display:grid;gap:6px;font-size:.82rem;color:var(--muted,#a58891)}
#siteMenu label span{display:flex;justify-content:space-between}
#siteMenu input{width:100%;margin:0;accent-color:var(--teal,#c98aa0)}`;
document.head.append(st);
const box=document.createElement('div');box.id='siteVol';
box.innerHTML=`<button type="button" aria-label="Volume" aria-expanded="false" aria-controls="siteMenu"></button>
<div id="siteMenu" hidden>
  <div id="siteNow"><span>Now playing</span><b id="siteTitle"></b></div>
  <button type="button" id="siteSkip">Skip song</button>
  <label><span>Music <b id="vmV"></b></span><input id="vm" type="range" min="0" max="100"></label>
  <label><span>SFX <b id="vsV"></b></span><input id="vs" type="range" min="0" max="100"></label>
</div>`;
document.body.append(box);
const btn=box.querySelector('button'),menu=box.querySelector('#siteMenu'),vm=box.querySelector('#vm'),vs=box.querySelector('#vs');
const icon=()=>{const off=vol.music===0&&vol.sfx===0;
  btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5L6 9H3v6h3l5 4V5z"/>'+(off?'<path d="M16 9l5 6M21 9l-5 6"/>':'<path d="M15.5 8.5a5 5 0 010 7"/><path d="M18.5 5.5a9 9 0 010 13"/>')+'</svg>'};
const sync=()=>{vm.value=Math.round(vol.music*100);vs.value=Math.round(vol.sfx*100);
  box.querySelector('#vmV').textContent=vm.value+'%';box.querySelector('#vsV').textContent=vs.value+'%';icon()};
const toggle=open=>{menu.hidden=!open;btn.setAttribute('aria-expanded',open)};
btn.onclick=()=>toggle(menu.hidden);
document.addEventListener('pointerdown',e=>{if(!box.contains(e.target))toggle(false)});
document.addEventListener('keydown',e=>{if(e.key==='Escape')toggle(false)});
vm.oninput=()=>{vol.music=vm.value/100;ls.set(VK,vol);sync();
  if(!p)return;p.setVolume(level());
  if(!cur)begin(true);   // volume changes never pause or skip a song
  setNow()};
vs.oninput=()=>{vol.sfx=vs.value/100;ls.set(VK,vol);sync()};
sync();

/* ---------- background music ---------- */
let p=null,ready=false,playing=false,cur=null,ids=ls.get(IK)||[],errs=0,tries=0;
const rnd=()=>{const pool=ids.filter(i=>i!==cur);return pool.length?pool[Math.floor(Math.random()*pool.length)]:ids[0]};
const level=()=>ducked?0:Math.round(vol.music*100*Math.min(1,GAIN[cur]||1));
function setNow(){const e=box.querySelector('#siteTitle'),t=playing&&title?title+(vol.music===0?' (muted)':''):'Click anywhere to start';e.textContent=t;e.title=t}
function play(id,t){cur=id;p.loadVideoById({videoId:id,startSeconds:t||0});p.setVolume(level())}
function begin(force){
  if(!ready||!ids.length||(playing&&!force))return;
  const s=ls.get(TK);   // keep the same song going when moving between pages
  if(s&&ids.includes(s.id)&&Date.now()-s.ts<30000)play(s.id,s.t+(Date.now()-s.ts)/1000);else play(rnd());
}
function learn(){
  const l=p.getPlaylist&&p.getPlaylist();
  if(l&&l.length){ids=l;ls.set(IK,l);begin()}else if(++tries<20)setTimeout(learn,400);
}
window.onYouTubeIframeAPIReady=()=>{
  p=new YT.Player('siteYt',{width:200,height:200,
    playerVars:{listType:'playlist',list:PLAYLIST,controls:0,disablekb:1,playsinline:1},
    events:{
      onReady:()=>{ready=true;p.setVolume(level());begin();learn()},
      onStateChange:e=>{const S=YT.PlayerState;
        if(e.data===S.PLAYING){playing=true;errs=0;try{title=p.getVideoData().title||''}catch(x){}setNow()}
        else if(e.data===S.ENDED){playing=false;play(rnd())}   // random next song, forever
        else if(e.data===S.CUED&&!ids.length)learn()},
      onError:()=>{playing=false;if(++errs<8&&ids.length>1)play(rnd())}
    }});
};
setNow();
box.querySelector('#siteSkip').onclick=()=>{if(!ready||!ids.length){begin(true);return}play(rnd())};
const yt=document.createElement('div');
yt.style.cssText='position:fixed;left:0;bottom:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
yt.innerHTML='<div id="siteYt"></div>';document.body.append(yt);
const s=document.createElement('script');s.src='https://www.youtube.com/iframe_api';document.head.append(s);
// browsers block sound until the visitor interacts: the first click/key press starts the music
let gestured=false;
['pointerdown','keydown'].forEach(ev=>addEventListener(ev,()=>{if(!gestured&&!playing){gestured=true;begin(true)}},true));
addEventListener('pagehide',()=>{if(p&&playing&&cur)ls.set(TK,{id:cur,t:p.getCurrentTime(),ts:Date.now()})});
})();
