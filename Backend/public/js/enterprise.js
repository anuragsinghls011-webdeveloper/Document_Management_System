(() => {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function initLenis() {
    if (reduceMotion || !window.Lenis) return null;
    try {
      const lenis = new window.Lenis({
        duration: 1.2,
        easing: t => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
        smoothWheel: true,
        smoothTouch: false
      });

      function raf(time) {
        lenis.raf(time);
        requestAnimationFrame(raf);
      }

      requestAnimationFrame(raf);
      return lenis;
    } catch (error) {
      return null;
    }
  }

  function mountCursorGlow() {
    const glow = document.createElement('div');
    glow.className = 'cursor-glow';
    document.body.appendChild(glow);

    let rafId = 0;
    let latest = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

    window.addEventListener('pointermove', event => {
      latest = { x: event.clientX, y: event.clientY };
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        glow.style.setProperty('--x', `${latest.x}px`);
        glow.style.setProperty('--y', `${latest.y}px`);
        rafId = 0;
      });
    }, { passive: true });
  }

  function createParticles(target = document.body, count = 18) {
    if (reduceMotion) return;

    const host = typeof target === 'string' ? document.querySelector(target) : target;
    if (!host) return;

    const particles = document.createElement('div');
    particles.style.position = 'absolute';
    particles.style.inset = '0';
    particles.style.pointerEvents = 'none';
    particles.style.overflow = 'hidden';
    particles.setAttribute('aria-hidden', 'true');

    for (let index = 0; index < count; index += 1) {
      const particle = document.createElement('span');
      particle.className = 'particle';
      particle.style.left = `${Math.random() * 100}%`;
      particle.style.top = `${Math.random() * 100}%`;
      particle.style.animationDelay = `${Math.random() * 8}s`;
      particle.style.animationDuration = `${10 + Math.random() * 12}s`;
      particle.style.opacity = String(0.25 + Math.random() * 0.65);
      particle.style.transform = `scale(${0.7 + Math.random() * 1.4})`;
      particles.appendChild(particle);
    }

    host.style.position = host.style.position || 'relative';
    host.appendChild(particles);
  }

  function observeReveal() {
    const items = document.querySelectorAll('.reveal, .reveal-up, .reveal-fade, .stagger-item, .float-item, [data-reveal]');
    if (!items.length) return;

    if (reduceMotion || !('IntersectionObserver' in window)) {
      items.forEach(item => item.classList.add('is-visible'));
      return;
    }

    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.14, rootMargin: '0px 0px -8% 0px' });

    items.forEach(item => observer.observe(item));
  }

  function animateCounters() {
    const counters = document.querySelectorAll('[data-countup]');
    if (!counters.length) return;

    const run = element => {
      const toValue = Number(element.dataset.countup || 0);
      const suffix = element.dataset.suffix || '';
      const prefix = element.dataset.prefix || '';
      const duration = Number(element.dataset.duration || 1200);
      const start = performance.now();

      function frame(now) {
        const progress = Math.min(1, (now - start) / duration);
        const value = Math.round(toValue * (1 - Math.pow(1 - progress, 3)));
        element.textContent = `${prefix}${value.toLocaleString()}${suffix}`;
        if (progress < 1) requestAnimationFrame(frame);
      }

      requestAnimationFrame(frame);
    };

    if (reduceMotion || !('IntersectionObserver' in window)) {
      counters.forEach(run);
      return;
    }

    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        run(entry.target);
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.35 });

    counters.forEach(counter => observer.observe(counter));
  }

  function mountMagneticButtons() {
    const buttons = document.querySelectorAll('[data-magnetic], .button, .btn-primary, .btn-secondary, .cta-btn, .submit-btn, .icon-button, .login-btn, .back-btn, .action-btn, .nav-action, .toolbar-button');
    buttons.forEach(button => {
      if (reduceMotion) return;

      let rect = null;

      const handleMove = event => {
        rect = rect || button.getBoundingClientRect();
        const x = ((event.clientX - rect.left) / rect.width - 0.5) * 10;
        const y = ((event.clientY - rect.top) / rect.height - 0.5) * 10;
        button.style.setProperty('--mx', `${x}px`);
        button.style.setProperty('--my', `${y}px`);
        button.classList.add('magnetic');
      };

      const handleLeave = () => {
        rect = null;
        button.style.setProperty('--mx', '0px');
        button.style.setProperty('--my', '0px');
        button.classList.remove('magnetic');
      };

      button.addEventListener('pointermove', handleMove, { passive: true });
      button.addEventListener('pointerleave', handleLeave, { passive: true });
    });
  }

  function mountTiltCards() {
    const cards = document.querySelectorAll('[data-tilt], .card-bg, .feature-card, .metric-card, .metric-card-alt, .panel, .hero-card, .timeline-card, .content-card, .storage-card, .system-card, .ai-panel, .preview-card, .insight-card');
    if (reduceMotion) return;

    cards.forEach(card => {
      let raf = 0;
      let rect = null;

      const reset = () => {
        card.style.transform = '';
        card.style.setProperty('--tilt-x', '0deg');
        card.style.setProperty('--tilt-y', '0deg');
      };

      card.addEventListener('pointerenter', () => {
        rect = card.getBoundingClientRect();
      });

      card.addEventListener('pointermove', event => {
        if (!rect) rect = card.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width - 0.5;
        const y = (event.clientY - rect.top) / rect.height - 0.5;
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          card.style.transform = `perspective(1200px) rotateX(${(-y * 4).toFixed(2)}deg) rotateY(${(x * 5).toFixed(2)}deg) translateY(-4px)`;
        });
      }, { passive: true });

      card.addEventListener('pointerleave', () => {
        rect = null;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        reset();
      });
    });
  }

  function mountParticles() {
    const hosts = document.querySelectorAll('[data-particles], .main-container, .hero-shell, .auth-shell, .page-shell');
    hosts.forEach((host, index) => createParticles(host, index === 0 ? 22 : 12));
  }

  function mountToasts() {
    const wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    document.body.appendChild(wrap);

    window.saasToast = function saasToast(message, type = 'info', timeout = 3000) {
      const toast = document.createElement('div');
      toast.className = `toast ${type}`;
      toast.innerHTML = `<strong style="display:block;margin-bottom:4px;font-size:0.9rem;">${type === 'success' ? 'Success' : type === 'warning' ? 'Notice' : type === 'danger' ? 'Action required' : 'Information'}</strong><div style="color:var(--muted);font-size:0.9rem;line-height:1.55;">${message}</div>`;
      wrap.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(6px) scale(0.98)';
        setTimeout(() => toast.remove(), 180);
      }, timeout);
    };
  }

  function mountGsapEntrance() {
    if (reduceMotion || !window.gsap) return;

    const tl = window.gsap.timeline({ defaults: { ease: 'power3.out' } });
    tl.from('.header, .admin-header, .topbar, .brand, .hero-card, .panel, .auth-panel, .form-card, .table-panel', {
      opacity: 0,
      y: 18,
      duration: 0.8,
      stagger: 0.04
    });

    tl.from('.hero-title, .dashboard-title, .section-title', {
      opacity: 0,
      y: 14,
      duration: 0.6
    }, '-=0.45');

    tl.from('.button, .btn-primary, .cta-btn, .submit-btn, .icon-button', {
      opacity: 0,
      scale: 0.95,
      duration: 0.45,
      stagger: 0.02
    }, '-=0.45');
  }

  function mountActiveNav() {
    const links = document.querySelectorAll('.nav-link, .sidebar-link, .menu-link, .workflow-link');
    const current = window.location.pathname;
    links.forEach(link => {
      const href = link.getAttribute('href');
      if (!href) return;
      if (href === current || (current !== '/' && current.startsWith(href) && href !== '/')) {
        link.classList.add('active');
      }
    });
  }

  function init() {
    document.documentElement.classList.add('js-ready');
    mountCursorGlow();
    initLenis();
    mountParticles();
    observeReveal();
    animateCounters();
    mountMagneticButtons();
    mountTiltCards();
    mountToasts();
    mountGsapEntrance();
    mountActiveNav();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
