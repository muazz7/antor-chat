// ── Dashboard Logic ──

document.addEventListener('DOMContentLoaded', () => {
  // Auth check
  fetch('/api/admin/check')
    .then(r => r.json())
    .then(data => {
      if (!data.isAdmin) window.location.href = '/';
    });

  // Elements
  const tabCreate = document.getElementById('tabCreate');
  const tabRooms = document.getElementById('tabRooms');
  const tabTrash = document.getElementById('tabTrash');
  const createSection = document.getElementById('createSection');
  const roomsSection = document.getElementById('roomsSection');
  const trashSection = document.getElementById('trashSection');
  const createForm = document.getElementById('createForm');
  const generateBtn = document.getElementById('generateBtn');
  const generatedLink = document.getElementById('generatedLink');
  const linkUrl = document.getElementById('linkUrl');
  const copyLinkBtn = document.getElementById('copyLinkBtn');
  const roomsList = document.getElementById('roomsList');
  const roomsEmpty = document.getElementById('roomsEmpty');
  const trashList = document.getElementById('trashList');
  const trashEmpty = document.getElementById('trashEmpty');
  const editModal = document.getElementById('editModal');
  const editForm = document.getElementById('editForm');
  const cancelEditBtn = document.getElementById('cancelEditBtn');
  const confirmModal = document.getElementById('confirmModal');
  const confirmTitle = document.getElementById('confirmTitle');
  const confirmMessage = document.getElementById('confirmMessage');
  const confirmOkBtn = document.getElementById('confirmOkBtn');
  const confirmCancelBtn = document.getElementById('confirmCancelBtn');
  const logoutBtn = document.getElementById('logoutBtn');

  const allTabs = [tabCreate, tabRooms, tabTrash];
  const allSections = { create: createSection, rooms: roomsSection, trash: trashSection };

  // ── Tabs ──
  function switchTab(tab) {
    allTabs.forEach(t => t.classList.remove('active'));
    Object.values(allSections).forEach(s => s.style.display = 'none');

    if (tab === 'create') {
      tabCreate.classList.add('active');
      createSection.style.display = '';
    } else if (tab === 'rooms') {
      tabRooms.classList.add('active');
      roomsSection.style.display = '';
      loadRooms();
    } else if (tab === 'trash') {
      tabTrash.classList.add('active');
      trashSection.style.display = '';
      loadTrash();
    }
  }

  tabCreate.addEventListener('click', () => switchTab('create'));
  tabRooms.addEventListener('click', () => switchTab('rooms'));
  tabTrash.addEventListener('click', () => switchTab('trash'));

  // ── Create Room ──
  createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('roomName').value.trim();
    const userId = document.getElementById('roomUserId').value.trim();
    const password = document.getElementById('roomPassword').value;

    if (!name || !userId || !password) return;

    generateBtn.disabled = true;
    generateBtn.innerHTML = '<span class="spinner"></span>';

    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, userId, password })
      });

      const data = await res.json();

      if (data.success) {
        const fullLink = window.location.origin + data.room.link;
        linkUrl.textContent = fullLink;
        generatedLink.classList.add('visible');
        showToast('Room created successfully!', 'success');
        createForm.reset();
      } else {
        throw new Error(data.error);
      }
    } catch (err) {
      showToast(err.message || 'Failed to create room', 'error');
    } finally {
      generateBtn.disabled = false;
      generateBtn.innerHTML = 'Generate Link';
    }
  });

  // ── Copy to Clipboard Helper (works on HTTP too) ──
  function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    // Fallback for non-HTTPS
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      document.execCommand('copy');
    } catch (err) {
      console.error('Copy failed', err);
    }
    document.body.removeChild(textarea);
    return Promise.resolve();
  }

  // ── Copy Link ──
  copyLinkBtn.addEventListener('click', () => {
    const text = linkUrl.textContent;
    copyToClipboard(text).then(() => {
      copyLinkBtn.textContent = 'Copied!';
      setTimeout(() => copyLinkBtn.textContent = 'Copy', 2000);
    });
  });

  // ═══════════════════════════════════
  // ACTIVE ROOMS
  // ═══════════════════════════════════

  async function loadRooms() {
    try {
      const res = await fetch('/api/rooms');
      const rooms = await res.json();

      if (rooms.length === 0) {
        roomsList.innerHTML = '';
        roomsEmpty.style.display = '';
        return;
      }

      roomsEmpty.style.display = 'none';
      roomsList.innerHTML = rooms.map((room, i) => `
        <div class="room-card glass-card" style="animation-delay: ${i * 80}ms"
             data-room-id="${room.id}" data-room-slug="${room.slug}" data-room-userid="${escapeAttr(room.userId)}">
          <div class="room-info">
            <div class="room-name">${escapeHtml(room.name)}</div>
            <div class="room-meta">
              <span><span class="user-id-label">ID:</span> ${escapeHtml(room.userId)}</span>
              <span>Created: ${formatDate(room.createdAt)}</span>
              ${room.updatedAt !== room.createdAt ? `<span>Updated: ${formatDate(room.updatedAt)}</span>` : ''}
            </div>
          </div>
          <div class="room-actions">
            <button class="btn btn-secondary btn-sm action-copy-link">
              Copy Link
            </button>
            <button class="btn btn-primary btn-sm action-show">
              Show
            </button>
            <button class="btn btn-secondary btn-sm action-edit">
              Edit
            </button>
            <button class="btn btn-danger btn-sm action-delete">
              Delete
            </button>
          </div>
        </div>
      `).join('');
    } catch (err) {
      showToast('Failed to load rooms', 'error');
    }
  }

  // Event delegation for room actions
  roomsList.addEventListener('click', async (e) => {
    const card = e.target.closest('.room-card');
    if (!card) return;
    const roomId = card.dataset.roomId;
    const slug = card.dataset.roomSlug;
    const userId = card.dataset.roomUserid;

    if (e.target.closest('.action-copy-link')) {
      const link = window.location.origin + '/chat/' + slug;
      copyToClipboard(link).then(() => {
        showToast('Link copied to clipboard!', 'success');
      });
    }

    if (e.target.closest('.action-show')) {
      const btn = e.target.closest('.action-show');
      btn.disabled = true;
      btn.textContent = '...';
      try {
        const res = await fetch(`/api/admin/chat-entry/${slug}`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          window.location.href = `/chat/${slug}?admin_entry=${data.token}`;
        } else {
          showToast(data.error || 'Failed to open room', 'error');
          btn.disabled = false;
          btn.textContent = 'Show';
        }
      } catch (err) {
        showToast('Failed to open room', 'error');
        btn.disabled = false;
        btn.textContent = 'Show';
      }
    }

    if (e.target.closest('.action-edit')) {
      openEditModal(roomId, userId);
    }

    if (e.target.closest('.action-delete')) {
      softDeleteRoom(roomId);
    }
  });

  // Soft delete → moves to recycle bin
  function softDeleteRoom(roomId) {
    showConfirm(
      'Move to Recycle Bin',
      'The chat link will be disabled until restored. You can recover this room from the Recycle Bin at any time.',
      'Move to Bin',
      async () => {
        try {
          const res = await fetch(`/api/rooms/${roomId}`, { method: 'DELETE' });
          const data = await res.json();
          if (data.success) {
            showToast('Room moved to recycle bin', 'success');
            loadRooms();
          } else {
            throw new Error(data.error);
          }
        } catch (err) {
          showToast(err.message || 'Failed to delete room', 'error');
        }
      }
    );
  }

  // ═══════════════════════════════════
  // RECYCLE BIN
  // ═══════════════════════════════════

  async function loadTrash() {
    try {
      const res = await fetch('/api/rooms/trash');
      const rooms = await res.json();

      if (rooms.length === 0) {
        trashList.innerHTML = '';
        trashEmpty.style.display = '';
        return;
      }

      trashEmpty.style.display = 'none';
      trashList.innerHTML = rooms.map((room, i) => `
        <div class="room-card glass-card trash-card" style="animation-delay: ${i * 80}ms"
             data-room-id="${room.id}">
          <div class="room-info">
            <div class="room-name trash-room-name">${escapeHtml(room.name)}</div>
            <div class="room-meta">
              <span><span class="user-id-label">ID:</span> ${escapeHtml(room.userId)}</span>
              <span>Deleted: ${formatDate(room.deletedAt)}</span>
            </div>
          </div>
          <div class="room-actions">
            <button class="btn btn-primary btn-sm action-restore">
              Restore
            </button>
            <button class="btn btn-danger btn-sm action-permanent-delete">
              Delete Forever
            </button>
          </div>
        </div>
      `).join('');
    } catch (err) {
      showToast('Failed to load recycle bin', 'error');
    }
  }

  // Event delegation for trash actions
  trashList.addEventListener('click', (e) => {
    const card = e.target.closest('.room-card');
    if (!card) return;
    const roomId = card.dataset.roomId;

    if (e.target.closest('.action-restore')) {
      restoreRoom(roomId);
    }

    if (e.target.closest('.action-permanent-delete')) {
      permanentDeleteRoom(roomId);
    }
  });

  async function restoreRoom(roomId) {
    try {
      const res = await fetch(`/api/rooms/${roomId}/restore`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast('Room restored successfully!', 'success');
        loadTrash();
      } else {
        throw new Error(data.error);
      }
    } catch (err) {
      showToast(err.message || 'Failed to restore room', 'error');
    }
  }

  function permanentDeleteRoom(roomId) {
    showConfirm(
      'Delete Forever',
      'This will permanently delete this room and all its messages. This action cannot be undone.',
      'Delete Forever',
      async () => {
        try {
          const res = await fetch(`/api/rooms/${roomId}/permanent`, { method: 'DELETE' });
          const data = await res.json();
          if (data.success) {
            showToast('Room permanently deleted', 'success');
            loadTrash();
          } else {
            throw new Error(data.error);
          }
        } catch (err) {
          showToast(err.message || 'Failed to delete room permanently', 'error');
        }
      }
    );
  }

  // ═══════════════════════════════════
  // EDIT MODAL
  // ═══════════════════════════════════

  function openEditModal(roomId, currentUserId) {
    document.getElementById('editRoomId').value = roomId;
    document.getElementById('editUserId').value = '';
    document.getElementById('editUserId').placeholder = `Current: ${currentUserId}`;
    document.getElementById('editPassword').value = '';
    editModal.classList.add('visible');
  }

  cancelEditBtn.addEventListener('click', () => {
    editModal.classList.remove('visible');
  });

  editModal.addEventListener('click', (e) => {
    if (e.target === editModal) editModal.classList.remove('visible');
  });

  editForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const roomId = document.getElementById('editRoomId').value;
    const userId = document.getElementById('editUserId').value.trim();
    const password = document.getElementById('editPassword').value;

    if (!userId && !password) {
      showToast('Please enter at least one field to update', 'error');
      return;
    }

    const body = {};
    if (userId) body.userId = userId;
    if (password) body.password = password;

    try {
      const res = await fetch(`/api/rooms/${roomId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const data = await res.json();
      if (data.success) {
        showToast('Credentials updated successfully!', 'success');
        editModal.classList.remove('visible');
        loadRooms();
      } else {
        throw new Error(data.error);
      }
    } catch (err) {
      showToast(err.message || 'Failed to update', 'error');
    }
  });

  // ── Custom Confirm Modal ──
  let confirmCallback = null;

  function showConfirm(title, message, btnText, onConfirm) {
    confirmTitle.textContent = title;
    confirmMessage.textContent = message;
    confirmOkBtn.textContent = btnText;
    confirmCallback = onConfirm;
    confirmModal.classList.add('visible');
  }

  confirmOkBtn.addEventListener('click', () => {
    confirmModal.classList.remove('visible');
    if (confirmCallback) confirmCallback();
    confirmCallback = null;
  });

  confirmCancelBtn.addEventListener('click', () => {
    confirmModal.classList.remove('visible');
    confirmCallback = null;
  });

  confirmModal.addEventListener('click', (e) => {
    if (e.target === confirmModal) {
      confirmModal.classList.remove('visible');
      confirmCallback = null;
    }
  });

  // ── Logout ──
  logoutBtn.addEventListener('click', async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    document.body.style.opacity = '0';
    document.body.style.transition = 'opacity 300ms ease-out';
    setTimeout(() => window.location.href = '/', 300);
  });

  // ── Session destroyed on refresh / tab close ──
  // This ensures the admin must re-enter credentials every time the dashboard loads.
  window.addEventListener('beforeunload', () => {
    // Use sendBeacon so the request fires even during page unload
    navigator.sendBeacon('/api/admin/logout');
  });

  // ── Toast ──
  window.showToast = (message, type = 'success') => {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('exit');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  };

  // ── Utilities ──
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatDate(dateStr) {
    const date = new Date(dateStr + 'Z');
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
});
