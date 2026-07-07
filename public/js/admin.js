// ── Admin Login Logic ──
document.addEventListener('DOMContentLoaded', () => {
  // Check if already logged in
  fetch('/api/admin/check')
    .then(r => r.json())
    .then(data => {
      if (data.isAdmin) window.location.href = '/dashboard';
    });

  const form = document.getElementById('loginForm');
  const errorEl = document.getElementById('loginError');
  const btn = document.getElementById('loginBtn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.classList.remove('visible');

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    if (!username || !password) return;

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await res.json();

      if (data.success) {
        // Smooth transition to dashboard
        document.querySelector('.login-container').style.opacity = '0';
        document.querySelector('.login-container').style.transform = 'translateY(-20px)';
        document.querySelector('.login-container').style.transition = 'all 400ms ease-out';
        setTimeout(() => window.location.href = '/dashboard', 400);
      } else {
        throw new Error(data.error);
      }
    } catch (err) {
      errorEl.textContent = err.message || 'Invalid credentials';
      errorEl.classList.add('visible');
      btn.disabled = false;
      btn.innerHTML = 'Sign In';

      // Shake animation
      const card = document.querySelector('.login-card');
      card.style.animation = 'none';
      card.offsetHeight; // trigger reflow
      card.style.animation = 'shake 400ms ease-out';
    }
  });
});

// Shake keyframe injected via JS
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
