/* Ozu Guessr server (Cloudflare Worker + Durable Objects).
   The server picks the clips, runs the timers, checks the guesses and keeps the scores, so the browser never
   receives an answer before the reveal.

   Deploy (needs Node.js, free Cloudflare account):
     cd ozu-server
     npx wrangler login
     npx wrangler secret put YOUTUBE_API_KEY      (console.cloud.google.com -> enable "YouTube Data API v3" -> API key)
     npx wrangler secret put OSU_CLIENT_ID        (osu.ppy.sh -> Settings -> OAuth: the same app as the Whitecat worker works)
     npx wrangler secret put OSU_CLIENT_SECRET    (needed for the background questions: set ids + play counts)
     npx wrangler secret put ADMIN_KEY            (any long password: unlocks the hidden scoring panel in the page)
     npx wrangler secret put SUPABASE_URL         (Supabase -> Project Settings -> API: https://xxxx.supabase.co) } needed for accounts: the Daily ozu
     npx wrangler secret put SUPABASE_ANON_KEY    (the "anon public" key)                                         } then requires a login, once a day
     npx wrangler deploy                          (prints https://ozu-server.<you>.workers.dev -> paste into API in Apps/OzuGuessr.html)
   Check what the server reads:  <your url>/debug                                                                         */

const cors={'access-control-allow-origin':'*'};
const json=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{'content-type':'application/json',...cors}});

