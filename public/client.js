// -------------------------
// Simple DM Chat (friends-only) client
// - Persists username + DMs in localStorage
// - Friend requests (send/accept/decline)
// - Per-DM typing indicator
// -------------------------
const socket = io();

// ---- DOM
const loginScreen = document.getElementById('login-screen');
const app = document.getElementById('app');
const meNameEl = document.getElementById('me-name');
const meAvatar = document.getElementById('me-avatar');
const loginBtn = document.getElementById('login-btn');
const usernameInput = document.getElementById('username-input');
const loginErr = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');

const friendsList = document.getElementById('friends-list');
const requestsList = document.getElementById('requests-list');

const chatTitle = document.getElementById('chat-title');
const chatStatus = document.getElementById('chat-status');
const headerActions = document.getElementById('header-actions');
const messagesEl = document.getElementById('messages');
const typingEl = document.getElementById('typing-indicator');
const composer = document.getElementById('composer');
const input = document.getElementById('message-input');

const modal = document.getElementById('modal');
const modalClose = document.getElementById('modal-close');
const newDmBtn = document.getElementById('new-dm-btn');
const sendReqBtn = document.getElementById('send-request');
const addUsername = document.getElementById('add-username');
const modalMsg = document.getElementById('modal-msg');

// ---- Local state (persisted)
const LS_KEY = 'dmchat:v1';
function loadState(){
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || { username:null, friends:[], chats:{}, requests:[] }; }
  catch { return { username:null, friends:[], chats:{}, requests:[] }; }
}
function saveState(s){ localStorage.setItem(LS_KEY, JSON.stringify(s)); }
let state = loadState();

// Derived/UI state
let activeFriend = null;
let typingTimers = {}; // friend -> timeout id

// ---- Helpers
const initials = (name='?') => name.slice(0,2).toUpperCase();
const toast = (msg, kind='info') => {
  modalMsg.textContent = msg;
  modalMsg.style.color = (kind==='error') ? '#d83c3e' : (kind==='ok' ? '#23a55a' : '#b5b8bf');
  setTimeout(()=> { modalMsg.textContent=''; }, 2000);
};
function upsertFriend(name, online=null){
  if (!name) return;
  const idx = state.friends.findIndex(f=>f.name===name);
  if (idx === -1) state.friends.push({ name, online: !!online });
  else if (online!==null) state.friends[idx].online = !!online;
  saveState(state);
}
function setRequests(list){
  state.requests = Array.from(new Set(list || []));
  saveState(state);
}
function addChatMsg(friend, msg){
  state.chats[friend] = state.chats[friend] || [];
  state.chats[friend].push(msg);
  if (state.chats[friend].length > 400) state.chats[friend].shift();
  saveState(state);
}
function timeNow(){
  return new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
}

