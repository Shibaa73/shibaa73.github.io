/* Accounts for the whole site (Supabase): register with a unique username + email code, log in, log out.
   Load it after site.js on every page:   <script src="assets/auth.js"></script>   (apps: ../assets/auth.js)
   Other scripts use window.SITE_AUTH:  .user  .name  .token() (promise)  .open('login'|'register')  .logout()  .onChange(fn)
   Setup: put your project URL and anon (public) key below. Both are meant to be public; the database rules protect the data. */
(()=>{
const SUPABASE_URL='https://dvgbaacklfddxgnnnjha.supabase.co';
const SUPABASE_ANON_KEY='sb_publishable_tGiOvKtS48g4Agv7IoHQxg_YPZ7RZAD';

// inside the home page's frame the shell (index.html) owns the login
try{if(window.parent!==window&&window.parent.SITE_AUTH){window.SITE_AUTH=window.parent.SITE_AUTH;return}}catch(e){}
const configured=!/YOUR-/.test(SUPABASE_URL+SUPABASE_ANON_KEY);
const subs=new Set();let sb=null;
const A=window.SITE_AUTH={configured,user:null,name:null,ready:!configured,
  onChange(f){subs.add(f);if(A.ready)try{f(A)}catch(e){}return()=>subs.delete(f)},
  async token(){if(!sb)return null;try{const {data}=await sb.auth.getSession();return data.session?data.session.access_token:null}catch(e){return null}},
  open(mode){if(configured)openModal(mode||'login')},
  async logout(){if(sb)await sb.auth.signOut()}};
const fire=()=>subs.forEach(f=>{try{f(A)}catch(e){}});
if(!configured)return;

/* ---------- styles ---------- */
const css=document.createElement('style');
css.textContent=`
#acBtn{position:fixed;top:16px;right:64px;z-index:50;height:38px;display:inline-flex;align-items:center;gap:8px;padding:0 12px 0 8px;max-width:190px;background:var(--panel-2,#452c3a);border:1px solid var(--border,rgba(255,220,230,.09));border-radius:10px;color:var(--text,#f3e6ea);font:600 .85rem 'Inter',sans-serif;cursor:pointer;transition:border-color .15s,transform .14s,box-shadow .2s}
#acBtn:hover{border-color:var(--gold-dim,#8f5c6b);transform:translateY(-1px)}#acBtn:active{transform:scale(.96)}
#acBtn:focus-visible,.ac-box button:focus-visible,.ac-box input:focus-visible{outline:2px solid var(--pink,#ff7ab3);outline-offset:2px}
#acBtn .av,.ac-av{flex:none;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font:600 .78rem 'Fredoka',sans-serif;color:#fff;background:hsl(var(--h,330) 52% 46%)}
#acBtn span.n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#acBtn svg{width:18px;height:18px}
#acMenu{position:fixed;top:60px;right:64px;z-index:51;width:220px;padding:14px;display:grid;gap:10px;background:var(--panel,#3a2531);border:1px solid var(--border,rgba(255,220,230,.09));border-radius:14px;box-shadow:0 12px 32px rgba(0,0,0,.4);color:var(--text,#f3e6ea);font:.85rem 'Inter',sans-serif;animation:acin .2s cubic-bezier(.2,.8,.3,1) both}
#acMenu b{font:600 1rem 'Fredoka',sans-serif;overflow:hidden;text-overflow:ellipsis}#acMenu small{color:var(--muted,#a58891)}
.ac-over{position:fixed;inset:0;z-index:90;display:grid;place-items:center;padding:14px;background:rgba(18,9,14,.72);backdrop-filter:blur(6px);animation:acfade .25s ease both}
.ac-box{width:min(400px,100%);max-height:94vh;overflow:auto;padding:24px;background:var(--panel,#3a2531);border:1px solid var(--border,rgba(255,220,230,.09));border-radius:18px;color:var(--text,#f3e6ea);font:.92rem 'Inter',sans-serif;box-shadow:0 24px 60px rgba(0,0,0,.5);animation:acin .35s cubic-bezier(.2,.8,.3,1) both}
.ac-box h2{margin:0 0 4px;font:600 1.4rem 'Fredoka',sans-serif}
.ac-box p{margin:0 0 14px;color:var(--muted,#a58891);line-height:1.5;font-size:.88rem}
.ac-tabs{display:flex;gap:4px;padding:4px;margin-bottom:18px;background:var(--panel-2,#452c3a);border:1px solid var(--border,rgba(255,220,230,.09));border-radius:12px}
.ac-tabs button{flex:1;padding:8px;border:0;border-radius:9px;background:none;color:var(--muted,#a58891);font:600 .85rem 'Inter',sans-serif;cursor:pointer;transition:background .2s,color .2s}
.ac-tabs button[aria-selected=true]{background:var(--pink,#ff7ab3);color:#2a1a22}
.ac-box label{display:grid;gap:5px;margin-bottom:13px;font-size:.78rem;color:var(--muted,#a58891)}
.ac-box input{width:100%;padding:11px 13px;background:var(--panel-2,#452c3a);border:1px solid var(--border,rgba(255,220,230,.09));border-radius:11px;color:var(--text,#f3e6ea);font:1rem 'Inter',sans-serif;transition:border-color .15s,box-shadow .2s}
.ac-box input:focus{border-color:var(--pink,#ff7ab3);box-shadow:0 0 0 4px rgba(255,122,179,.14);outline:none}
.ac-box input.code{text-align:center;letter-spacing:.35em;font:600 1.4rem 'IBM Plex Mono',monospace}
.ac-hint{min-height:1.2em;font-size:.78rem}.ac-hint.ok{color:#8fd19e}.ac-hint.bad{color:#e58a9a}
.ac-go{width:100%;padding:12px;border:0;border-radius:12px;background:linear-gradient(135deg,#f7a3c6,#e0679a);color:#2a1a22;font:600 .95rem 'Inter',sans-serif;cursor:pointer;transition:transform .14s,box-shadow .25s,opacity .2s;box-shadow:0 6px 18px rgba(224,103,154,.25)}
.ac-go:hover{box-shadow:0 10px 26px rgba(224,103,154,.45)}.ac-go:active{transform:scale(.97)}.ac-go:disabled{opacity:.5;cursor:default}
.ac-link{background:none;border:0;padding:6px 0;color:var(--gold,#d99cae);font:500 .82rem 'Inter',sans-serif;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.ac-row{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:10px}
.ac-msg{margin:0 0 12px;padding:9px 12px;border-radius:10px;font-size:.84rem;background:rgba(229,138,154,.12);border:1px solid rgba(229,138,154,.4);color:#f0b3bf}
.ac-msg.ok{background:rgba(143,209,158,.12);border-color:rgba(143,209,158,.4);color:#a8e0b4}
.ac-x{float:right;border:0;background:none;color:var(--muted,#a58891);font-size:1.4rem;line-height:1;cursor:pointer;padding:0 4px}
@keyframes acin{from{opacity:0;transform:translateY(16px) scale(.97)}to{opacity:1;transform:none}}@keyframes acfade{from{opacity:0}}
@media (prefers-reduced-motion:reduce){*{animation-duration:.01ms!important}}
@media (max-width:520px){#acBtn .n{display:none}#acBtn{padding:0 7px}}`;
document.head.append(css);
const hue=n=>{let h=0;for(const c of String(n))h=(h*31+c.charCodeAt(0))%360;return h};
const el=(h)=>{const d=document.createElement('div');d.innerHTML=h.trim();return d.firstChild};
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ---------- header button + account menu ---------- */
const btn=document.createElement('button');btn.id='acBtn';btn.type='button';
if(!document.getElementById('siteVol'))btn.style.right='16px';   // no volume button on this page
btn.onclick=()=>{if(A.user)toggleMenu();else openModal('login')};
document.body.append(btn);
let menu=null;
function closeMenu(){if(menu){menu.remove();menu=null}}
function toggleMenu(){if(menu)return closeMenu();menu=el(`<div id="acMenu"><small>Signed in as</small><b>${esc(A.name||'…')}</b><small>${esc(A.user.email||'')}</small><button class="ac-go" type="button">Log out</button></div>`);
  if(btn.style.right)menu.style.right=btn.style.right;menu.querySelector('button').onclick=async()=>{closeMenu();await A.logout()};document.body.append(menu)}
document.addEventListener('pointerdown',e=>{if(menu&&!menu.contains(e.target)&&!btn.contains(e.target))closeMenu()});
function paint(){
  if(A.user){const n=A.name||'…';btn.style.setProperty('--h',hue(n));btn.innerHTML=`<span class="av">${esc(n[0].toUpperCase())}</span><span class="n">${esc(n)}</span>`;btn.setAttribute('aria-label','Account: '+n)}
  else{btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6"/></svg><span class="n">Log in</span>';btn.setAttribute('aria-label','Log in or register')}
  if(menu){closeMenu();if(A.user)toggleMenu()}}
paint();

/* ---------- supabase ---------- */
async function setSession(s){
  A.user=s?s.user:null;A.name=null;
  if(A.user){try{const {data}=await sb.from('profiles').select('username').eq('id',A.user.id).maybeSingle();A.name=data&&data.username||(A.user.user_metadata&&A.user.user_metadata.username)||null}catch(e){}}
  A.ready=true;paint();fire();
  if(A.user&&modal&&modal.dataset.done!=='1'){modal.dataset.done='1';toast('Welcome, '+(A.name||'player')+'!')}}
const sc=document.createElement('script');sc.src='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
sc.onload=async()=>{sb=window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
  const {data}=await sb.auth.getSession();await setSession(data.session);
  sb.auth.onAuthStateChange((ev,s)=>{if(ev==='INITIAL_SESSION')return;setTimeout(()=>setSession(s),0)})};
sc.onerror=()=>{A.ready=true;fire()};
document.head.append(sc);

/* ---------- login / register window ---------- */
let modal=null,st={};
function toast(t){const d=el(`<div class="ac-msg ok" style="position:fixed;top:64px;left:50%;translate:-50% 0;z-index:95;animation:acin .3s both">${esc(t)}</div>`);document.body.append(d);setTimeout(()=>d.remove(),2600)}
function closeModal(){if(modal){modal.remove();modal=null}}
addEventListener('keydown',e=>{if(e.key==='Escape'){closeModal();closeMenu()}});
function openModal(mode){closeMenu();if(!modal){modal=el('<div class="ac-over"><div class="ac-box" role="dialog" aria-modal="true" aria-label="Account"></div></div>');
  modal.addEventListener('pointerdown',e=>{if(e.target===modal)closeModal()});document.body.append(modal)}
  st={view:mode,email:'',kind:'signup',msg:'',ok:false};render()}
const box=()=>modal.firstChild;
function msg(){return st.msg?`<div class="ac-msg${st.ok?' ok':''}">${esc(st.msg)}</div>`:''}
function render(){
  const b=box(),v=st.view;
  if(v==='code'){
    b.innerHTML=`<button class="ac-x" type="button" aria-label="Close">×</button><h2>Check your email</h2><p>We sent a code to <b>${esc(st.email)}</b>. Type it here to ${st.kind==='signup'?'finish creating your account':'log in'}.</p>${msg()}
      <label>Code<input class="code" id="acCode" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="••••••"></label>
      <button class="ac-go" id="acVerify" type="button">Verify</button>
      <div class="ac-row"><button class="ac-link" id="acResend" type="button">Send a new code</button><button class="ac-link" id="acBack" type="button">Back</button></div>`;
    b.querySelector('.ac-x').onclick=closeModal;const inp=b.querySelector('#acCode');inp.focus();
    inp.oninput=()=>{inp.value=inp.value.replace(/\D/g,'')};inp.onkeydown=e=>{if(e.key==='Enter')verify()};
    b.querySelector('#acVerify').onclick=verify;b.querySelector('#acBack').onclick=()=>{st.view=st.kind==='signup'?'register':'login';st.msg='';render()};
    b.querySelector('#acResend').onclick=async()=>{const r=st.kind==='signup'?await sb.auth.resend({type:'signup',email:st.email}):await sb.auth.signInWithOtp({email:st.email,options:{shouldCreateUser:false}});
      st.msg=r.error?nice(r.error):'A new code is on its way.';st.ok=!r.error;render()};
    return}
  const tabs=`<div class="ac-tabs" role="tablist"><button type="button" role="tab" data-v="login" aria-selected="${v==='login'}">Log in</button><button type="button" role="tab" data-v="register" aria-selected="${v==='register'}">Register</button></div>`;
  if(v==='login'){
    b.innerHTML=`<button class="ac-x" type="button" aria-label="Close">×</button><h2>Welcome back</h2><p>Log in to play the Daily ozu and keep your scores under your name.</p>${tabs}${msg()}
      <label>Email<input id="acEmail" type="email" autocomplete="email" value="${esc(st.email)}"></label>
      <label>Password<input id="acPass" type="password" autocomplete="current-password"></label>
      <button class="ac-go" id="acLogin" type="button">Log in</button>
      <div class="ac-row"><button class="ac-link" id="acMail" type="button">Email me a code instead</button></div>`;
    const go=async()=>{const email=val('acEmail'),password=b.querySelector('#acPass').value;if(!email||!password)return say('Enter your email and password.');
      busy(true);const {error}=await sb.auth.signInWithPassword({email,password});busy(false);
      if(!error)return closeModal();
      if(/not confirmed/i.test(error.message)){st.email=email;st.kind='signup';st.view='code';st.msg='Your email isn’t verified yet. Type the code we sent you.';st.ok=false;await sb.auth.resend({type:'signup',email});return render()}
      say(nice(error))};
    b.querySelector('#acLogin').onclick=go;b.querySelector('#acPass').onkeydown=e=>{if(e.key==='Enter')go()};
    b.querySelector('#acMail').onclick=async()=>{const email=val('acEmail');if(!email)return say('Enter your email first.');busy(true);
      const {error}=await sb.auth.signInWithOtp({email,options:{shouldCreateUser:false}});busy(false);
      if(error)return say(nice(error));st.email=email;st.kind='email';st.view='code';st.msg='';render()};
  }else{
    b.innerHTML=`<button class="ac-x" type="button" aria-label="Close">×</button><h2>Create an account</h2><p>Pick a username (it shows on leaderboards), then confirm your email with a code.</p>${tabs}${msg()}
      <label>Username<input id="acUser" autocomplete="username" maxlength="20" value="${esc(st.user||'')}"><span class="ac-hint" id="acUh">3–20 letters, numbers, _ . -</span></label>
      <label>Email<input id="acEmail" type="email" autocomplete="email" value="${esc(st.email)}"></label>
      <label>Password<input id="acPass" type="password" autocomplete="new-password" placeholder="At least 8 characters"></label>
      <button class="ac-go" id="acReg" type="button">Create account</button>`;
    const u=b.querySelector('#acUser'),h=b.querySelector('#acUh');let tm=null,okName=false,last='';
    const check=async(final)=>{const n=u.value.trim();if(n===last&&!final)return okName;last=n;
      if(!/^[A-Za-z0-9_.-]{3,20}$/.test(n)){okName=false;h.className='ac-hint'+(n?' bad':'');h.textContent=n?'3–20 letters, numbers, _ . - only':'3–20 letters, numbers, _ . -';return false}
      h.className='ac-hint';h.textContent='Checking…';
      try{const {data,error}=await sb.rpc('username_available',{name:n});if(n!==u.value.trim())return okName;if(error)throw error;okName=!!data;h.className='ac-hint '+(okName?'ok':'bad');h.textContent=okName?'✓ '+n+' is available':'✗ That username is taken'}
      catch(e){okName=true;h.className='ac-hint';h.textContent=''}   // can't check right now: the server still refuses duplicates
      return okName};
    u.oninput=()=>{st.user=u.value;clearTimeout(tm);tm=setTimeout(()=>check(),350)};if(u.value)check(true);
    b.querySelector('#acReg').onclick=async()=>{const email=val('acEmail'),password=b.querySelector('#acPass').value,name=u.value.trim();
      if(!(await check(true)))return say('Pick a free username first.');if(!email)return say('Enter your email.');if(password.length<8)return say('The password needs at least 8 characters.');
      busy(true);const {data,error}=await sb.auth.signUp({email,password,options:{data:{username:name}}});busy(false);
      if(error)return say(/username_taken/.test(error.message)?'That username was just taken. Try another one.':/invalid_username/.test(error.message)?'That username isn’t allowed.':/Database error/i.test(error.message)?'Couldn’t create the account: the username is probably taken.':nice(error));
      if(data.user&&data.user.identities&&data.user.identities.length===0)return say('That email already has an account. Log in instead.');
      if(data.session)return closeModal();   // email confirmation turned off in Supabase: already logged in
      st.email=email;st.kind='signup';st.view='code';st.msg='';render()};
  }
  b.querySelector('.ac-x').onclick=closeModal;
  b.querySelectorAll('.ac-tabs button').forEach(t=>t.onclick=()=>{st.email=(b.querySelector('#acEmail')||{}).value||st.email;st.view=t.dataset.v;st.msg='';render()});
  const f=b.querySelector('input');if(f&&!f.value)f.focus();
}
const val=id=>box().querySelector('#'+id).value.trim();
const say=t=>{st.msg=t;st.ok=false;const keep={};box().querySelectorAll('input').forEach(i=>keep[i.id]=i.value);render();for(const k in keep){const i=box().querySelector('#'+k);if(i&&!i.value)i.value=keep[k]}};
const busy=on=>box().querySelectorAll('.ac-go').forEach(x=>{x.disabled=on});
const nice=e=>{const m=String(e.message||e);return /invalid login/i.test(m)?'Wrong email or password.':/rate limit|too many|seconds/i.test(m)?'Too many tries. Wait a minute and try again.':/expired|invalid/i.test(m)?'That code is wrong or has expired.':m};
async function verify(){const code=box().querySelector('#acCode').value.trim();if(code.length<6)return;busy(true);
  const {error}=await sb.auth.verifyOtp({email:st.email,token:code,type:st.kind==='signup'?'signup':'email'});busy(false);
  if(error){st.msg=nice(error);st.ok=false;return render()}closeModal()}
})();
