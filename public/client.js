// ===== Friends-only DM client with admin & localStorage =====
const socket = io();

// ------- DOM -------
const loginScreen = document.getElementById('login-screen');
const chatScreen  = document.getElementById('chat-screen') || document.querySelector('.app'); // support both layouts
const usernameIn  = document.getElementById('username-input');
const adminCodeIn = document.getElementById('admin-code');
const loginBtn    = document.getElementById('login-btn');
const loginErr    = document.getElementById('login-error');

const meNameEl    = document.getElementById('me-name');
const meAvatarEl  = document.getElementById('me-avatar');
const logoutBtn   = document.getElementById('logout-btn');

const friendsUL   = document.getElementById('friends') || document.getElementById('friends-list');
const requestsUL  = document.getElementById('requests') || document.getElementById('requests-list');
const addFriendIn = document.getElementById('add-friend') || document.getElementById('add-username');
const sendFriendBtn = document.getElementById('send-friend-btn') || document.getElementById('send-request');

const chatTitle   = document.getElementById('chat-title') || { textContent: '' };
const chatStatus  = document.getElementById('chat-status') || { textContent: '' };
const headerActions = document.getElementById('header-actions') || document.createElement('div');

const messagesEl  = document.getElementById('messages');
const typingEl    = document.getElementById('typing-indicator');
const form        = document.getElementById('message-form') || document.getElementById('composer');
const input       = document.getElementById('message-input');
const sendBtn     = document.getElementById('send-btn');

const adminPanel  = document.getElementById('admin-panel');
const adminUsers  = document.getElementById('online-users');
const refreshAdmin = document.getElementById('refresh-admin');

// ------- Local state -------
const LS_KEY = 'dmchat:v2';
function loadState(){
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || { username:null, friends:[], requests:[], chats:{}, isAdmin:false }; }
  catch { return { username:null, friends:[], requests:[], chats:{}, isAdmin:false }; }
}
function saveState(){ localStorage.setItem(LS_KEY, JSON.stringify(state)); }
let state = loadState();

let activeFriend = null;            // who we're chatting with
let typingTimers = {};              // friend -> timeout id
let bound = false;                  // prevent duplicate bindings

// ------- Helpers -------
const initials = (s='?') => s.slice(0,2).toUpperCase();
const nowTime  = () => new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
const keyForPair = (a,b) => [a,b].sort().join('|');

function upsertFriend(name, online=null){
  if (!name) return;
  const i = state.friends.findIndex(f=>f.name===name);
  if (i === -1) state.friends.push({ name, online: !!online });
  else if (online !== null) state.friends[i].online = !!online;
  saveState();
}
function setRequests(list){ state.requests = Array.from(new Set(list||[])); saveState(); }
function appendDM(friend, msg){
  state.chats[friend] = state.chats[friend] || [];
  state.chats[friend].push(msg);
  if (state.chats[friend].length > 500) state.chats[friend].shift();
  saveState();
}