// ---- UI Renders
function renderMe(){
  meNameEl.textContent = state.username || 'me';
  meAvatar.textContent = initials(state.username || '?');
}
function renderFriends(){
  friendsList.innerHTML = '';
  const sorted = [...state.friends].sort((a,b)=> Number(b.online)-Number(a.online) || a.name.localeCompare(b.name));
  for(const f of sorted){
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot' + (f.online ? ' online' : '');
    const av = document.createElement('div');
    av.className = 'avatar';
    av.textContent = initials(f.name);
    const label = document.createElement('div');
    label.innerHTML = `<div style="font-weight:700">${f.name}</div><div class="muted" style="font-size:12px">${f.online?'online':'offline'}</div>`;
    li.appendChild(dot);
    li.appendChild(av);
    li.appendChild(label);
    if (activeFriend === f.name) {
      const tag = document.createElement('div');
      tag.className = 'badge';
      tag.textContent = 'active';
      li.appendChild(tag);
    }
    li.onclick = () => openChat(f.name);
    friendsList.appendChild(li);
  }
}
function renderRequests(){
  requestsList.innerHTML = '';
  for(const from of state.requests){
    const li = document.createElement('li');
    const av = document.createElement('div'); av.className='avatar'; av.textContent = initials(from);
    const col = document.createElement('div');
    col.innerHTML = `<div style="font-weight:700">${from}</div><div class="muted" style="font-size:12px">wants to be friends</div>`;
    const accept = document.createElement('button'); accept.className='btn xs'; accept.textContent='Accept';
    const decline = document.createElement('button'); decline.className='btn xs subtle'; decline.textContent='Decline';
    accept.onclick = e => { e.stopPropagation(); socket.emit('respond friend request', { from, accepted: true }); };
    decline.onclick = e => { e.stopPropagation(); socket.emit('respond friend request', { from, accepted: false }); };
    li.appendChild(av); li.appendChild(col); li.appendChild(accept); li.appendChild(decline);
    requestsList.appendChild(li);
  }
}
function renderMessages(){
  messagesEl.innerHTML = '';
  if (!activeFriend){
    const empty = document.createElement('div'); empty.className='empty';
    empty.innerHTML = `<div class="big">💬</div><div>No conversation selected</div>`;
    messagesEl.appendChild(empty);
    chatTitle.textContent = 'No conversation';
    chatStatus.textContent = '';
    headerActions.innerHTML = '';
    return;
  }
  chatTitle.textContent = activeFriend;
  const fObj = state.friends.find(f=>f.name===activeFriend);
  chatStatus.textContent = fObj?.online ? 'online' : 'offline';
  headerActions.innerHTML = '';
  const clearBtn = document.createElement('button'); clearBtn.className='btn xs subtle'; clearBtn.textContent='Clear Local';
  clearBtn.onclick = () => { state.chats[activeFriend]=[]; saveState(state); renderMessages(); };
  headerActions.appendChild(clearBtn);

  const history = state.chats[activeFriend] || [];
  for(const m of history){
    const row = document.createElement('div'); row.className='msg';
    const av = document.createElement('div'); av.className='avatar'; av.textContent = initials(m.from);
    const bubble = document.createElement('div'); bubble.className='bubble';
    const meta = document.createElement('div'); meta.className='meta'; meta.textContent = `${m.from} • ${m.time || timeNow()}`;
    const text = document.createElement('div'); text.textContent = m.text;
    bubble.appendChild(meta); bubble.appendChild(text);
    row.appendChild(av); row.appendChild(bubble);
    messagesEl.appendChild(row);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function openChat(friend){
  activeFriend = friend;
  renderFriends();
  renderMessages();
  typingEl.textContent = '';
}

// ---- Login / Logout
function attemptLogin(name){
  return new Promise((resolve) => {
    socket.emit('set username', name, (res) => resolve(res));
  });
}
async function doLoginFlow(name){
  loginErr.textContent = '';
  const res = await attemptLogin(name);
  if (!res?.success){
    loginErr.textContent = res?.message || 'Login failed';
    return;
  }
  state.username = name;
  // Merge server-returned friends + requests into local
  for(const f of (res.friends || [])) upsertFriend(f, true); // server knows these, mark online (they are online if server knows? can be refined by online/offline events)
  setRequests(res.requests || []);
  saveState(state);
  renderMe();
  renderFriends();
  renderRequests();
  loginScreen.classList.add('hidden');
  app.classList.remove('hidden');
  if (!activeFriend && state.friends.length) openChat(state.friends[0].name);
}
loginBtn.addEventListener('click', () => {
  const name = (usernameInput.value||'').trim();
  if (!name){ loginErr.textContent = 'Enter a username'; return; }
  doLoginFlow(name);
});
logoutBtn.addEventListener('click', () => {
  // Keep username in localStorage (so we auto-rejoin), but you can clear if desired:
  // state.username = null;
  saveState(state);
  location.reload();
});

// Auto rejoin if we have a username saved
window.addEventListener('load', () => {
  renderMe();
  renderFriends();
  renderRequests();
  renderMessages();
  if (state.username){
    usernameInput.value = state.username;
    doLoginFlow(state.username);
  }
});

// ---- Modal (New DM)
function openModal(){ modal.classList.remove('hidden'); addUsername.value=''; modalMsg.textContent=''; addUsername.focus(); }
function closeModal(){ modal.classList.add('hidden'); }
newDmBtn.addEventListener('click', openModal);
modalClose.addEventListener('click', closeModal);
modal.addEventListener('click', (e)=>{ if (e.target===modal) closeModal(); });
sendReqBtn.addEventListener('click', ()=>{
  const target = (addUsername.value||'').trim();
  if (!target){ toast('Enter a username','error'); return; }
  if (target===state.username){ toast("You can't add yourself",'error'); return; }
  socket.emit('send friend request', target);
  toast('Request sent','ok');
});

// ---- Composer
composer.addEventListener('submit', (e)=>{
  e.preventDefault();
  const text = (input.value||'').trim();
  if (!text || !activeFriend) return;
  const msg = { from: state.username, text, time: timeNow() };
  addChatMsg(activeFriend, msg);
  renderMessages();
  socket.emit('private message', { to: activeFriend, text });
  input.value = '';
  // stop typing
  socket.emit('pm typing', { to: activeFriend, typing: false });
});

// Typing indicator (per DM)
let typingLocalTimer = null;
input.addEventListener('input', ()=>{
  if (!activeFriend) return;
  socket.emit('pm typing', { to: activeFriend, typing: input.value.length>0 });
  clearTimeout(typingLocalTimer);
  typingLocalTimer = setTimeout(()=>{
    socket.emit('pm typing', { to: activeFriend, typing: false });
  }, 1200);
});

// ---- Socket events from server
socket.on('friend request', (from)=>{
  if (!state.requests.includes(from)) state.requests.push(from);
  saveState(state);
  renderRequests();
});

socket.on('friend requests', (list)=>{
  setRequests(list||[]);
  renderRequests();
});

socket.on('friend accepted', (friendName)=>{
  upsertFriend(friendName, true);
  saveState(state);
  renderFriends();
  // Auto-open DM on accept
  if (!activeFriend) openChat(friendName);
});

socket.on('friend declined', (from)=>{
  toast(`${from} declined your request`,'error');
});

socket.on('friend online', (name)=>{
  upsertFriend(name, true);
  renderFriends();
});
socket.on('friend offline', (name)=>{
  upsertFriend(name, false);
  renderFriends();
});

// Private messages
socket.on('private message', (pm)=>{
  const friend = (pm.from === state.username) ? activeFriend : pm.from;
  if (!friend) return;
  addChatMsg(friend, { from: pm.from, text: pm.text, time: pm.time || timeNow() });
  if (!activeFriend || activeFriend !== friend){
    // badge could be implemented; for now we just re-render list
  }
  if (activeFriend === friend) renderMessages();
});

// Per-DM typing (requires server to emit 'pm typing' to the other peer)
socket.on('pm typing', ({ from, typing })=>{
  if (!activeFriend || activeFriend !== from) return;
  typingEl.textContent = typing ? `${from} is typing…` : '';
  if (typing){
    clearTimeout(typingTimers[from]);
    typingTimers[from] = setTimeout(()=> typingEl.textContent='', 1500);
  }
});

// ---- Small UX niceties
document.addEventListener('keydown', (e)=>{
  if (e.key==='Escape' && !modal.classList.contains('hidden')) closeModal();
});