/* ---------- accounts (Supabase): the page sends its login token, the server asks Supabase who it belongs to ---------- */
// {off:true}: accounts not configured (old behaviour) | {}: no / invalid login | {id,name}: a logged-in user with a profile
async function authUser(env,tok){
  if(!env.SUPABASE_URL||!env.SUPABASE_ANON_KEY)return{off:true};
  if(!tok||typeof tok!=='string')return{why:'no_token'};
  // forgiving about how the secrets were pasted: quotes, spaces, missing https://, only the project id, a trailing /rest/v1
  let base=String(env.SUPABASE_URL).trim().replace(/^["']|["']$/g,'').trim().replace(/\/+$/,'').replace(/\/(rest|auth)\/v1$/,'');
  if(!/^https?:\/\//i.test(base))base='https://'+(base.includes('.')?base:base+'.supabase.co');
  const h={authorization:'Bearer '+tok,apikey:String(env.SUPABASE_ANON_KEY).trim().replace(/^["']|["']$/g,'').trim()};
  try{const r=await fetch(base+'/auth/v1/user',{headers:h});if(!r.ok)return{why:'rejected',status:r.status};const u=await r.json();if(!u||!u.id)return{why:'rejected',status:r.status};
    const p=await fetch(base+'/rest/v1/profiles?select=username&id=eq.'+encodeURIComponent(u.id),{headers:h});if(!p.ok)return{why:'profiles',status:p.status,id:u.id};
    const rows=await p.json();return rows[0]&&rows[0].username?{id:u.id,name:rows[0].username}:{why:'no_profile',id:u.id}}
  catch(e){return{why:'unreachable',detail:String(e&&e.message||e).slice(0,120)}}}
// what to tell the player when authUser found no usable login
const loginProblem=a=>a.why==='rejected'?'The server couldn’t verify your login (Supabase answered '+a.status+'). Log out and in again. If it keeps happening, SUPABASE_URL or SUPABASE_ANON_KEY on the server are wrong.'
  :a.why==='profiles'?'The server couldn’t read your profile (Supabase answered '+a.status+'). Run supabase/setup.sql in Supabase.'
  :a.why==='no_profile'?'Your account has no profile row. Delete the account and register again after running supabase/setup.sql.'
  :a.why==='unreachable'?'The server couldn’t reach Supabase ('+(a.detail||'unknown error')+'). Check that SUPABASE_URL on the server looks like https://xxxx.supabase.co and SUPABASE_ANON_KEY is the key only.':'Log in to play the Daily ozu.'

/* ---------- helper: call a named Durable Object (storage objects: pool, oz, config, cache, user-*, daily-*, ozd-*) ---------- */
async function dcall(env,name,path,body){const r=await env.LOBBY.get(env.LOBBY.idFromName(name)).fetch(new Request('https://do'+path,body===undefined?{}:{method:'POST',body:JSON.stringify(body)}));
  const d=await r.json();if(d&&d.error&&r.status>=400)throw new Error(d.error);return d}

/* ---------- start-up cache: the clip pool and background list live in a Durable Object too, so a cold Worker doesn't re-read YouTube / osu! ---------- */
const cacheDo=env=>env.LOBBY.get(env.LOBBY.idFromName('cache'));
async function cacheGet(env,key){try{const d=await(await cacheDo(env).fetch(new Request('https://do/cache/get?k='+key))).json();return d&&d.data?d:null}catch(e){return null}}
async function cacheSet(env,key,data){try{await cacheDo(env).fetch(new Request('https://do/cache/set?k='+key,{method:'POST',body:JSON.stringify({data})}))}catch(e){}}

/* ---------- clips from the @cpol_v1 channel ---------- */
const ytApi=async(p,env)=>{const r=await fetch('https://www.googleapis.com/youtube/v3/'+p+'&key='+env.YOUTUBE_API_KEY);if(!r.ok)throw new Error('youtube '+r.status);return r.json()};
// Reads one video of the @cpol_v1 channel. The title looks like
//   "10.8⭐player | Artist - Song [Diff] +DT 98.94% FC #1 | 1444pp - osu!"
// and the description has a section "// -=- Beatmap info" with the beatmap link and "⭐10.79 | 190bpm | AR: 9.8 ...".
function parseInfo(desc,title){
  title=title||'';
  const i=desc.search(/\/\/\s*(?:~~=~~|-=-)\s*Beatmap info/i);if(i<0)return null;
  let sec=desc.slice(i).split('\n').slice(1);const e=sec.findIndex(l=>/^\s*\/\/\s*(?:~~=~~|-=-)/.test(l));if(e>=0)sec=sec.slice(0,e);
  const txt=sec.join('\n'),num=m=>m?parseFloat(m[1]):null,pick=re=>{const m=txt.match(re);return m?m[1].trim():null};
  // song + artist: the middle part of the title, cut before "[Difficulty]" (which is followed by mods / accuracy)
  let song=null,artist=null;
  const m=(title.split(/\s\|\s/)[1]||'').match(/^(.+?)\s+-\s+(.*?)\s*\[[^\]]*\]\s*(?:\+[A-Za-z0-9]+\s+)?\d+(?:\.\d+)?%/);
  if(m){artist=m[1].trim();song=m[2].trim()}
  song=song||pick(/^\s*(?:song|title|name)\s*[:\-]\s*(.+)$/im);artist=artist||pick(/^\s*artist\s*[:\-]\s*(.+)$/im);
  const ppAll=[...title.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*pp\b/gi)].pop();
  return{song,artist,
    ar:num(txt.match(/\bAR\s*[:=]?\s*(\d+(?:\.\d+)?)/i)),
    bpm:num(txt.match(/(\d+(?:\.\d+)?)\s*bpm\b/i)||txt.match(/\bBPM\s*[:=]?\s*(\d+(?:\.\d+)?)/i)),
    sr:num(txt.match(/⭐\s*(\d+(?:\.\d+)?)/)||txt.match(/(\d+(?:\.\d+)?)\s*(?:★|stars?\b)/i)||title.match(/(\d+(?:\.\d+)?)\s*⭐/)),
    pp:ppAll?parseFloat(ppAll[1].replace(/,/g,'')):num(txt.match(/(\d+(?:\.\d+)?)\s*pp\b/i)),
    map:(txt.match(/\/b\/(\d+)/)||[])[1]||null,raw:txt.slice(0,400)};
}
let POOL={at:0,clips:null,dbg:null,mode:''};
/* The pool database (admin panel) is the main source: every entry is a map with its song, artist, numbers and optionally a gameplay video.
   Entries without a video are played from the osu! preview audio. While the database is empty the old YouTube-channel pool is used. */
function clipsFromDb(maps){const out=[];
  for(const m of maps){if(!m.on||!m.so||!m.ar)continue;
    const base={song:m.so,artist:m.ar,ar:m.a==null?null:m.a,bpm:m.b==null?null:m.b,sr:m.r==null?null:m.r,pp:m.p==null?null:m.p,map:m.m||null,set:m.s?String(m.s):null,at:m.t||'2015-01-01T00:00:00Z'};
    if(m.v)out.push({...base,id:m.v,dur:m.d||180});else if(m.s)out.push({...base,id:'s'+m.s,preview:String(m.s),dur:0})}
  return out}
async function loadPool(env,force){
  if(!force&&POOL.clips&&Date.now()-(POOL.dbAt||POOL.at)<3e5)return POOL;
  try{const d=await dcall(env,'pool','/pool/all');
    if(d.maps&&d.maps.length){const clips=clipsFromDb(d.maps);
      if(clips.length){POOL={at:Date.now(),clips,mode:'db',maps:d.maps,dbg:{source:'database',entries:d.maps.length,playable:clips.length,withVideo:clips.filter(c=>!c.preview).length,previewOnly:clips.filter(c=>c.preview).length}};return POOL}}}catch(e){}
  if(!force&&POOL.clips&&POOL.mode==='yt'&&Date.now()-POOL.at<216e5){POOL.dbAt=Date.now();return POOL}
  return ytPool(env,force)}
async function ytPool(env,force){
  if(!force&&POOL.clips&&POOL.mode==='yt'&&Date.now()-POOL.at<216e5)return POOL;
  if(!force){const c=await cacheGet(env,'pool');if(c&&Date.now()-c.at<216e5&&c.data.clips&&c.data.clips.length){POOL={at:c.at,clips:c.data.clips,dbg:c.data.dbg,mode:'yt'};return POOL}}
  const ch=await ytApi('channels?part=contentDetails&forHandle=%40cpol_v1',env),up=ch.items[0].contentDetails.relatedPlaylists.uploads,ids=[];let tok='';
  for(let n=0;n<10;n++){const d=await ytApi('playlistItems?part=contentDetails&maxResults=50&playlistId='+up+(tok?'&pageToken='+tok:''),env);ids.push(...d.items.map(x=>x.contentDetails.videoId));tok=d.nextPageToken;if(!tok)break}
  const all=[],noInfo=[],samples=[];
  const batches=[];for(let i=0;i<ids.length;i+=50)batches.push(ids.slice(i,i+50));
  const pages=await Promise.all(batches.map(b=>ytApi('videos?part=snippet,contentDetails&id='+b.join(','),env)));   // all batches at once
  for(const d of pages){
    for(const v of d.items){if(samples.length<3)samples.push({title:v.snippet.title,description:(v.snippet.description||'').slice(0,700)});const info=parseInfo(v.snippet.description||'',v.snippet.title||'');
      if(!info){if(noInfo.length<2)noInfo.push((v.snippet.description||'').slice(0,300));continue}
      const m=v.contentDetails.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      all.push({id:v.id,at:v.snippet.publishedAt,dur:(+m[1]||0)*3600+(+m[2]||0)*60+(+m[3]||0),...info})}}
  const clips=all.filter(c=>c.song&&c.artist&&c.dur>=50);
  const dbgOf=()=>({videos:ids.length,withInfoSection:all.length,usable:clips.length,tooShort:all.filter(c=>c.dur<50).length,firstVideos:samples,parsed:clips.slice(0,3).map(({song,artist,ar,bpm,sr,pp,map})=>({song,artist,ar,bpm,sr,pp,map})),sections:all.slice(0,3).map(c=>c.raw),noInfoSamples:noInfo});
  const dbg=dbgOf();clips.forEach(c=>{delete c.raw});POOL={at:Date.now(),clips,dbg,mode:'yt'};
  await cacheSet(env,'pool',{clips,dbg});
  return POOL;
}

/* ---------- backgrounds: set id + play count from the osu! API, difficulty = play count quintile ---------- */
const TIERS=['Autoplay','Relax','NM','HR','DT'];      // very easy ... very hard: the fewer plays a map has, the less known it is
let BG={at:0,sets:null,dbg:null};
async function osuToken(env){
  const r=await fetch('https://osu.ppy.sh/oauth/token',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},
    body:JSON.stringify({client_id:env.OSU_CLIENT_ID,client_secret:env.OSU_CLIENT_SECRET,grant_type:'client_credentials',scope:'public'})});
  if(!r.ok)throw new Error('osu token '+r.status);return (await r.json()).access_token;
}
// osu! API: beatmap id -> {set id, play count} for up to many ids (50 per request, all requests at once)
async function osuMaps(env,tok,ids){const info=new Map(),errs=[],chunks=[];for(let i=0;i<ids.length;i+=50)chunks.push(ids.slice(i,i+50));
  await Promise.all(chunks.map(async c=>{
    try{const r=await fetch('https://osu.ppy.sh/api/v2/beatmaps?'+c.map(x=>'ids[]='+x).join('&'),{headers:{authorization:'Bearer '+tok,accept:'application/json'}});
      if(!r.ok){errs.push('osu '+r.status);return}
      for(const b of (await r.json()).beatmaps||[]){const set=b.beatmapset_id||(b.beatmapset&&b.beatmapset.id),pc=b.beatmapset&&b.beatmapset.play_count!=null?b.beatmapset.play_count:b.playcount;
        if(set&&pc!=null)info.set(String(b.id),{set:String(set),pc})}}
    catch(e){errs.push(String(e&&e.message||e))}}));
  return{info,errs}}
function tierSets(sets){sets.sort((a,b)=>b.pc-a.pc);sets.forEach((s,i)=>{s.tier=Math.min(4,Math.floor(i*5/sets.length));s.url='https://assets.ppy.sh/beatmaps/'+s.set+'/covers/raw.jpg'});   // the image is only a link: nothing is stored
  return{sets,tiers:TIERS.map((n,t)=>{const x=sets.filter(s=>s.tier===t);return{tier:n,sets:x.length,playcounts:x.length?[x[x.length-1].pc,x[0].pc]:null}})}}
async function loadBg(env,force){
  const pl=await loadPool(env);
  if(pl.mode==='db'){if(!force&&BG.pat===pl.at&&BG.sets)return BG;
    const bySet=new Map();for(const m of pl.maps)if(m.on&&m.s&&m.c>0&&!bySet.has(String(m.s)))bySet.set(String(m.s),{set:String(m.s),song:m.so,artist:m.ar,pc:m.c});
    const t=tierSets([...bySet.values()]);BG={at:Date.now(),pat:pl.at,sets:t.sets,dbg:{source:'database',sets:t.sets.length,tiers:t.tiers}};return BG}
  if(!force&&BG.sets&&!BG.pat&&Date.now()-BG.at<216e5)return BG;
  if(!force){const c=await cacheGet(env,'bg');if(c&&Date.now()-c.at<216e5&&c.data.sets&&c.data.sets.length){BG={at:c.at,sets:c.data.sets,dbg:c.data.dbg};return BG}}
  if(!env.OSU_CLIENT_ID||!env.OSU_CLIENT_SECRET){BG={at:Date.now(),sets:[],dbg:{error:'OSU_CLIENT_ID / OSU_CLIENT_SECRET are not set on the server'}};return BG}
  let tok;try{tok=await osuToken(env)}catch(e){BG={at:Date.now(),sets:[],dbg:{error:String(e&&e.message||e)}};return BG}
  const ids=[...new Set(pl.clips.map(c=>c.map).filter(Boolean))],{info,errs}=await osuMaps(env,tok,ids);
  const bySet=new Map();
  for(const c of pl.clips){const x=info.get(String(c.map));if(!x)continue;const s=bySet.get(x.set);if(!s)bySet.set(x.set,{set:x.set,song:c.song,artist:c.artist,pc:x.pc});else s.pc=Math.max(s.pc,x.pc)}
  const t=tierSets([...bySet.values()]),sets=t.sets;
  BG={at:Date.now(),sets,dbg:{maps:ids.length,found:info.size,sets:sets.length,tiers:t.tiers,errors:errs.slice(0,3)}};
  if(sets.length)await cacheSet(env,'bg',{sets,dbg:BG.dbg});
  return BG;
}
const bgOk=()=>!!(BG.sets&&BG.sets.length);

/* ---------- pool database: building entries from osu! beatmapsets (admin panel: search / add / import) ---------- */
// entry: k key, s set id, so song, ar artist, a AR, b BPM, r SR, p pp, c play count, v YouTube video, d video length, t date, m beatmap id, on enabled, src where it came from
// From the osu! search only set-level data is known (a set has many difficulties), so entries made from it have no AR / SR / pp: the questions about them are skipped for those maps.
const setEntry=(x,src)=>({k:String(x.id),s:String(x.id),so:String(x.title||'').trim(),ar:String(x.artist||'').trim(),a:null,b:x.bpm?Math.round(x.bpm*10)/10:null,r:null,p:null,c:x.play_count!=null?x.play_count:null,v:null,d:0,t:x.ranked_date||x.submitted_date||null,m:null,on:1,src:src||'osu'});
const osuGet=async(env,path)=>{const tok=await osuToken(env),r=await fetch('https://osu.ppy.sh/api/v2/'+path,{headers:{authorization:'Bearer '+tok,accept:'application/json'}});if(!r.ok)throw new Error('osu '+r.status);return r.json()};
async function importYt(env){
  const pl=await ytPool(env,true);let info=new Map();
  try{const tok=await osuToken(env);info=(await osuMaps(env,tok,[...new Set(pl.clips.map(c=>c.map).filter(Boolean))])).info}catch(e){}
  const seen=new Set(),maps=[];
  for(const c of pl.clips){const x=info.get(String(c.map)),k=x?x.set:'y'+c.id;if(seen.has(k))continue;seen.add(k);
    maps.push({k,s:x?x.set:null,so:c.song,ar:c.artist,a:c.ar,b:c.bpm,r:c.sr,p:c.pp,c:x?x.pc:null,v:c.id,d:c.dur,t:c.at,m:c.map,on:1,src:'yt'})}
  POOL.at=0;POOL.dbAt=0;return dcall(env,'pool','/pool/put',{maps,merge:true})}
async function importTop(env,o){
  const pages=Math.max(1,Math.min(40,+o.pages||20)),status=['ranked','loved','any'].includes(o.status)?o.status:'ranked';let cur=String(o.cursor||'');const maps=[];
  for(let n=0;n<pages;n++){const d=await osuGet(env,'beatmapsets/search?m=0&s='+status+'&sort=plays_desc'+(cur?'&cursor_string='+encodeURIComponent(cur):''));
    const list=d.beatmapsets||[];for(const x of list)maps.push(setEntry(x));cur=d.cursor_string||'';if(!cur||!list.length){cur='';break}}
  POOL.at=0;POOL.dbAt=0;const r=await dcall(env,'pool','/pool/put',{maps,merge:true});return{...r,cursor:cur,done:!cur}}
async function adminPool(env,u,req){
  const p=u.pathname,body=req.method==='POST'?await req.json().catch(()=>({})):{},touch=()=>{POOL.at=0;POOL.dbAt=0};
  if(p==='/admin/pool/list')return dcall(env,'pool','/pool/list'+u.search);
  if(p==='/admin/pool/toggle'||p==='/admin/pool/remove'){touch();return dcall(env,'pool',p.replace('/admin',''),body)}
  if(p==='/admin/pool/add'){const id=String(body.set||'').match(/(\d+)/);if(!id)throw new Error('Type a beatmapset id or link');
    const x=await osuGet(env,'beatmapsets/'+id[1]);touch();return dcall(env,'pool','/pool/put',{maps:[setEntry(x,'manual')],manual:true})}
  if(p==='/admin/osu/search'){const q=String(u.searchParams.get('q')||'').slice(0,100),st=['any','ranked','loved'].includes(u.searchParams.get('s'))?u.searchParams.get('s'):'any';
    const d=await osuGet(env,'beatmapsets/search?m=0&s='+st+'&q='+encodeURIComponent(q)),list=(d.beatmapsets||[]).slice(0,30).map(x=>setEntry(x));
    const has=await dcall(env,'pool','/pool/has',{keys:list.map(x=>x.k)});return{items:list.map(x=>({...x,inPool:has.has.includes(x.k)}))}}
  if(p==='/admin/pool/import'){if(body.mode==='yt')return importYt(env);return importTop(env,body)}
  if(p==='/admin/pool/export')return dcall(env,'pool','/pool/export');
  if(p==='/admin/pool/restore'){touch();return dcall(env,'pool','/pool/put',{maps:body.maps||[],merge:false,manual:true})}
  throw new Error('not found')}

/* ---------- Ozillion rules ---------- */
const OZ_PTS=[10,30,50,80,100],OZ_CUM=[.5,.8,.93,.985],OZ_MIN=3;       // rarity tiers: Doo Doo, Those Who Know..., Ball Knowledge, WYSI, Ozillion!
const ozn=s=>{const t=String(s||'').normalize('NFKD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9぀-ヿ一-鿿]+/g,' ').trim();return t.replace(/^the /,'')};
// tier of every answer: the most given answers (by count) cover the first half of all answers -> Doo Doo, the next 30 % -> Those Who Know..., and so on; an answer can also carry a fixed tier
function ozTiers(q){const m=new Map(),list=[...q.ans].sort((a,b)=>b.n-a.n||(a.name<b.name?-1:1)),tot=list.reduce((x,a)=>x+Math.max(0,a.n),0);let cum=0;
  for(const a of list){let t=0;if(tot>0){const f=cum/tot;t=f<OZ_CUM[0]?0:f<OZ_CUM[1]?1:f<OZ_CUM[2]?2:f<OZ_CUM[3]?3:4}m.set(a.id,a.tier!=null&&a.tier>=0&&a.tier<=4?a.tier:t);cum+=Math.max(0,a.n)}
  return m}
// the answer a guess means: exact (after normalising) on the name or any alias, otherwise one small typo on long names, only when it is unambiguous
function ozMatch(q,guess){const g=ozn(guess);if(!g)return null;
  for(const a of q.ans)for(const nm of [a.name,...(a.al||[])])if(ozn(nm)===g)return a;
  let best=1e9,hits=new Set();
  for(const a of q.ans)for(const nm of [a.name,...(a.al||[])]){const n=ozn(nm);if(n.length<6||g.length<6)continue;const d=lev(g,n);if(d>(Math.max(g.length,n.length)>=12?2:1))continue;
    if(d<best){best=d;hits=new Set([a])}else if(d===best)hits.add(a)}
  return hits.size===1?[...hits][0]:null}

/* ---------- scoring (server side only); the curves and weights can be changed live in the hidden admin panel ---------- */
const FIELDS=[{k:'song',t:'text'},{k:'artist',t:'text'},{k:'ar',t:'num'},{k:'bpm',t:'num'},{k:'sr',t:'num'},{k:'pp',t:'num'}];
const HALF_LIFE_DAYS=365,BOMB_TOL=.95;
// points for a number = weight * curve(relative error): full points up to "full", 0 from "zero", in between an exponential drop of steepness k
const DEFAULT_CFG={w:{song:3,artist:2,ar:1,bpm:1,sr:1,pp:1},
  curve:Object.fromEntries(['ar','bpm','sr','pp'].map(k=>[k,{full:.02,zero:.2,k:2.5}])),
  bgMult:[1,1.5,2,2.5,3]};                                   // background questions: points multiplier per difficulty
const num=(v,a,b,d)=>{v=Number(v);return Number.isFinite(v)?Math.max(a,Math.min(b,v)):d};
const r2=v=>Math.round(v*100)/100;
function cleanCfg(c){c=c||{};const d=DEFAULT_CFG,o={w:{},curve:{},bgMult:[]};
  for(const k of Object.keys(d.w))o.w[k]=r2(num(c.w&&c.w[k],0,20,d.w[k]));
  for(const k of Object.keys(d.curve)){const x=(c.curve&&c.curve[k])||{},y=d.curve[k],full=num(x.full,0,.5,y.full),zero=num(x.zero,full+.01,1,Math.max(y.zero,full+.01));
    o.curve[k]={full:r2(full),zero:r2(zero),k:r2(num(x.k,-4,8,y.k))}}
  for(let i=0;i<5;i++)o.bgMult[i]=r2(num(c.bgMult&&c.bgMult[i],0,10,d.bgMult[i]));
  return o}
let CFG={at:0,v:cleanCfg()};
async function getCfg(env,force){
  if(!force&&Date.now()-CFG.at<30000)return CFG.v;
  try{const d=await(await env.LOBBY.get(env.LOBBY.idFromName('config')).fetch(new Request('https://do/cfg/get'))).json();CFG={at:Date.now(),v:cleanCfg(d.cfg)}}catch(e){CFG.at=Date.now()-20000}
  return CFG.v}
const curve=(e,c)=>{if(e<=c.full)return 1;if(e>=c.zero)return 0;const t=(e-c.full)/(c.zero-c.full);if(Math.abs(c.k)<1e-6)return 1-t;return(Math.exp(-c.k*t)-Math.exp(-c.k))/(1-Math.exp(-c.k))};

const norm=s=>String(s||'').normalize('NFKD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/\(.*?\)|\[.*?\]/g,' ').replace(/[^a-z0-9぀-ヿ一-鿿]+/g,' ').trim();
function lev(a,b){const m=[...Array(b.length+1).keys()];for(let i=1;i<=a.length;i++){let p=m[0];m[0]=i;for(let j=1;j<=b.length;j++){const t=m[j];m[j]=Math.min(m[j]+1,m[j-1]+1,p+(a[i-1]===b[j-1]?0:1));p=t}}return m[b.length]}
const textOk=(g,a)=>{g=norm(g);a=norm(a);return !!g&&!!a&&(g===a||1-lev(g,a)/Math.max(g.length,a.length)>=.85)};
const close=(g,a)=>a>0?1-Math.abs(g-a)/a:(g===a?1:0);
const bpmClose=(g,a)=>Math.max(...[1,2,3,4,1/2,1/3,1/4].map(f=>close(g*f,a)));      // half / double time still counts
const toNum=g=>Number(String(g).trim().replace(',','.'));
// relative error of a guess; AR is a 0-11 scale, so it is measured against max(answer, 10): an AR 0 map is not impossible to score on
function errOf(k,g,a){if(k==='ar')return Math.abs(g-a)/Math.max(a,10);if(k==='bpm')return 1-bpmClose(g,a);return a>0?Math.abs(g-a)/a:(g===a?0:1)}
function score(f,g,a,cfg){
  if(g===''||g==null||a==null)return 0;
  if(f.t==='text')return textOk(g,a)?cfg.w[f.k]:0;
  const n=toNum(g);if(!Number.isFinite(n))return 0;                                    // 0 is a valid guess (AR 0)
  return cfg.w[f.k]*curve(errOf(f.k,n,a),cfg.curve[f.k]);
}
const pickWeighted=(pool,rnd=Math.random)=>{const now=Date.now(),w=pool.map(c=>Math.max(.05,Math.pow(.5,(now-Date.parse(c.at))/(HALF_LIFE_DAYS*864e5))));
  let r=rnd()*w.reduce((a,b)=>a+b,0);for(let i=0;i<pool.length;i++){r-=w[i];if(r<=0)return pool[i]}return pool[pool.length-1]};
// somebody on the leaderboard who isn't logged in shows as "name (guest)" (a name that already ends that way is not doubled)
const guestName=n=>String(n||'Player').replace(/\s*\(guest\)\s*$/i,'').slice(0,20)+' (guest)';
const HINT_MULT=.6;
const maskTitle=t=>String(t).split(/\s+/).map(w=>w.match(/[\p{L}\p{N}]/u)?w:'').filter(Boolean).map((w,i)=>i?'___':w.match(/[\p{L}\p{N}]/u)[0]+'___').join(' ');   // only the first letter of the first word, every other word is a blank (no word lengths, no punctuation)
const clamp=(v,a,b,d)=>Math.max(a,Math.min(b,+v||d));
const same=(a,b)=>{a=String(a||'');b=String(b||'');let d=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)d|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return d===0};

/* ---------- Daily ozu: Rome calendar day, seeded random ---------- */
const romeParts=()=>{const o={};for(const p of new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Rome',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date()))o[p.type]=p.value;return o};
const romeDay=()=>{const o=romeParts();return o.year+'-'+o.month+'-'+o.day};                         // changes at midnight Rome time
const secsToMidnight=()=>{const o=romeParts();return 86400-(+o.hour*3600+ +o.minute*60+ +o.second)};
const seeded=str=>{let h=1779033703^str.length;for(let i=0;i<str.length;i++){h=Math.imul(h^str.charCodeAt(i),3432918353);h=h<<13|h>>>19}
  let a=h>>>0;return()=>{a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}};

/* ---------- one lobby = one Durable Object ---------- */
const GATE_MS=25000,HOLD_MAX_MS=30000;     // how long a round waits for the clips to really play / how long ads may pause the timer
export class Lobby{
  constructor(state,env){this.state=state;this.env=env;this.socks=new Map();this.players=new Map();this.host=null;this.phase='lobby';this.timer=null;this.used=new Set();this.usedBg=new Set();this.drafts=new Map();
    this.holds=new Map();this.holdUsed=new Map();this.ready=new Set();this.sc=cleanCfg();this.seq=0;this.live='';this.spectators=new Map();this.rematch=new Set();this.hinted=new Set();this.rounds=[];this.ozHist=[];this.dk='';
    this.cfg={fields:{song:true,artist:true,ar:true,bpm:true,sr:true,pp:true},time:45,rounds:5,mode:'classic',lives:3,waitFirst:false,content:'clips',tier:'random',clipLen:20,hints:true}}
  async fetch(req){
    const u=new URL(req.url);if(/^\/(daily|cfg|user|cache|pool|oz)\//.test(u.pathname)&&req.headers.get('Upgrade')!=='websocket')return this.internalHttp(u,req);
    if(req.headers.get('Upgrade')!=='websocket')return new Response('websocket only',{status:426});
    const [c,s]=Object.values(new WebSocketPair());s.accept();const id=crypto.randomUUID().slice(0,8);this.socks.set(id,s);
    s.addEventListener('message',e=>{let m;try{m=JSON.parse(e.data)}catch(x){return}Promise.resolve().then(()=>this.msg(id,m)).catch(x=>this.send(id,{t:'err',m:'Server error: '+(x&&x.message||x)}))});
    s.addEventListener('close',()=>{try{s.close()}catch(x){}this.leave(id)});s.addEventListener('error',()=>this.leave(id));
    return new Response(null,{status:101,webSocket:c});
  }
  send(id,o){try{this.socks.get(id).send(JSON.stringify(o))}catch(e){}}
  bcast(o){for(const id of this.socks.keys())this.send(id,o)}
  sync(){const now=Date.now();if(this.phase==='round'&&this.running)this.left-=(now-this.at)/1000*this.speed;this.at=now}
  // the round clock runs only after the clips are ready for everybody (or the wait ran out), and stops while somebody's player shows an ad
  upd(){this.sync();this.running=this.phase==='round'&&this.base&&this.holds.size===0}
  push(extra){this.sync();
    const q=this.phase==='lobby'||this.phase==='end'?null:{i:this.i,key:this.key,type:this.type,clip:this.clipPub,bg:this.bg,tier:this.tier,fields:this.active,text:this.type==='oz'&&this.oq?this.oq.text:undefined,audio:!!(this.cl&&this.cl.preview),left:this.left,speed:this.speed,running:this.running,at:this.at,endsAt:this.endsAt,cur:this.cur,
      gate:(this.phase==='round'||this.phase==='turn')&&!this.base&&!this.cfg.waitFirst,held:this.holds.size>0||!!this.pausedAt};
    this.bcast({t:'state',host:this.host,phase:this.phase,cfg:this.cfg,pts:this.sc.w,bgMult:this.sc.bgMult,spectators:this.spectators.size,rematch:[...this.rematch],now:Date.now(),
      players:[...this.players.values()].map(p=>({id:p.id,name:p.name,acct:!!p.acct,score:+p.score.toFixed(2),lives:p.lives,done:this.guesses?this.guesses.has(p.id):false})),q,reveal:this.reveal||null,hist:this.phase==='end'?this.ozHist:undefined,...extra})}
  async msg(id,m){
    const P=this.players.get(id);
    if(m.t==='join'){
      if(m.daily&&m.create&&this.phase==='lobby')this.dk=m.kind==='oz'?'oz':'';
      if(this.phase!=='lobby'&&this.phase!=='end'){   // a game is running: watch it, and play from the next one
        if(this.daily)return this.send(id,{t:'err',m:'This Daily ozu is a single-player run.'});
        this.spectators.set(id,{id,name:String(m.name||'Player').slice(0,20)||'Player'});this.send(id,{t:'hello',id});return this.push()}
      if(!this.players.size&&!m.create){this.send(id,{t:'err',m:'Lobby not found.'});return this.socks.get(id).close()}
      let name=String(m.name||'Player').slice(0,20)||'Player',uid=null,acct=false;
      if(m.daily&&m.create){   // the Daily ozu: an account plays it once per Rome day; guests may play too and show as "name (guest)"
        const a=await authUser(this.env,m.token);
        if(a.id&&a.name){const stt=await(await this.boardFor(romeDay()).fetch(new Request('https://do/daily/status?day='+romeDay()+'&uid='+a.id))).json();
          if(stt.played){this.send(id,{t:'err',m:'You already played today’s '+(this.dk==='oz'?'Daily Ozillion':'Daily ozu')+' ('+(+stt.score).toFixed(2)+' pts). A new set comes at midnight Rome time.'});try{this.socks.get(id).close()}catch(e){}return}
          name=a.name.slice(0,20);uid=a.id;acct=true}
        else if(!a.off&&a.why&&a.why!=='no_token')this.send(id,{t:'err',m:loginProblem(a)+' Playing as a guest for now.'})}   // logged in but not verifiable: say why, then play as a guest
      else if(m.token){const a=await authUser(this.env,m.token);if(a.id&&a.name){name=a.name.slice(0,20);acct=true}}   // logged in: you play under your username
      if(uid)this.uid=uid;
      this.players.set(id,{id,name,score:0,lives:0,acct:!!uid||acct});if(!this.host)this.host=id;
      this.send(id,{t:'hello',id});
      const cfgP=getCfg(this.env).then(c=>{this.sc=c}).catch(()=>{});
      try{const pl=await loadPool(this.env);this.send(id,{t:'names',songs:[...new Set(pl.clips.map(c=>c.song))].sort(),artists:[...new Set(pl.clips.map(c=>c.artist))].sort()})}catch(e){this.send(id,{t:'err',m:'Server could not load clips: '+e.message})}
      await cfgP;
      loadBg(this.env).then(()=>this.send(id,{t:'caps',bg:bgOk(),why:bgOk()?'':(BG.dbg&&BG.dbg.error)||'no map ids found'})).catch(()=>this.send(id,{t:'caps',bg:false,why:'could not load'}));
      if(m.daily&&m.create&&this.players.size===1){this.daily=true;   // Daily ozu / Daily Ozillion: fixed settings, starts right away
        this.cfg=this.dk==='oz'?{fields:{},time:25,rounds:5,mode:'classic',lives:3,waitFirst:false,content:'oz',tier:'random',clipLen:20,hints:false}
          :{fields:{song:true,artist:true,ar:true,bpm:true,sr:true,pp:true},time:45,rounds:5,mode:'classic',lives:3,waitFirst:false,content:'clips',tier:'random',clipLen:20,hints:true};return this.begin()}
      if(m.kind==='oz'&&m.create&&this.players.size===1){this.ozSolo=true;this.cfg={...this.cfg,content:'oz',time:25,rounds:5,mode:'classic',fields:{},hints:false}}   // Ozillion unlimited: on your own
      if(m.kind==='bg'&&m.create&&this.players.size===1)this.cfg={...this.cfg,content:'bg',time:30,rounds:5,fields:{song:true,artist:false,ar:false,bpm:false,sr:false,pp:false}};
      return this.push();
    }
    if(!P)return;
    if(m.t==='settings'&&id===this.host&&this.phase==='lobby'){const c=m.cfg||{},t=Number(c.tier);
      this.cfg={fields:Object.fromEntries(FIELDS.map(f=>[f.k,!!(c.fields||{})[f.k]])),time:clamp(c.time,10,180,45),rounds:clamp(c.rounds,1,20,5),
        mode:c.mode==='bomb'&&!this.ozSolo?'bomb':'classic',lives:clamp(c.lives,1,10,3),waitFirst:!!c.waitFirst&&!(c.content==='oz'),
        clipLen:clamp(c.clipLen,5,30,20),hints:!!c.hints,content:this.ozSolo?'oz':c.content==='oz'?(c.mode==='bomb'?'oz':'clips'):['clips','bg','mixed'].includes(c.content)?c.content:'clips',tier:(c.tier===''||c.tier==null||c.tier==='random'||!Number.isFinite(t))?'random':Math.max(0,Math.min(4,Math.round(t)))};return this.push()}
    if(m.t==='start'&&id===this.host&&this.phase==='lobby')return this.begin();
    if(m.t==='again'&&this.phase==='end'&&!this.daily&&this.players.has(id)){this.rematch.has(id)?this.rematch.delete(id):this.rematch.add(id);   // rematch vote: back to the lobby once more than half of the players want it
      if(this.rematchCheck())return;return this.push()}
    if(m.t==='draft'&&this.phase==='round'&&!this.guesses.has(id)){const v=m.v&&typeof m.v==='object'?m.v:{};
      this.drafts.set(id,Object.fromEntries([...FIELDS.map(f=>f.k),'a'].filter(k=>v[k]!=null).map(k=>[k,String(v[k]).slice(0,200)])));return}
    if(m.t==='typing'&&this.phase==='turn'&&id===this.cur){this.live=String(m.v==null?'':m.v).slice(0,80);   // what the player on the bomb is typing, shown to everybody else
      for(const o of this.socks.keys())if(o!==id)this.send(o,{t:'typing',key:this.key,v:this.live});return}
    if(m.t==='hint'&&this.phase==='round'&&this.cfg.hints&&this.active.includes('song')&&!this.guesses.has(id)){   // second half of the time: the song title with only the first letter of every word (song points x0.6)
      this.sync();if(!this.base||this.left>this.cfg.time/2)return this.send(id,{t:'err',m:'Hints unlock when half of the time is gone.'});
      this.hinted.add(id);return this.send(id,{t:'hint',key:this.key,text:maskTitle(this.cl.song)})}
    if(m.t==='report'){const h=(this.ozHist||[])[+m.i],r=h&&h.res.find(x=>x.id===id);   // a player says that an answer they gave should have counted (checked against what they really typed)
      if(!r||r.hit||!String((r.guess||{}).a||'').trim())return this.send(id,{t:'err',m:'Nothing to report.'});
      this.rep=this.rep||new Set();const key=m.i+'|'+id;if(this.rep.has(key))return this.send(id,{t:'reported',i:+m.i});this.rep.add(key);
      try{await dcall(this.env,'oz','/oz/report',{qid:h.qid,kind:m.kind==='alias'?'alias':'answer',text:r.guess.a,target:String(m.target||'').slice(0,100)})}catch(e){}
      return this.send(id,{t:'reported',i:+m.i})}
    if(m.t==='next'&&id===this.host&&this.phase==='reveal')return this.nextRound();   // the host moves on, no automatic next round
    // the player's clip (or background) is really showing: classic waits for everybody, bomb for the player whose turn it is
    if(m.t==='ready'&&m.key===this.key){
      if(this.phase==='round'&&!this.base&&!this.cfg.waitFirst){this.ready.add(id);if(this.ready.size>=this.players.size)this.release();return}
      if(this.phase==='turn'&&!this.base&&id===this.cur)return this.startTurn()}
    // an ad seems to be playing in this player's clip: stop the clock (at most HOLD_MAX_MS per player and question)
    if(m.t==='hold'&&m.key===this.key){
      if(this.phase==='round'){const was=this.holds.size;
        if(m.on){if(!this.holds.has(id)&&(this.holdUsed.get(id)||0)<HOLD_MAX_MS)this.holds.set(id,Date.now())}
        else if(this.holds.has(id)){this.holdUsed.set(id,(this.holdUsed.get(id)||0)+Date.now()-this.holds.get(id));this.holds.delete(id)}
        if(this.holds.size!==was){this.upd();this.push()}return}
      if(this.phase==='turn'&&id===this.cur)return m.on?this.pauseTurn():this.resumeTurn()}
    if(m.t==='guess'&&this.phase==='round'&&!this.guesses.has(id)){
      this.guesses.set(id,m.v||{});
      if(this.cfg.waitFirst){this.base=true;this.upd();this.speed=1+.5*(this.guesses.size-1)}   // timer starts at the first guess, faster with every guess
      if(this.guesses.size>=this.players.size)return this.revealRound();
      return this.push();
    }
    if(m.t==='answer'&&this.phase==='turn'&&id===this.cur&&this.base)return this.resolveTurn(m.v);
  }
  leave(id){
    if(this.spectators.delete(id)){this.socks.delete(id);return this.push()}
    this.rematch.delete(id);
    const P0=this.players.get(id);
    if(this.daily&&this.claimed&&!this.submitted&&P0&&this.phase!=='end'){this.submitted=true;this.submitDaily(P0)}   // quitting mid-daily: the try is used up and the score so far counts
    this.socks.delete(id);const was=this.players.delete(id);if(!was)return;
    if(this.host===id)this.host=this.players.keys().next().value||null;
    if(!this.players.size){clearTimeout(this.timer);clearTimeout(this.holdTimer);return}
    if(this.phase==='end'&&this.rematchCheck())return;
    this.holds.delete(id);this.ready.delete(id);
    if(this.phase==='round'&&this.guesses){this.guesses.delete(id);if(this.guesses.size>=this.players.size)return this.revealRound();
      if(!this.base&&!this.cfg.waitFirst&&this.ready.size>=this.players.size)return this.release();this.upd()}
    if(this.phase==='turn'&&id===this.cur)return this.resolveTurn(null);
    this.push();
  }
  rematchCheck(){if(!this.rematch.size||this.rematch.size*2<=this.players.size)return false;
    this.phase='lobby';this.reveal=null;this.cyc=[];this.rematch=new Set();this.players.forEach(p=>{p.score=0;p.lives=0});
    for(const [id,sp] of this.spectators)this.players.set(id,{id,name:sp.name,score:0,lives:0,acct:false});this.spectators.clear();   // spectators join the next game
    this.push();return true}
  /* ----- questions ----- */
  clip(req){let pool=POOL.clips.filter(c=>!this.used.has(c.id)&&(!req||c[req]!=null));
    if(!pool.length){this.used.clear();pool=POOL.clips.filter(c=>!req||c[req]!=null)}
    if(!pool.length)return null;const c=pickWeighted(pool);this.used.add(c.id);return c}
  setClip(c){this.cl=c;if(c.preview){this.start=0;this.clipPub={id:c.id,preview:c.preview,start:0,end:30,dur:0};return}   // no video for this map: the osu! preview audio plays instead
    const L=this.cfg.clipLen||20,room=c.dur-30-L;   // the clip starts >=15 s in and ends >=15 s before the end (short videos: centred)
    this.start=c.start0!=null?c.start0:room>=0?15+Math.random()*room:Math.max(0,(c.dur-L)/2);this.clipPub={id:c.id,start:this.start,end:this.start+L,dur:c.dur}}   // 20 s clip: starts >=15 s in, ends >=15 s before the end
  bgQ(tier){let pool=BG.sets.filter(s=>s.tier===tier);                                    // a background of exactly the wanted difficulty ...
    for(let d=1;!pool.length&&d<5;d++)pool=BG.sets.filter(s=>s.tier===tier-d).length?BG.sets.filter(s=>s.tier===tier-d):BG.sets.filter(s=>s.tier===tier+d);   // ... only a tier without any map falls back to its neighbour
    const fresh=pool.filter(s=>!this.usedBg.has(s.set));if(fresh.length)pool=fresh;           // when the tier is used up, maps repeat inside it rather than changing the difficulty
    const s=pool[Math.floor(Math.random()*pool.length)];this.usedBg.add(s.set);return s}
  async begin(){
    const oz=this.cfg.content==='oz',bomb=this.cfg.mode==='bomb';
    if(bomb&&this.players.size<2)return this.send(this.host,{t:'err',m:'Bomb mode needs at least 2 players.'});
    if(!oz){
      try{await loadPool(this.env)}catch(e){return this.send(this.host,{t:'err',m:'Could not load clips: '+e.message})}
      if(!POOL.clips||!POOL.clips.length)return this.send(this.host,{t:'err',m:'No playable clips: the server could not read any video description. Open <server url>/debug to see why.'});
      if(bomb||this.cfg.content!=='clips'){try{await loadBg(this.env)}catch(e){}}
      if(!bomb&&this.cfg.content==='bg'&&!bgOk())return this.send(this.host,{t:'err',m:'Background questions are not available: '+((BG.dbg&&BG.dbg.error)||'no maps with a play count found')+'. Open <server url>/debug.'})}
    if(this.daily){try{const r=await this.boardFor(romeDay()).fetch(new Request('https://do/daily/set?day='+romeDay()+(oz?'&kind=oz':''))),d=await r.json();if(d.error)throw new Error(d.error);this.dailyClips=d.clips;this.ozQs=d.qs;this.day=d.day;this.sc=cleanCfg(d.sc)}   // everybody plays today's set with today's first scoring rules
      catch(e){this.send(this.host,{t:'err',m:'Could not load the daily set: '+e.message});return this.push()}
      if(this.uid){const [r]=await Promise.all([this.boardFor(this.day).fetch(new Request('https://do/daily/claim?day='+this.day,{method:'POST',body:JSON.stringify({uid:this.uid,name:this.players.get(this.host).name})})).then(x=>x.json()),
          this.env.LOBBY.get(this.env.LOBBY.idFromName('user-'+this.uid)).fetch(new Request('https://do/user/add',{method:'POST',body:JSON.stringify({day:this.day,kind:oz?'oz':''})})).catch(()=>{})]);   // (the second one remembers which days to erase if the account is deleted)
        if(!r.ok){this.send(this.host,{t:'err',m:'You already played today’s '+(oz?'Daily Ozillion':'Daily ozu')+'.'});try{this.socks.get(this.host).close()}catch(e){}return}}
      this.claimed=true}
    else{try{this.sc=await getCfg(this.env)}catch(e){}
      if(oz){let r;try{r=await dcall(this.env,'oz','/oz/pick',{n:bomb?60:this.cfg.rounds})}catch(e){return this.send(this.host,{t:'err',m:'Could not load the Ozillion questions: '+e.message})}
        if(!r.qs||!r.qs.length)return this.send(this.host,{t:'err',m:'There are no Ozillion questions yet (each needs at least '+OZ_MIN+' answers). Add some in the admin panel.'});
        this.ozQs=r.qs}}
    if(oz&&!bomb&&this.ozQs.length<this.cfg.rounds)this.cfg.rounds=this.ozQs.length
    this.used.clear();this.usedBg.clear();this.cyc=[];this.cycN=0;this.i=0;this.rounds=[];this.ozHist=[];this.rep=null;this.players.forEach(p=>{p.score=0;p.lives=this.cfg.lives});this.reveal=null;
    this.cfg.mode==='bomb'?(this.ring=[...this.players.keys()],this.cur=null,this.nextTurn()):this.nextRound();
  }
  /* ----- classic ----- */
  nextRound(){
    clearTimeout(this.timer);
    if(this.i>=this.cfg.rounds)return this.finish();
    const oz=this.cfg.content==='oz',useBg=!oz&&(this.cfg.content==='bg'||(this.cfg.content==='mixed'&&bgOk()&&Math.random()<.5));
    this.i++;this.key=++this.seq;this.hinted=new Set();this.guesses=new Map();this.drafts=new Map();this.reveal=null;this.cur=null;this.endsAt=null;
    if(oz){this.cl=null;this.type='oz';this.oq=this.ozQs[this.i-1];this.tier=null;this.bg=null;this.clipPub=null;this.active=['a']}
    else if(useBg){const tier=this.cfg.tier==='random'?Math.floor(Math.random()*5):this.cfg.tier,b=this.bgQ(tier);
      this.cl=b;this.type='bg';this.tier=b.tier;this.bg=b.url;this.clipPub=null;
      this.active=['song'].concat(this.cfg.fields.artist?['artist']:[])}
    else{const c=this.daily?this.dailyClips[this.i-1]:this.clip();if(!c){this.i--;return this.finish()}
      this.setClip(c);this.type='classic';this.tier=null;this.bg=null;
      this.active=FIELDS.filter(f=>this.cfg.fields[f.k]&&c[f.k]!=null&&c[f.k]!=='').map(f=>f.k)}
    this.left=this.cfg.time;this.speed=1;this.at=Date.now();this.phase='round';this.holds=new Map();this.holdUsed=new Map();this.ready=new Set();
    this.base=oz;this.running=false;this.gateAt=oz||this.cfg.waitFirst?0:Date.now()+GATE_MS;if(oz)this.upd();this.push();this.tick();   // Ozillion has no clip to wait for
  }
  release(){if(this.base)return;this.base=true;this.gateAt=0;this.upd();this.push()}
  tick(){clearTimeout(this.timer);this.timer=setTimeout(()=>{this.sync();if(this.phase!=='round')return;
    let ch=false;const now=Date.now();
    if(!this.base&&this.gateAt&&now>this.gateAt&&!this.cfg.waitFirst){this.base=true;this.gateAt=0;ch=true}
    for(const [id,since] of this.holds)if(now-since>HOLD_MAX_MS-(this.holdUsed.get(id)||0)){this.holds.delete(id);this.holdUsed.set(id,HOLD_MAX_MS);ch=true}
    if(ch){this.upd();this.push()}
    if(this.left<=0)return this.revealRound();this.tick()},250)}
  revealRound(){
    if(this.type==='oz')return this.revealOz();
    clearTimeout(this.timer);this.phase='reveal';this.holds=new Map();this.running=false;const c=this.cl,res=[],mult=this.type==='bg'?this.sc.bgMult[this.tier]:1;
    const act=FIELDS.filter(f=>this.active.includes(f.k)),fmax=Object.fromEntries(act.map(f=>[f.k,r2(this.sc.w[f.k]*(f.t==='text'?mult:1))]));
    for(const p of this.players.values()){const g=this.guesses.get(p.id)||this.drafts.get(p.id)||{},pts={};let tot=0;
      const hint=this.hinted.has(p.id);
      for(const f of act){pts[f.k]=r2(score(f,String(g[f.k]??'').trim(),c[f.k],this.sc)*(f.t==='text'?mult:1)*(hint&&f.k==='song'?HINT_MULT:1));tot+=pts[f.k]}
      p.score+=tot;res.push({id:p.id,name:p.name,guess:g,pts,hint,total:+tot.toFixed(2)})}
    this.reveal={answer:Object.fromEntries(FIELDS.map(f=>[f.k,c[f.k]])),res,fmax,tier:this.type==='bg'?this.tier:null,max:+Object.values(fmax).reduce((a,b)=>a+b,0).toFixed(2)};
    if(this.daily){const me0=res[0];if(me0)this.rounds.push({i:this.i,answer:this.reveal.answer,guess:me0.guess,pts:me0.pts,total:me0.total,max:this.reveal.max,hint:me0.hint})}   // kept for the recap of a played Daily
    this.push();
  }
  // Ozillion round: every answer is checked against the question's answers (rarity -> points)
  async revealOz(){
    clearTimeout(this.timer);this.phase='reveal';this.holds=new Map();this.running=false;const q=this.oq,list=[...this.players.values()];
    const rows=await Promise.all(list.map(async p=>{const g=(this.guesses.get(p.id)||this.drafts.get(p.id)||{}).a;return{p,g:String(g==null?'':g).trim(),r:await this.ozCheck(q.id,g)}}));
    let top=[];const res=rows.map(({p,g,r})=>{if(r.top)top=r.top;const pts=r.hit?OZ_PTS[r.tier]:0;p.score+=pts;return{id:p.id,name:p.name,guess:{a:g},hit:!!r.hit,match:r.hit?r.name:null,tier:r.hit?r.tier:null,pts:{a:pts},total:pts}});
    this.reveal={oz:true,qid:q.id,text:q.text,answer:{},res,top,fmax:{a:100},max:100};
    this.ozHist.push({i:this.i,qid:q.id,text:q.text,res});
    if(this.daily){const m0=res[0];if(m0)this.rounds.push({i:this.i,oz:true,text:q.text,guess:m0.guess,hit:m0.hit,match:m0.match,tier:m0.tier,total:m0.total})}
    this.push();
  }
  async ozCheck(qid,guess){const g=String(guess==null?'':guess).slice(0,100);if(!g.trim())return{hit:false};try{return await dcall(this.env,'oz','/oz/check',{qid,guess:g})}catch(e){return{hit:false}}}
  /* ----- bomb: everybody alive plays once per cycle, and a cycle has one question type and one difficulty, so nobody gets an easier one ----- */
  nextTurn(){
    clearTimeout(this.timer);clearTimeout(this.holdTimer);const alive=this.ring.filter(id=>this.players.get(id)?.lives>0);
    if(alive.length<=1)return this.finish();
    if(!this.cyc||!this.cyc.length){const o=[...alive];for(let i=o.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[o[i],o[j]]=[o[j],o[i]]}   // every cycle has a fresh random order
      if(o.length>1&&o[0]===this.cur){[o[0],o[1]]=[o[1],o[0]]}   // nobody plays twice in a row across two cycles
      this.cyc=o;
      if(this.cfg.content==='oz'){this.cycType='oz';this.cycQ=this.ozQs[(this.cycN++)%this.ozQs.length];this.ozUsed=new Set()}   // one question per cycle, an answer can only be given once
      else{const types=['clip_map','audio_map','clip_bpm','clip_pp'];if(bgOk())types.push('bg_map');
      this.cycType=types[Math.floor(Math.random()*types.length)];this.cycTier=Math.floor(Math.random()*5)}}
    let id;do{id=this.cyc.shift()}while(id!==undefined&&!(this.players.get(id)?.lives>0));
    if(id===undefined)return this.nextTurn();
    this.live='';this.cur=id;this.type=this.cycType;this.reveal=null;this.active=[];this.guesses=null;
    if(this.type==='oz'){this.oq=this.cycQ;this.cl=null;this.tier=null;this.bg=null;this.clipPub=null;this.active=[];this.i++;this.key=++this.seq;this.phase='turn';this.base=false;this.running=false;this.speed=1;this.endsAt=null;this.at=Date.now();this.left=this.cfg.time;return this.startTurn()}
    if(this.type==='bg_map'){const b=this.bgQ(this.cycTier);this.cl=b;this.tier=b.tier;this.bg=b.url;this.clipPub=null}
    else{const c=this.clip({clip_bpm:'bpm',clip_pp:'pp'}[this.type]);if(!c)return this.finish();this.setClip(c);this.tier=null;this.bg=null}
    this.i++;this.key=++this.seq;this.phase='turn';this.base=false;this.running=false;this.speed=1;this.endsAt=null;this.at=Date.now();
    this.left=10+Math.random()*5;this.push();
    this.timer=setTimeout(()=>this.startTurn(),GATE_MS);       // starts when the player's clip is playing, or after a while anyway
  }
  startTurn(){if(this.base)return;clearTimeout(this.timer);this.base=true;this.running=true;this.at=Date.now();this.endsAt=Date.now()+this.left*1000;
    this.push();this.timer=setTimeout(()=>this.resolveTurn(null),this.left*1000)}
  pauseTurn(){if(!this.base||!this.endsAt||this.pausedAt)return;this.left=Math.max(0,(this.endsAt-Date.now())/1000);this.endsAt=null;this.running=false;this.pausedAt=Date.now();clearTimeout(this.timer);
    this.push();this.holdTimer=setTimeout(()=>this.resumeTurn(),HOLD_MAX_MS/2)}
  resumeTurn(){if(!this.pausedAt)return;this.pausedAt=0;clearTimeout(this.holdTimer);this.running=true;this.at=Date.now();this.endsAt=Date.now()+this.left*1000;
    this.push();this.timer=setTimeout(()=>this.resolveTurn(null),this.left*1000)}
  resolveTurn(v){
    if(this.type==='oz')return this.resolveOz(v);
    clearTimeout(this.timer);clearTimeout(this.holdTimer);this.pausedAt=0;this.running=false;const c=this.cl,P=this.players.get(this.cur);let ok=false;
    if(v!=null&&v!==''){const n=toNum(v);ok=this.type==='clip_bpm'?bpmClose(n,c.bpm)>=BOMB_TOL:this.type==='clip_pp'?close(n,c.pp)>=BOMB_TOL:textOk(v,c.song)}
    if(!ok&&P)P.lives--;
    this.phase='turnReveal';this.reveal={cur:this.cur,ok,guess:v??null,tier:this.type==='bg_map'?this.tier:null,answer:{song:c.song,artist:c.artist,bpm:c.bpm,pp:c.pp}};this.push();
    this.timer=setTimeout(()=>this.nextTurn(),4500);
  }
  async resolveOz(v){
    clearTimeout(this.timer);clearTimeout(this.holdTimer);this.pausedAt=0;this.running=false;this.base=false;const cur=this.cur,q=this.oq;
    const r=v!=null&&String(v).trim()?await this.ozCheck(q.id,v):{hit:false};let ok=!!r.hit,dup=false;const P=this.players.get(cur);
    if(ok&&this.ozUsed.has(r.aid)){ok=false;dup=true}
    if(ok){this.ozUsed.add(r.aid);if(r.tier>=3&&P&&P.lives<this.cfg.lives)P.lives++}else if(P)P.lives--;   // a rare answer (WYSI / Ozillion!) gives a life back
    this.phase='turnReveal';this.reveal={oz:true,cur,ok,dup,guess:v==null?null:String(v),text:q.text,match:r.hit?r.name:null,tier:r.hit?r.tier:null,answer:{}};this.push();
    this.timer=setTimeout(()=>this.nextTurn(),7000);
  }
  finish(){clearTimeout(this.timer);clearTimeout(this.holdTimer);this.phase='end';this.cur=null;this.running=false;
    if(this.daily&&!this.submitted){this.submitted=true;this.submitDaily([...this.players.values()][0]).finally(()=>this.push());return}   // the score is on the board before the final screen appears
    this.push()}
  async submitDaily(p){if(!p)return;
    try{await this.boardFor(this.day).fetch(new Request('https://do/daily/score?day='+this.day,{method:'POST',body:JSON.stringify({name:this.uid||p.acct?p.name:guestName(p.name),score:+p.score.toFixed(2),uid:this.uid||null,rounds:this.rounds})}))}catch(e){}}
  /* ----- storage objects: "daily-YYYY-MM-DD" holds one Rome day (set + board), "config" holds the scoring settings; only the Worker and other Lobby objects talk to them ----- */
  boardFor(day){return this.env.LOBBY.get(this.env.LOBBY.idFromName((this.dk==='oz'?'ozd-':'daily-')+day))}
  async dailySet(day,kind){
    const st=this.state.storage;let s=await st.get('set:'+day);if(s)return s;
    if(kind==='oz'){const r=await dcall(this.env,'oz','/oz/pick',{n:5,seed:'oz-daily-'+day});if(!r.qs||!r.qs.length)throw new Error('there are no Ozillion questions yet');
      s=await st.get('set:'+day);if(s)return s;s={day,qs:r.qs,sc:cleanCfg()};await st.put('set:'+day,s);return s}
    const pl=await loadPool(this.env);if(!pl.clips.length)throw new Error('no clips');
    s=await st.get('set:'+day);if(s)return s;                         // another request may have finished first
    const rnd=seeded('ozu-daily-'+day),pool=[...pl.clips].sort((a,b)=>a.id<b.id?-1:1),clips=[];
    for(let n=0;n<5&&pool.length;n++){const c=pickWeighted(pool,rnd);pool.splice(pool.indexOf(c),1);clips.push({...c,start0:c.preview?0:15+rnd()*(c.dur-50)})}
    s={day,clips,sc:await getCfg(this.env)};await st.put('set:'+day,s);return s;   // fixed for the whole day, same for everybody (scoring rules included)
  }
  top(b){return Object.entries(b||{}).map(([name,score])=>({name,score})).sort((a,b)=>b.score-a.score||(a.name<b.name?-1:1)).slice(0,50)}
  // big JSON documents are stored in 30 KB pieces (one stored value is limited to 128 KB) and kept in memory while the object lives
  async bLoad(name,def){this.bc=this.bc||{};if(this.bc[name])return this.bc[name];const st=this.state.storage,meta=await st.get('b:'+name);let d=def;
    if(meta){let t='';for(let i=0;i<meta.n;i++)t+=(await st.get('b:'+name+':'+i))||'';try{d=JSON.parse(t)}catch(e){}}return this.bc[name]=d}
  async bSave(name){const st=this.state.storage,t=JSON.stringify(this.bc[name]),n=Math.ceil(t.length/30000)||1;for(let i=0;i<n;i++)await st.put('b:'+name+':'+i,t.slice(i*30000,(i+1)*30000));await st.put('b:'+name,{n,at:Date.now()})}
  async poolHttp(u,req,out){
    const d=await this.bLoad('pool',{maps:{},bans:[]}),body=req.method==='POST'?await req.json().catch(()=>({})):{},P=u.pathname;
    if(P==='/pool/all')return out({maps:Object.values(d.maps)});
    if(P==='/pool/has')return out({has:(body.keys||[]).filter(k=>d.maps[k])});
    if(P==='/pool/list'){const q=ozn(u.searchParams.get('q')),off=Math.max(0,+u.searchParams.get('off')||0),lim=Math.min(100,+u.searchParams.get('lim')||40),f=u.searchParams.get('f')||'all';let a=Object.values(d.maps);const all=a.length;
      const stats={all,on:a.filter(m=>m.on).length,video:a.filter(m=>m.v).length,preview:a.filter(m=>!m.v).length,bg:a.filter(m=>m.s&&m.c>0).length};
      if(q)a=a.filter(m=>ozn(m.so+' '+m.ar).includes(q));if(f==='off')a=a.filter(m=>!m.on);if(f==='video')a=a.filter(m=>m.v);if(f==='preview')a=a.filter(m=>!m.v);
      a.sort((x,y)=>(y.c||0)-(x.c||0)||(x.so<y.so?-1:1));return out({total:a.length,stats,items:a.slice(off,off+lim)})}
    if(P==='/pool/put'){let add=0,upd=0;const bans=new Set(d.bans);
      for(const e of body.maps||[]){if(!e||!e.k||!e.so||!e.ar)continue;const k=String(e.k);if(!body.manual&&bans.has(k))continue;if(body.manual)bans.delete(k);
        const o=d.maps[k];if(!o){d.maps[k]={...e,k,on:e.on===0?0:1};add++;continue}
        if(body.merge===false){d.maps[k]={...e,k};upd++;continue}
        const m={...o};for(const [f,v] of Object.entries(e))if(v!=null&&f!=='on'&&f!=='k'&&(o[f]==null||f==='c'))m[f]=v;d.maps[k]=m;upd++}
      d.bans=[...bans];await this.bSave('pool');return out({added:add,updated:upd,total:Object.keys(d.maps).length})}
    if(P==='/pool/toggle'){const m=d.maps[String(body.k)];if(!m)return out({error:'unknown map'},404);m.on=body.on?1:0;await this.bSave('pool');return out({ok:true})}
    if(P==='/pool/remove'){const k=String(body.k);delete d.maps[k];if(!d.bans.includes(k))d.bans.push(k);await this.bSave('pool');return out({ok:true,total:Object.keys(d.maps).length})}   // removed maps stay out when an import runs again
    if(P==='/pool/export')return out({maps:Object.values(d.maps),bans:d.bans});
    return out({error:'not found'},404)}
  async ozHttp(u,req,out){
    const d=await this.bLoad('oz',{seq:0,qs:{},reports:[]}),body=req.method==='POST'?await req.json().catch(()=>({})):{},P=u.pathname,save=()=>this.bSave('oz');
    const playable=()=>Object.values(d.qs).filter(q=>q.ans.length>=OZ_MIN),sum=q=>q.ans.reduce((x,a)=>x+Math.max(0,a.n),0);
    const clean=(x,old)=>({id:old?old.id:String(++d.seq),name:String(x.name||'').trim().slice(0,100),al:[...new Set((Array.isArray(x.al)?x.al:String(x.al||'').split(',')).map(v=>String(v).trim().slice(0,100)).filter(Boolean))].slice(0,30),
      n:Math.max(0,Math.min(1e9,Math.round(+x.n)||0)),tier:x.tier===''||x.tier==null||!Number.isFinite(+x.tier)?null:Math.max(0,Math.min(4,Math.round(+x.tier)))});
    if(P==='/oz/count')return out({questions:playable().length,all:Object.keys(d.qs).length});
    if(P==='/oz/pick'){let list=playable().filter(q=>!(body.exclude||[]).includes(q.id)).map(q=>({id:q.id,text:q.text})).sort((a,b)=>+a.id-+b.id);const rnd=body.seed?seeded(String(body.seed)):Math.random;
      for(let i=list.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[list[i],list[j]]=[list[j],list[i]]}return out({qs:list.slice(0,Math.max(1,Math.min(100,+body.n||5)))})}
    if(P==='/oz/check'){const q=d.qs[String(body.qid)];if(!q)return out({hit:false,gone:true});const a=ozMatch(q,body.guess),top=[...q.ans].sort((x,y)=>y.n-x.n).slice(0,3).map(x=>x.name);
      if(!a)return out({hit:false,top});return out({hit:true,aid:a.id,name:a.name,tier:ozTiers(q).get(a.id),top})}
    if(P==='/oz/report'){const q=d.qs[String(body.qid)];if(!q)return out({ok:false});const kind=body.kind==='alias'?'alias':'answer',text=String(body.text||'').trim().slice(0,100);if(!text)return out({ok:false});
      let r=d.reports.find(x=>x.qid===q.id&&x.kind===kind&&ozn(x.text)===ozn(text));
      if(r){r.n++;if(body.target&&!r.target)r.target=String(body.target).slice(0,100)}else{if(d.reports.length>=3000)return out({ok:false});d.reports.push({id:String(++d.seq),qid:q.id,qtext:q.text,kind,text,target:String(body.target||'').slice(0,100),n:1,at:Date.now()})}
      await save();return out({ok:true})}
    // ----- admin -----
    if(P==='/oz/overview')return out({questions:Object.values(d.qs).map(q=>({id:q.id,text:q.text,answers:q.ans.length,total:sum(q),playable:q.ans.length>=OZ_MIN})).sort((a,b)=>+a.id-+b.id),reports:d.reports.length,min:OZ_MIN});
    if(P==='/oz/q'){const q=d.qs[u.searchParams.get('id')];if(!q)return out({error:'unknown question'},404);const t=ozTiers(q);return out({q:{id:q.id,text:q.text,total:sum(q),ans:[...q.ans].sort((a,b)=>b.n-a.n||(a.name<b.name?-1:1)).map(a=>({...a,auto:t.get(a.id)}))}})}
    if(P==='/oz/q/save'){const text=String(body.text||'').trim().slice(0,200);if(!text)return out({error:'The question needs a text'},400);
      let q=body.id&&d.qs[String(body.id)];if(q)q.text=text;else{q={id:String(++d.seq),text,ans:[]};d.qs[q.id]=q}await save();return out({id:q.id})}
    if(P==='/oz/q/del'){delete d.qs[String(body.id)];d.reports=d.reports.filter(r=>r.qid!==String(body.id));await save();return out({ok:true})}
    if(P==='/oz/a/save'){const q=d.qs[String(body.qid)];if(!q)return out({error:'unknown question'},404);const x=body.a||{},old=x.id?q.ans.find(a=>a.id===String(x.id)):null,a=clean(x,old);
      if(!a.name)return out({error:'The answer needs a name'},400);const dup=q.ans.find(o=>o!==old&&ozn(o.name)===ozn(a.name));if(dup)return out({error:'There is already an answer called "'+dup.name+'" for this question'},400);
      if(old)Object.assign(old,a);else q.ans.push(a);await save();return out({id:a.id})}
    if(P==='/oz/a/del'){const q=d.qs[String(body.qid)];if(!q)return out({error:'unknown question'},404);q.ans=q.ans.filter(a=>a.id!==String(body.id));await save();return out({ok:true})}
    // bulk: one line per answer: name | alias, alias | count   (count and aliases optional)
    if(P==='/oz/a/bulk'){const q=d.qs[String(body.qid)];if(!q)return out({error:'unknown question'},404);let added=0,merged=0;
      for(const line of String(body.text||'').split('\n')){const [nm,al,n]=line.split('|').map(v=>v.trim());if(!nm)continue;const ex=q.ans.find(o=>ozn(o.name)===ozn(nm));
        if(ex){ex.n+=Math.max(0,Math.round(+n)||1);merged++;continue}q.ans.push(clean({name:nm,al:al||'',n:n===undefined||n===''?1:n},null));added++}
      await save();return out({added,merged})}
    if(P==='/oz/reports')return out({reports:[...d.reports].sort((a,b)=>b.n-a.n||b.at-a.at)});
    if(P==='/oz/report/resolve'){const r=d.reports.find(x=>x.id===String(body.id));if(!r)return out({error:'unknown report'},404);const q=d.qs[r.qid];
      if(body.action==='answer'&&q){const nm=String(body.name||r.text).trim().slice(0,100),ex=q.ans.find(o=>ozn(o.name)===ozn(nm));if(ex)ex.n+=r.n;else q.ans.push(clean({name:nm,n:r.n},null))}
      else if(body.action==='alias'&&q){const a=q.ans.find(o=>o.id===String(body.target));if(!a)return out({error:'Pick the answer this is an alias of'},400);if(!a.al.includes(r.text)&&ozn(a.name)!==ozn(r.text))a.al.push(r.text)}
      d.reports=d.reports.filter(x=>x!==r);await save();return out({ok:true})}
    if(P==='/oz/export')return out({qs:Object.values(d.qs)});
    if(P==='/oz/restore'){for(const q of body.qs||[]){if(!q||!q.text)continue;const id=String(q.id||++d.seq);d.qs[id]={id,text:String(q.text).slice(0,200),ans:(q.ans||[]).map(a=>clean(a,null))};d.seq=Math.max(d.seq,+id||0)}await save();return out({ok:true})}
    return out({error:'not found'},404)}
  async internalHttp(u,req){
    const day=u.searchParams.get('day')||romeDay(),st=this.state.storage,out=(d,s)=>new Response(JSON.stringify(d),{status:s||200,headers:{'content-type':'application/json'}});
    try{
      if(u.pathname.startsWith('/pool/'))return await this.poolHttp(u,req,out);
      if(u.pathname.startsWith('/oz/'))return await this.ozHttp(u,req,out);
      if(u.pathname==='/cfg/get')return out({cfg:(await st.get('scoring'))||null});
      if(u.pathname==='/cfg/set'&&req.method==='POST'){const c=cleanCfg(await req.json());await st.put('scoring',c);return out({cfg:c})}
      if(u.pathname==='/daily/set')return out(await this.dailySet(day,u.searchParams.get('kind')));
      if(u.pathname==='/daily/board')return out({board:this.top(await st.get('board:'+day))});
      if(u.pathname==='/cache/get'){const k=u.searchParams.get('k'),meta=await st.get('c:'+k);if(!meta)return out({});let str='';for(let i=0;i<meta.n;i++)str+=(await st.get('c:'+k+':'+i))||'';return out({at:meta.at,data:JSON.parse(str)})}
      if(u.pathname==='/cache/set'&&req.method==='POST'){const k=u.searchParams.get('k'),str=JSON.stringify((await req.json()).data),n=Math.ceil(str.length/30000);   // small pieces: one stored value is limited to 128 KB
        for(let i=0;i<n;i++)await st.put('c:'+k+':'+i,str.slice(i*30000,(i+1)*30000));await st.put('c:'+k,{at:Date.now(),n});return out({ok:true})}
      if(u.pathname==='/user/add'&&req.method==='POST'){const m=await req.json(),key=m.kind==='oz'?'ozdays':'days',d=(await st.get(key))||[];if(!d.includes(m.day))d.push(m.day);await st.put(key,d);return out({ok:true})}
      if(u.pathname==='/user/stats'){const days=[...((await st.get(u.searchParams.get('kind')==='oz'?'ozdays':'days'))||[])].sort(),set=new Set(days),today=u.searchParams.get('today')||romeDay();
        const num=d=>Date.UTC(+d.slice(0,4),+d.slice(5,7)-1,+d.slice(8,10))/864e5,prev=d=>new Date((num(d)-1)*864e5).toISOString().slice(0,10);
        let cur=0,d=set.has(today)?today:prev(today);while(set.has(d)){cur++;d=prev(d)}   // alive if you played today or yesterday
        let best=0,run=0,last=null;for(const x of days){run=last&&num(x)-num(last)===1?run+1:1;best=Math.max(best,run);last=x}
        return out({streak:cur,best,total:days.length,playedToday:set.has(today)})}
      if(u.pathname==='/user/days')return out({days:(await st.get('days'))||[],ozdays:(await st.get('ozdays'))||[]});
      if(u.pathname==='/user/clear'&&req.method==='POST'){await st.put('days',[]);await st.put('ozdays',[]);return out({ok:true})}
      if(u.pathname==='/daily/erase'&&req.method==='POST'){const m=await req.json(),b=(await st.get('board:'+day))||{},pl=(await st.get('played:'+day))||{};
        if(m.name)delete b[m.name];delete pl[m.uid];await st.put('board:'+day,b);await st.put('played:'+day,pl);return out({ok:true})}
      if(u.pathname==='/daily/status'){const x=((await st.get('played:'+day))||{})[u.searchParams.get('uid')];return out({played:!!x,score:x?x.score:0,rounds:x&&x.rounds||[]})}
      if(u.pathname==='/daily/claim'&&req.method==='POST'){const m=await req.json(),pl=(await st.get('played:'+day))||{};if(!m.uid)return out({ok:false});if(pl[m.uid])return out({ok:false,score:pl[m.uid].score});
        pl[m.uid]={name:String(m.name||'').slice(0,20),score:0};await st.put('played:'+day,pl);return out({ok:true})}
      if(u.pathname==='/daily/score'&&req.method==='POST'){const m=await req.json(),name=String(m.name||'Player').slice(0,30)||'Player',score=+m.score||0;
        if(m.uid){const pl=(await st.get('played:'+day))||{};pl[m.uid]={name,score:Math.max(score,(pl[m.uid]&&pl[m.uid].score)||0),rounds:Array.isArray(m.rounds)?m.rounds.slice(0,30):(pl[m.uid]&&pl[m.uid].rounds)||[]};await st.put('played:'+day,pl)}
        const b=(await st.get('board:'+day))||{};if(!(b[name]>=score))b[name]=score;                       // best score per name
        await st.put('board:'+day,Object.fromEntries(Object.entries(b).sort((x,y)=>y[1]-x[1]).slice(0,500)));return out({ok:true})}
    }catch(e){return out({error:String(e&&e.message||e)},500)}
    return out({error:'not found'},404);
  }
}

/* ---------- router ---------- */
export default{
  async fetch(req,env){
    const u=new URL(req.url),cfgDo=()=>env.LOBBY.get(env.LOBBY.idFromName('config'));
    if(req.method==='OPTIONS')return new Response(null,{headers:{...cors,'access-control-allow-methods':'GET, POST, OPTIONS','access-control-allow-headers':'content-type, x-admin-key, authorization'}});
    if(u.pathname==='/new'){const code=Array.from({length:5},()=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random()*32)]).join('');return json({code})}
    const dailyInfo=async(pref,kind)=>{const day=romeDay();try{const bd=env.LOBBY.get(env.LOBBY.idFromName(pref+day)),d=await(await bd.fetch(new Request('https://do/daily/board?day='+day))).json(),a=await authUser(env,(req.headers.get('authorization')||'').replace(/^Bearer /i,''));
      let mine=null;if(a.id){const [m1,m2]=await Promise.all([bd.fetch(new Request('https://do/daily/status?day='+day+'&uid='+a.id)).then(r=>r.json()),env.LOBBY.get(env.LOBBY.idFromName('user-'+a.id)).fetch(new Request('https://do/user/stats?today='+day+(kind?'&kind='+kind:''))).then(r=>r.json())]);mine={...m1,...m2,played:m1.played}}
      return json({day,secondsLeft:secsToMidnight(),board:d.board||[],login:!a.off,mine})}catch(e){return json({error:String(e)},500)}};
    if(u.pathname==='/daily')return dailyInfo('daily-','');
    if(u.pathname==='/ozdaily')return dailyInfo('ozd-','oz');
    // (/caps also warms the clip pool and background list, so the first game doesn't wait for them)
    if(u.pathname==='/caps'){try{await loadBg(env)}catch(e){}let oz=0;try{oz=(await dcall(env,'oz','/oz/count')).questions}catch(e){}return json({bg:bgOk(),why:bgOk()?'':(BG.dbg&&BG.dbg.error)||'no map ids found',oz})}
    if(u.pathname==='/account/erase'&&req.method==='POST'){   // right to erasure: removes the account's Daily ozu scores (the login itself is deleted by the page through Supabase)
      const a=await authUser(env,(req.headers.get('authorization')||'').replace(/^Bearer /i,''));
      if(a.off)return json({error:'Accounts are not set up on this server'},400);if(!a.id)return json({error:'Not logged in'},401);
      try{const ud=env.LOBBY.get(env.LOBBY.idFromName('user-'+a.id)),ds=await(await ud.fetch(new Request('https://do/user/days'))).json(),days=ds.days||[],ozdays=ds.ozdays||[];
        for(const day of days)await env.LOBBY.get(env.LOBBY.idFromName('daily-'+day)).fetch(new Request('https://do/daily/erase?day='+day,{method:'POST',body:JSON.stringify({uid:a.id,name:a.name})}));
        for(const day of ozdays)await env.LOBBY.get(env.LOBBY.idFromName('ozd-'+day)).fetch(new Request('https://do/daily/erase?day='+day,{method:'POST',body:JSON.stringify({uid:a.id,name:a.name})}));
        await ud.fetch(new Request('https://do/user/clear',{method:'POST'}));return json({ok:true,days:days.length+ozdays.length})}
      catch(e){return json({error:String(e&&e.message||e)},500)}}
    if(u.pathname==='/scoring')return json({cfg:await getCfg(env,true),defaults:cleanCfg()});
    if(u.pathname.startsWith('/admin/')){
      if(!env.ADMIN_KEY)return json({error:'ADMIN_KEY is not set on the server (npx wrangler secret put ADMIN_KEY)'},403);
      if(!same(req.headers.get('x-admin-key'),env.ADMIN_KEY))return json({error:'Wrong admin key'},401);
      if(u.pathname==='/admin/check')return json({ok:true});
      if(u.pathname.startsWith('/admin/pool/')||u.pathname==='/admin/osu/search'){try{return json(await adminPool(env,u,req))}catch(e){return json({error:String(e&&e.message||e)},500)}}
      if(u.pathname.startsWith('/admin/oz/')){try{return json(await dcall(env,'oz',u.pathname.replace('/admin','')+u.search,req.method==='POST'?await req.json().catch(()=>({})):undefined))}catch(e){return json({error:String(e&&e.message||e)},400)}}
      if(u.pathname!=='/admin/scoring')return json({error:'not found'},404);
      if(req.method!=='POST')return json({error:'POST only'},405);
      try{const r=await cfgDo().fetch(new Request('https://do/cfg/set',{method:'POST',body:JSON.stringify(await req.json())}));const d=await r.json();if(d.error)throw new Error(d.error);CFG={at:Date.now(),v:cleanCfg(d.cfg)};return json({cfg:CFG.v})}
      catch(e){return json({error:String(e&&e.message||e)},500)}}
    if(u.pathname==='/debug'){try{const p=await loadPool(env,true);let bg=null;try{bg=(await loadBg(env,true)).dbg}catch(e){bg={error:String(e)}}return json({...p.dbg,backgrounds:bg,scoring:await getCfg(env,true)})}catch(e){return json({error:String(e)},500)}}
    const m=u.pathname.match(/^\/lobby\/([A-Z0-9]{5})$/);
    if(m)return env.LOBBY.get(env.LOBBY.idFromName(m[1])).fetch(req);
    return json({ok:true,name:'ozu-server'});
  }
};
