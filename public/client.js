const socket = io();
let username = null;

const loginScreen = document.getElementById('login-screen');
const chatScreen = document.getElementById('chat-screen');
const usernameInput = document.getElementById('username-input');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');

const usersList = document.getElementById('users');
const friendsList = document.getElementById('friends');
const messagesDiv = document.getElementById('messages');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const typingIndicator = document.getElementById('typing-indicator');

loginBtn.onclick = () => {
    const name = usernameInput.value;
    socket.emit('set username', name, (res) => {
        if (res.success) {
            username = name;
            loginScreen.style.display = 'none';
            chatScreen.style.display = 'flex';
            messagesDiv.innerHTML = '';
            res.messages.forEach(addMessage);
        } else {
            loginError.textContent = res.message;
        }
    });
};

// Update online users
socket.on('user list', (users) => {
    usersList.innerHTML = '';
    users.forEach(user => {
        if (user === username) return;
        const li = document.createElement('li');
        li.textContent = user;
        li.onclick = () => socket.emit('send friend request', user);
        usersList.appendChild(li);
    });
});

// Friend request received
socket.on('friend request', (from) => {
    if (confirm(`${from} sent you a friend request. Accept?`)) {
        socket.emit('accept friend request', from);
    }
});

// Friend request accepted
socket.on('friend accepted', (friendName) => {
    alert(`${friendName} is now your friend!`);
    addFriend(friendName);
});

// Add friend to list
function addFriend(name) {
    const li = document.createElement('li');
    li.textContent = name;
    li.onclick = () => {
        const text = prompt(`Message to ${name}:`);
        if (text) {
            socket.emit('private message', { to: name, text });
        }
    };
    friendsList.appendChild(li);
}

// Receive private message
socket.on('private message', (pm) => {
    alert(`Private from ${pm.from}: ${pm.text}`);
});

// Global chat messages
socket.on('chat message', (msg) => {
    addMessage(msg);
});

// Typing indicator
messageInput.addEventListener('input', () => {
    socket.emit('typing', messageInput.value.length > 0);
});
socket.on('typing users', (users) => {
    const others = users.filter(u => u !== username);
    typingIndicator.textContent = others.length ? `${others.join(', ')} is typing...` : '';
});

messageForm.onsubmit = (e) => {
    e.preventDefault();
    if (messageInput.value.trim() !== '') {
        socket.emit('chat message', messageInput.value);
        messageInput.value = '';
        socket.emit('typing', false);
    }
};

function addMessage(msg) {
    const div = document.createElement('div');
    div.textContent = `[${msg.time}] ${msg.username}: ${msg.text}`;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}
