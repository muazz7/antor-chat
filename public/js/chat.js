// ── Chat Logic ──

document.addEventListener('DOMContentLoaded', () => {
  const slug = window.location.pathname.split('/chat/')[1];
  if (!slug) return;

  let socket = null;
  let currentSender = '';
  let currentRole = '';
  let typingTimeout = null;

  // Elements
  const authGate = document.getElementById('authGate');
  const chatInterface = document.getElementById('chatInterface');
  const roomLabel = document.getElementById('roomLabel');
  const chatAuthForm = document.getElementById('chatAuthForm');
  const chatAuthError = document.getElementById('chatAuthError');
  const chatAuthBtn = document.getElementById('chatAuthBtn');
  const chatRoomName = document.getElementById('chatRoomName');
  const chatMessages = document.getElementById('chatMessages');
  const messageInput = document.getElementById('messageInput');
  const sendBtn = document.getElementById('sendBtn');
  const leaveChatBtn = document.getElementById('leaveChatBtn');
  const typingIndicator = document.getElementById('typingIndicator');
  const chatStatus = document.getElementById('chatStatus');

  // ── Load Room Info ──
  async function loadRoomInfo() {
    try {
      const res = await fetch(`/api/rooms/${slug}/info`);
      const data = await res.json();
      if (data.name) {
        roomLabel.textContent = data.name;
      } else {
        roomLabel.textContent = 'Room not found';
      }
    } catch {
      roomLabel.textContent = 'Room not found';
    }
  }

  loadRoomInfo();

  // ── Auth Form ──
  chatAuthForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    chatAuthError.classList.remove('visible');

    const displayName = document.getElementById('chatDisplayName').value.trim();
    const userId = document.getElementById('chatUserId').value.trim();
    const password = document.getElementById('chatPassword').value;

    if (!displayName || !userId || !password) return;

    chatAuthBtn.disabled = true;
    chatAuthBtn.innerHTML = '<span class="spinner"></span>';

    try {
      const res = await fetch(`/api/rooms/${slug}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, password })
      });

      const data = await res.json();

      if (data.success) {
        // Store per-tab chat token (sessionStorage is per-tab, cleared on close)
        if (data.chatToken) {
          sessionStorage.setItem('chatToken_' + slug, data.chatToken);
        }
        enterChat(displayName, 'guest');
      } else {
        throw new Error(data.error);
      }
    } catch (err) {
      chatAuthError.textContent = err.message || 'Invalid credentials';
      chatAuthError.classList.add('visible');
      chatAuthBtn.disabled = false;
      chatAuthBtn.innerHTML = 'Join Chat';

      // Shake
      const card = document.querySelector('.chat-auth-card');
      card.style.animation = 'none';
      card.offsetHeight;
      card.style.animation = 'shake 400ms ease-out';
    }
  });

  // ── Enter Chat ──
  async function enterChat(sender, role) {
    currentSender = sender;
    currentRole = role;

    // Transition
    authGate.style.opacity = '0';
    authGate.style.transform = 'translateY(-20px)';
    authGate.style.transition = 'all 400ms ease-out';

    setTimeout(async () => {
      authGate.style.display = 'none';
      chatInterface.style.display = '';
      chatInterface.style.opacity = '0';
      chatInterface.style.animation = 'fadeIn 400ms ease-out forwards';

      // Lock body scroll completely when chat is active (prevents iOS keyboard scroll)
      document.documentElement.style.overflow = 'hidden';
      document.body.style.overflow = 'hidden';
      document.body.style.position = 'fixed';
      document.body.style.width = '100%';
      document.body.style.height = '100%';

      // Set room name
      chatRoomName.textContent = roomLabel.textContent;

      // Load message history
      await loadMessages();

      // Connect Socket.io
      connectSocket();

      // Focus input
      messageInput.focus();
    }, 400);
  }

  // ── Load Messages ──
  async function loadMessages() {
    try {
      const chatToken = sessionStorage.getItem('chatToken_' + slug);
      const tokenParam = chatToken ? `?chat_token=${encodeURIComponent(chatToken)}` : '';
      const res = await fetch(`/api/rooms/${slug}/messages${tokenParam}`);
      const messages = await res.json();
      // Clear messages but keep the typing indicator
      chatMessages.innerHTML = '';
      chatMessages.appendChild(typingIndicator);
      messages.forEach(msg => appendMessage(msg, false));
      scrollToBottom();
    } catch {}
  }

  // ── Socket.io ──
  function connectSocket() {
    socket = io();

    socket.on('connect', () => {
      chatStatus.textContent = 'Connected';
      socket.emit('join-room', {
        slug,
        sender: currentSender,
        senderRole: currentRole
      });
    });

    socket.on('disconnect', () => {
      chatStatus.textContent = 'Reconnecting...';
    });

    socket.on('new-message', (msg) => {
      appendMessage(msg, true);
      scrollToBottom();
    });

    socket.on('user-joined', (data) => {
      addSystemMessage(`${data.sender} joined the chat`);
    });

    socket.on('user-left', (data) => {
      addSystemMessage(`${data.sender} left the chat`);
    });

    socket.on('user-typing', () => {
      typingIndicator.classList.add('visible');
    });

    socket.on('user-stop-typing', () => {
      typingIndicator.classList.remove('visible');
    });
  }

  // ── Append Message ──
  function appendMessage(msg, animate) {
    const isSent = msg.sender === currentSender;
    const div = document.createElement('div');
    div.className = `message ${isSent ? 'sent' : 'received'}${animate ? ' animated' : ''}`;

    // Ensure UTC timestamps from DB (without Z suffix) are parsed correctly
    const rawDate = msg.createdAt;
    const dateStr = rawDate.endsWith('Z') || rawDate.includes('+') ? rawDate : rawDate + 'Z';
    const time = new Date(dateStr).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit'
    });

    div.innerHTML = `
      <div class="message-bubble">${escapeHtml(msg.content)}</div>
      <div class="message-meta">
        <span class="message-sender">${escapeHtml(msg.sender)}</span>
        <span>·</span>
        <span>${time}</span>
      </div>
    `;
    chatMessages.insertBefore(div, typingIndicator);
  }

  // ── System Message ──
  function addSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'system-message';
    div.textContent = text;
    chatMessages.insertBefore(div, typingIndicator);
    scrollToBottom();
  }

  // ── Send Message ──
  function sendMessage() {
    const content = messageInput.value.trim();
    if (!content || !socket) return;

    socket.emit('send-message', { content });
    messageInput.value = '';
    socket.emit('stop-typing');

    // Blur to dismiss keyboard on mobile after sending
    messageInput.blur();

    // Scroll to bottom after sending
    scrollToBottom();
  }

  sendBtn.addEventListener('click', sendMessage);
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendMessage();
    }
  });

  // ── Typing Events ──
  messageInput.addEventListener('input', () => {
    if (!socket) return;
    socket.emit('typing');
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      socket.emit('stop-typing');
    }, 1500);
  });

  // ── Leave Chat ──
  leaveChatBtn.addEventListener('click', () => {
    if (socket) socket.disconnect();
    chatInterface.style.opacity = '0';
    chatInterface.style.transition = 'opacity 300ms ease-out';
    setTimeout(() => window.location.href = '/', 300);
  });

  // ── Scroll ──
  function scrollToBottom() {
    // Use a double rAF + small delay to ensure DOM is fully updated
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        chatMessages.scrollTop = chatMessages.scrollHeight;
      });
    });
  }

  // ── Escape HTML ──
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Mobile Keyboard Handler ──
  // With resizes-visual, only the visual viewport shrinks when keyboard opens.
  // We manually resize the chat container to match the visual viewport.
  if (window.visualViewport) {
    let pendingViewportUpdate = false;

    function onViewportResize() {
      if (!chatInterface || chatInterface.style.display === 'none') return;
      if (pendingViewportUpdate) return;
      pendingViewportUpdate = true;

      requestAnimationFrame(() => {
        pendingViewportUpdate = false;
        const vv = window.visualViewport;

        // Always pin to top-left of the viewport
        chatInterface.style.position = 'fixed';
        chatInterface.style.top = '0';
        chatInterface.style.left = '0';
        chatInterface.style.width = '100%';
        chatInterface.style.height = vv.height + 'px';

        // Kill any native page scroll that iOS does to "show" the focused input
        window.scrollTo(0, 0);
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;

        scrollToBottom();
      });
    }

    window.visualViewport.addEventListener('resize', onViewportResize);
    window.visualViewport.addEventListener('scroll', onViewportResize);
  }

  // When the input is focused, fight the native scroll and keep input above keyboard
  messageInput.addEventListener('focus', () => {
    // The keyboard takes time to animate open — keep resetting scroll during that time
    const fixScroll = () => {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      scrollToBottom();
    };
    // Fire at multiple points during the keyboard animation
    setTimeout(fixScroll, 50);
    setTimeout(fixScroll, 150);
    setTimeout(fixScroll, 300);
    setTimeout(fixScroll, 500);
  });

  // ── Dismiss keyboard on scroll ──
  // Use touchmove (actual scrolling gesture) instead of touchstart (just tapping)
  let touchStartY = 0;
  chatMessages.addEventListener('touchstart', (e) => {
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  chatMessages.addEventListener('touchmove', (e) => {
    const deltaY = Math.abs(e.touches[0].clientY - touchStartY);
    // Only dismiss if user actually scrolled (moved more than 10px)
    if (deltaY > 10 && document.activeElement === messageInput) {
      messageInput.blur();
    }
  }, { passive: true });
});

// Shake keyframe
const style = document.createElement('style');
style.textContent = `
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    20% { transform: translateX(-8px); }
    40% { transform: translateX(8px); }
    60% { transform: translateX(-4px); }
    80% { transform: translateX(4px); }
  }
`;
document.head.appendChild(style);