// ------- Renderers -------
function renderMe(){
  if (meNameEl) meNameEl.textContent = state.username || 'me';
  if (meAvatarEl) meAvatarEl.textContent = initials(state.username||'?');
}
function renderFriends(){
  if (!friendsUL) return;
  friendsUL.innerHTML = '';
  const list = [...state.friends].sort((a,b)=> Number(b.online)-Number(a.online) || a.name.localeCompare(b.name));
  for (const f of list){
    const li = document.createElement('li');
    const dot = document.createElement('span'); dot.className = 'dot' + (f.online ? ' online':'');
    const av  = document.createElement('div'); av.className = 'avatar'; av.textContent = initials(f.name);
    const col = document.createElement('div');
    col.innerHTML = `<div style="font-weight:800">${f.name}</div><div class="muted" style="font-size:12px">${f.online?'online':'offline'}</div>`;
    li.appendChild(dot); li.appendChild(av); li.appendChild(col);
    if (activeFriend === f.name){ const badge = document.createElement('div'); badge.className='badge'; badge.textContent='active'; li.appendChild(badge); }
    li.onclick = () => openChat(f.name);
    friendsUL.appendChild(li);
  }
}
function renderRequests(){
  if (!requestsUL) return;
  requestsUL.innerHTML = '';
  for (const from of state.requests){
    const li = document.createElement('li');
    const av = document.createElement('div'); av.className='avatar'; av.textContent = initials(from);
    const col= document.createElement('div'); col.innerHTML = `<div style="font-weight:800">${from}</div><div class="muted" style="font-size:12px">wants to be friends</div>`;
    const ok = document.createElement('button'); ok.className='btn xs'; ok.textContent='Accept';
    const no = document.createElement('button'); no.className='btn xs subtle'; no.textContent='Decline';
    ok.onclick = e=>{ e.stopPropagation(); socket.emit('respond friend request', { from, accepted:true }); };
    no.onclick = e=>{ e.stopPropagation(); socket.emit('respond friend request', { from, accepted:false }); };
    li.appendChild(av); li.appendChild(col); li.appendChild(ok); li.appendChild(no);
    requestsUL.appendChild(li);
  }
}
function renderMessages(){
  messagesEl.innerHTML = '';
  if (!activeFriend){
    const empty = document.createElement('div'); empty.className='empty';
    empty.innerHTML = `<div class="big">💬</div><div>Select a friend to start chatting.</div>`;
    messagesEl.appendChild(empty);
    if (chatTitle) chatTitle.textContent = 'No conversation';
    if (chatStatus) chatStatus.textContent = '';
    if (headerActions) headerActions.innerHTML='';
    return;
  }
  if (chatTitle) chatTitle.textContent = activeFriend;
  const fObj = state.friends.find(f=>f.name===activeFriend);
  if (chatStatus) chatStatus.textContent = fObj?.online ? 'online':'offline';

  if (headerActions){
    headerActions.innerHTML='';
    const clearBtn = document.createElement('button'); clearBtn.className='btn xs subtle'; clearBtn.textContent='Clear Local';
    clearBtn.onclick = ()=>{ state.chats[activeFriend]=[]; saveState(); renderMessages(); };
    headerActions.appendChild(clearBtn);
  }

  const history = state.chats[activeFriend] || [];
  for (const m of history){
    const row = document.createElement('div'); row.className='msg' + (m.from===state.username ? ' mine':'');
    const av  = document.createElement('div'); av.className='avatar'; av.textContent = initials(m.from);
    const bubble = document.createElement('div'); bubble.className='bubble';
    const meta = document.createElement('div'); meta.className='meta'; meta.textContent = `${m.from} • ${m.time || nowTime()}`;
    const text = document.createElement('div'); text.textContent = m.text;
    bubble.appendChild(meta); bubble.appendChild(text);
    row.appendChild(av); row.appendChild(bubble);
    messagesEl.appendChild(row);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function openChat(friend){
  activeFriend = friend;
  typingEl.textContent = '';
  renderFriends();
  renderMessages();
}

// ------- Login flow -------
function attemptLogin(name, code){
  return new Promise(resolve => {
    socket.emit('set username', { name, code }, (res)=> resolve(res));
  });
}
async function doLogin(){
  loginErr.textContent = '';
  const name = (usernameIn.value||'').trim();
  const code = (adminCodeIn?.value||'').trim();
  if (!name){ loginErr.textContent='Enter a username'; return; }

  const res = await attemptLogin(name, code);
  if (!res?.success){ loginErr.textContent = res?.message || 'Login failed'; return; }

  state.username = name;
  state.isAdmin  = !!res.isAdmin;
  // seed friends/requests (merge)
  for(const f of (res.friends||[])) upsertFriend(f, true);
  setRequests(res.requests||[]);
  saveState();

  renderMe(); renderFriends(); renderRequests();
  loginScreen.classList.add('hidden');
  if (chatScreen) chatScreen.classList.remove('hidden');

  if (state.friends.length && !activeFriend) openChat(state.friends[0].name);

  if (state.isAdmin && adminPanel){
    adminPanel.style.display='block';
  }
}

// ------- Bind (once) -------
function bindOnce(){
  if (bound) return; bound = true;

  // Login
  loginBtn?.addEventListener('click', doLogin);
  usernameIn?.addEventListener('keydown', e=>{ if (e.key==='Enter') doLogin(); });
  adminCodeIn?.addEventListener('keydown', e=>{ if (e.key==='Enter') doLogin(); });

  // Add friend
  sendFriendBtn?.addEventListener('click', ()=>{
    const target = (addFriendIn.value||'').trim();
    if (!target) return;
    if (target === state.username) return;
    socket.emit('send friend request', target);
    addFriendIn.value='';
  });

  // Send message (NO LOCAL APPEND HERE — prevents duplicate)
  form?.addEventListener('submit', (e)=>{
    e.preventDefault();
    if (!activeFriend) return;
    const text = (input.value||'').trim();
    if (!text) return;
    socket.emit('private message', { to: activeFriend, text });
    input.value='';
    socket.emit('pm typing', { to: activeFriend, typing:false });
  });

  // Typing events
  let typingTimer = null;
  input?.addEventListener('input', ()=>{
    if (!activeFriend) return;
    socket.emit('pm typing', { to: activeFriend, typing: input.value.length>0 });
    clearTimeout(typingTimer);
    typingTimer = setTimeout(()=> socket.emit('pm typing', { to: activeFriend, typing:false }), 1200);
  });

  // Admin refresh (optional snapshot—if server emits admin_message_log periodically, this is not strictly needed)
  refreshAdmin?.addEventListener('click', ()=> {
    // noop unless you add a server event like: socket.emit('admin snapshot request')
  });
}
bindOnce();

// ------- Auto-rejoin if username saved -------
window.addEventListener('load', ()=>{
  renderMe(); renderFriends(); renderRequests(); renderMessages();
  if (state.username){
    usernameIn.value = state.username;
    doLogin(); // auto-login with stored username (+ optional stored code is not persisted for safety)
  }
});

// ===== Socket events =====
socket.on('friend request', (from)=>{
  if (!state.requests.includes(from)) state.requests.push(from);
  saveState(); renderRequests();
});
socket.on('friend requests', (list)=>{
  setRequests(list||[]); renderRequests();
});
socket.on('friend accepted', (who)=>{
  upsertFriend(who, true); renderFriends();
  if (!activeFriend) openChat(who);
});
socket.on('friend declined', (who)=>{
  // You can add a toast if desired.
});

socket.on('friend online', (name)=>{ upsertFriend(name, true); renderFriends(); });
socket.on('friend offline', (name)=>{ upsertFriend(name, false); renderFriends(); });

socket.on('private message', (pm)=>{
  const friend = (pm.from === state.username) ? activeFriend : pm.from;
  if (!friend) return;
  appendDM(friend, { from: pm.from, text: pm.text, time: pm.time || nowTime() });
  if (activeFriend === friend) renderMessages();
});

socket.on('pm typing', ({ from, typing })=>{
  if (activeFriend !== from) return;
  typingEl.textContent = typing ? `${from} is typing…` : '';
  if (typing){
    clearTimeout(typingTimers[from]);
    typingTimers[from] = setTimeout(()=> typingEl.textContent='', 1500);
  }
});

// ===== Admin features =====
socket.on('admin granted', ({ onlineUsers, messages })=>{
  if (!adminPanel) return;
  state.isAdmin = true; saveState();
  adminPanel.style.display='block';
  renderAdminUsers(onlineUsers||[]);
  renderAdminMessages(messages||{});
});
socket.on('admin message log', (messages)=>{
  if (!adminPanel) return;
  renderAdminMessages(messages||{});
});

function renderAdminUsers(list){
  if (!adminUsers) return;
  adminUsers.innerHTML = '';
  const card = document.createElement('div'); card.className='card';
  const title = document.createElement('div'); title.className='muted'; title.textContent='Online users';
  const table = document.createElement('table'); table.className='table'; table.style.width='100%';

  (list||[]).forEach(u=>{
    const tr=document.createElement('tr');
    const td1=document.createElement('td'); td1.textContent=u;
    const td2=document.createElement('td'); td2.className='act';
    const btn=document.createElement('button'); btn.className='btn xs'; btn.textContent='Ban';
    btn.onclick = ()=> socket.emit('admin ban', u);
    td2.appendChild(btn); tr.appendChild(td1); tr.appendChild(td2);
    table.appendChild(tr);
  });

  card.appendChild(title); card.appendChild(table);
  adminUsers.innerHTML='';
  adminUsers.appendChild(card);
}

function renderAdminMessages(messages){
  // Build a list in the admin panel showing pair keys and last few messages
  const panel = document.getElementById('admin-panel');
  if (!panel) return;

  // Remove old log if exists
  let old = document.getElementById('admin-log');
  if (old) old.remove();

  const log = document.createElement('div'); log.id='admin-log'; log.className='card';
  const title = document.createElement('div'); title.className='muted'; title.textContent='DM logs (in-memory)';
  log.appendChild(title);

  const keys = Object.keys(messages||{}).sort();
  if (!keys.length){
    const p = document.createElement('div'); p.className='muted'; p.textContent='No messages yet.';
    log.appendChild(p);
  } else {
    keys.forEach(k=>{
      const wrap = document.createElement('div'); wrap.style.border='1px solid var(--border)'; wrap.style.borderRadius='10px'; wrap.style.padding='8px'; wrap.style.margin='6px 0';
      const h = document.createElement('div'); h.style.fontWeight='800'; h.style.marginBottom='4px'; h.textContent=k;
      wrap.appendChild(h);
      const last = (messages[k]||[]).slice(-5);
      last.forEach(m=>{
        const line = document.createElement('div'); line.className='muted'; line.textContent = `[${m.time}] ${m.from}: ${m.text}`;
        wrap.appendChild(line);
      });
      log.appendChild(wrap);
    });
  }

  panel.appendChild(log);
}
