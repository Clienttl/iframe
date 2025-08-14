const socket = io();

// --- DOM ---
const loginScreen = document.getElementById('login-screen');
const chatScreen  = document.getElementById('chat-screen');
const usernameIn  = document.getElementById('username-input');
const adminCodeIn = document.getElementById('admin-code');
const loginBtn    = document.getElementById('login-btn');
const loginErr    = document.getElementById('login-error');

const friendsUL   = document.getElementById('friends');
const requestsUL  = document.getElementById('requests');
const addFriendIn = document.getElementById('add-friend');
const sendFriendBtn = document.getElementById('send-friend-btn');

const messagesEl  = document.getElementById('messages');
const typingEl    = document.getElementById('typing-indicator');
const form        = document.getElementById('message-form');
const input       = document.getElementById('message-input');

const adminPanel  = document.getElementById('admin-panel');
const adminUsers  = document.getElementById('online-users');

// --- State ---
let username = null;
let activeFriend = null;
let friends = [];
let requests = [];
let chats = {};
let isAdmin = false;

// --- Helpers ---
const initials = s=>s.slice(0,2).toUpperCase();
const nowTime = ()=>new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
const keyPair = (a,b)=>[a,b].sort().join('|');
function renderFriends(){
  friendsUL.innerHTML='';
  friends.forEach(f=>{
    const li = document.createElement('li');
    const av = document.createElement('div'); av.className='avatar'; av.textContent=initials(f);
    li.textContent=f; li.prepend(av);
    li.onclick = ()=>{ activeFriend=f; renderMessages(); };
    friendsUL.appendChild(li);
  });
}
function renderRequests(){
  requestsUL.innerHTML='';
  requests.forEach(r=>{
    const li = document.createElement('li'); li.textContent=r;
    const accept = document.createElement('button'); accept.textContent='Accept'; accept.className='btn xs';
    const decline= document.createElement('button'); decline.textContent='Decline'; decline.className='btn xs';
    accept.onclick = e=>{ e.stopPropagation(); socket.emit('respond friend request',{from:r,accepted:true}); };
    decline.onclick= e=>{ e.stopPropagation(); socket.emit('respond friend request',{from:r,accepted:false}); };
    li.appendChild(accept); li.appendChild(decline);
    requestsUL.appendChild(li);
  });
}
function renderMessages(){
  messagesEl.innerHTML='';
  if(!activeFriend) return;
  const hist = chats[activeFriend]||[];
  hist.forEach(m=>{
    const row=document.createElement('div'); row.className='msg'+(m.from===username?' mine':'');
    const av = document.createElement('div'); av.className='avatar'; av.textContent=initials(m.from);
    const bubble = document.createElement('div'); bubble.className='bubble';
    const meta = document.createElement('div'); meta.className='meta'; meta.textContent=`${m.from} • ${m.time||nowTime()}`;
    const text = document.createElement('div'); text.textContent=m.text;
    bubble.appendChild(meta); bubble.appendChild(text);
    row.appendChild(av); row.appendChild(bubble);
    messagesEl.appendChild(row);
  });
  messagesEl.scrollTop=messagesEl.scrollHeight;
}

// --- Login ---
loginBtn.addEventListener('click', async()=>{
  const name=usernameIn.value.trim();
  const code=adminCodeIn.value.trim();
  if(!name){ loginErr.textContent='Enter username'; return; }
  socket.emit('set username',{name,code}, res=>{
    if(!res.success){ loginErr.textContent=res.message; return; }
    username=name; isAdmin=res.isAdmin; friends=res.friends||[]; requests=res.requests||[];
    loginScreen.classList.add('hidden'); chatScreen.classList.remove('hidden');
    if(isAdmin) adminPanel.classList.remove('hidden');
    renderFriends(); renderRequests();
  });
});

// --- Friend ---
sendFriendBtn.addEventListener('click',()=>{
  const f=addFriendIn.value.trim(); if(!f) return;
  socket.emit('send friend request',f); addFriendIn.value='';
});

// --- Chat ---
form.addEventListener('submit',e=>{ e.preventDefault(); if(!activeFriend) return;
  const text=input.value.trim(); if(!text) return;
  socket.emit('private message',{to:activeFriend,text}); input.value='';
});
input.addEventListener('input',()=>{ if(!activeFriend) return; socket.emit('pm typing',{to:activeFriend,typing:input.value.length>0}); });

// --- Socket events ---
socket.on('friend request', f=>{ requests.push(f); renderRequests(); });
socket.on('friend requests', list=>{ requests=list||[]; renderRequests(); });
socket.on('friend accepted', f=>{ friends.push(f); renderFriends(); });
socket.on('friend declined', f=>{ requests=requests.filter(r=>r!==f); renderRequests(); });
socket.on('private message', data=>{
  const {from,text,time}=data;
  if(!chats[from]) chats[from]=[];
  chats[from].push({from,text,time});
  if(activeFriend===from) renderMessages();
});
socket.on('pm typing', ({from,typing})=>{
  typingEl.textContent=typing?`${from} is typing...`:'';
});
socket.on('admin data', data=>{
  if(!isAdmin) return;
  adminUsers.innerHTML=data.map(u=>`<div>${u}</div>`).join('');
});

// --- LocalStorage restore ---
const stored = localStorage.getItem('chatData');
if(stored){
  const s = JSON.parse(stored);
  chats=s.chats||{};
  friends=s.friends||[];
}
window.addEventListener('beforeunload',()=>{ localStorage.setItem('chatData',JSON.stringify({chats,friends})); });
