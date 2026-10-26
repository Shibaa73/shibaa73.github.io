/* Cloudflare Worker: the small backend for Apps/WhitecatShine.html
   (the osu! and Twitch APIs need secret keys, so the page can't call them directly).

   Setup (free):
   1. osu!:  osu.ppy.sh -> Settings -> OAuth -> "New OAuth Application" -> copy Client ID + Secret.
   2. Twitch: dev.twitch.tv/console -> "Register Your Application" (category: Website Integration)
      -> copy Client ID, then "New Secret".
   3. dash.cloudflare.com -> Workers & Pages -> Create -> paste this file -> Deploy.
   4. Worker -> Settings -> Variables and Secrets, add: OSU_CLIENT_ID, OSU_CLIENT_SECRET,
      TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET (secrets). Optional: OSU_USER, TWITCH_LOGIN.
   5. Paste the Worker URL into `API` in Apps/WhitecatShine.html. */

const OSU_USER_DEFAULT='WhiteCat';       // osu! username (check it)
const TWITCH_LOGIN_DEFAULT='whitecatosu'; // Twitch login (check it)

const json=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{'content-type':'application/json','access-control-allow-origin':'*','cache-control':'public, max-age=60'}});

async function osuToken(env){
  const r=await fetch('https://osu.ppy.sh/oauth/token',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({client_id:env.OSU_CLIENT_ID,client_secret:env.OSU_CLIENT_SECRET,grant_type:'client_credentials',scope:'public'})});
  if(!r.ok)throw new Error('osu token');return (await r.json()).access_token;
}
async function osu(env){
  const tok=await osuToken(env),get=async p=>{const r=await fetch('https://osu.ppy.sh/api/v2'+p,{headers:{authorization:'Bearer '+tok}});if(!r.ok)throw new Error('osu '+r.status);return r.json()};
  const u=await get('/users/'+encodeURIComponent(env.OSU_USER||OSU_USER_DEFAULT)+'/osu?key=username');
  let scores=await get(`/users/${u.id}/scores/recent?mode=osu&limit=100&include_fails=0`),src='recent';   // recent = last 24h only
  if(!scores.length){scores=await get(`/users/${u.id}/scores/best?mode=osu&limit=100`);src='best'}     // inactive: fall back to top plays
  const ts=scores.map(s=>Date.parse(s.created_at)),to=Math.max(...ts,0),from=to-864e5;                    // 24h window ending at his latest play
  const plays=scores.filter(s=>Date.parse(s.created_at)>from&&s.pp!=null).sort((a,b)=>b.pp-a.pp).slice(0,3).map(s=>({
    title:s.beatmapset.title,artist:s.beatmapset.artist,diff:s.beatmap.version,pp:s.pp,acc:s.accuracy*100,grade:s.rank,
    mods:(s.mods||[]).map(m=>m.acronym||m).join(''),cover:s.beatmapset.covers&&s.beatmapset.covers['list@2x'],url:'https://osu.ppy.sh/b/'+s.beatmap.id}));
  const st=u.statistics||{};
  return{osu:{name:u.username,id:u.id,avatar:u.avatar_url,country:u.country_code,rank:st.global_rank,countryRank:st.country_rank,pp:st.pp,rankHistory:(u.rank_history&&u.rank_history.data)||[]},
    window:scores.length?{from:new Date(from).toISOString(),to:new Date(to).toISOString(),src}:null,plays};
}
async function twitch(env){
  const login=env.TWITCH_LOGIN||TWITCH_LOGIN_DEFAULT;
  const t=await fetch(`https://id.twitch.tv/oauth2/token?client_id=${env.TWITCH_CLIENT_ID}&client_secret=${env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`,{method:'POST'});
  if(!t.ok)throw new Error('twitch token');
  const h={'client-id':env.TWITCH_CLIENT_ID,authorization:'Bearer '+(await t.json()).access_token},get=async p=>(await fetch('https://api.twitch.tv/helix'+p,{headers:h})).json();
  const live=(await get('/streams?user_login='+login)).data?.[0];
  if(live)return{channel:login,live:true,id:live.id,title:live.title,game:live.game_name,startedAt:live.started_at};
  const user=(await get('/users?login='+login)).data?.[0];
  const v=user&&(await get(`/videos?user_id=${user.id}&type=archive&first=1`)).data?.[0];   // last broadcast (VODs must be enabled)
  return v?{channel:login,live:false,id:v.id,title:v.title,game:'',startedAt:v.created_at}:{channel:login,live:false,id:null,title:'',game:''};
}
export default{
  async fetch(req,env){
    if(req.method==='OPTIONS')return new Response(null,{headers:{'access-control-allow-origin':'*','access-control-allow-methods':'GET'}});
    const [o,t]=await Promise.allSettled([osu(env),twitch(env)]);
    return json({...(o.status==='fulfilled'?o.value:{osu:null,plays:[],window:null,error:String(o.reason)}),twitch:t.status==='fulfilled'?t.value:null});
  }
};
