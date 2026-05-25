(() => {
  const MOBILE_QUERY = '(max-width: 860px)';
  const media = window.matchMedia(MOBILE_QUERY);

  function $(id) { return document.getElementById(id); }

  function appEl() { return $('app'); }

  function setViewportUnit() {
    document.documentElement.style.setProperty('--gaycord-vh', `${window.innerHeight * 0.01}px`);
  }

  function ensureOverlay() {
    const app = appEl();
    if (!app) return null;
    let overlay = $('mobileOverlay');
    if (!overlay) {
      overlay = document.createElement('button');
      overlay.id = 'mobileOverlay';
      overlay.type = 'button';
      overlay.className = 'mobile-overlay';
      overlay.setAttribute('aria-label', 'Mobil paneli kapat');
      app.prepend(overlay);
    }
    overlay.addEventListener('click', closePanels);
    return overlay;
  }

  function setExpanded() {
    const app = appEl();
    $('mobileMenuButton')?.setAttribute('aria-expanded', String(Boolean(app?.classList.contains('mobile-sidebar-open'))));
    $('mobileMembersButton')?.setAttribute('aria-expanded', String(Boolean(app?.classList.contains('mobile-members-open'))));
  }

  function closePanels() {
    const app = appEl();
    if (!app) return;
    app.classList.remove('mobile-sidebar-open', 'mobile-members-open');
    setExpanded();
  }

  function toggleSidebar() {
    const app = appEl();
    if (!app) return;
    const willOpen = !app.classList.contains('mobile-sidebar-open');
    app.classList.remove('mobile-members-open');
    app.classList.toggle('mobile-sidebar-open', willOpen);
    setExpanded();
  }

  function toggleMembers() {
    const app = appEl();
    if (!app) return;
    const willOpen = !app.classList.contains('mobile-members-open');
    app.classList.remove('mobile-sidebar-open');
    app.classList.toggle('mobile-members-open', willOpen);
    setExpanded();
  }

  function closeAfterNavigation(event) {
    if (!media.matches) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const shouldClose = target.closest('.channel-main, button.user-row, .server-dot, #homeButton');
    if (shouldClose) setTimeout(closePanels, 40);
  }

  function focusComposerAfterKeyboard() {
    if (!media.matches) return;
    const messages = $('messages');
    if (messages) setTimeout(() => { messages.scrollTop = messages.scrollHeight; }, 120);
  }

  function bind() {
    ensureOverlay();
    $('mobileMenuButton')?.addEventListener('click', toggleSidebar);
    $('mobileMembersButton')?.addEventListener('click', toggleMembers);
    $('dynamicPanel')?.addEventListener('click', closeAfterNavigation);
    $('serverDots')?.addEventListener('click', closeAfterNavigation);
    $('homeButton')?.addEventListener('click', closeAfterNavigation);
    $('messageInput')?.addEventListener('focus', focusComposerAfterKeyboard);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closePanels();
    });

    window.addEventListener('resize', () => {
      setViewportUnit();
      if (!media.matches) closePanels();
    }, { passive: true });

    window.addEventListener('orientationchange', () => {
      setTimeout(setViewportUnit, 120);
      setTimeout(focusComposerAfterKeyboard, 160);
    }, { passive: true });

    setViewportUnit();
    setExpanded();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  window.GaycordMobile = { closePanels, toggleSidebar, toggleMembers };
})();
