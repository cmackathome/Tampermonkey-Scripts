
// ==UserScript==
// @name         YouTube Player for Twitch (Firefox)
// @namespace    local.ypft.firefox
// @version      2.0.0
// @description  Discover YouTube livestreams and replace Twitch's video area while keeping Twitch chat.
// @match        https://www.twitch.tv/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      www.youtube.com
// ==/UserScript==

(() => {
  'use strict';
  if (window.top !== window.self) return;

  const PREFIX = 'ypftfx';

  const CSS = `
  #${PREFIX}-toolbar {
    display: flex;
    gap: 7px;
    align-items: center;
    flex-wrap: wrap;
    margin: 8px 0;
    font: 13px Arial, sans-serif;
  }

  #${PREFIX}-toolbar button,
  #${PREFIX}-toolbar input {
    box-sizing: border-box;
    border: 1px solid #555;
    border-radius: 5px;
    padding: 8px 10px;
  }

  #${PREFIX}-toolbar button {
    background: #9147ff;
    color: white;
    font-weight: 600;
    cursor: pointer;
  }

  #${PREFIX}-toolbar button:hover {
    background: #772ce8;
  }

  #${PREFIX}-toolbar input {
    flex: 1;
    min-width: 180px;
    background: #0e0e10;
    color: #efeff1;
  }

  #${PREFIX}-status {
    flex-basis: 100%;
    color: #adadb8;
  }

  #${PREFIX}-results {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin: 8px 0;
  }

  #${PREFIX}-results button {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    max-width: 260px;
    text-align: left;
  }

  #${PREFIX}-results small {
    font-weight: normal;
    color: #eee;
    margin-top: 4px;
  }

  /* YouTube fills the Twitch player in normal and theater modes */
  #${PREFIX}-overlay {
    position: absolute !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    min-width: 0 !important;
    min-height: 0 !important;
    z-index: 100 !important;
    background: #000;
  }

  #${PREFIX}-overlay iframe {
    display: block;
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: 0;
  }

  #${PREFIX}-overlaybar {
    position: absolute;
    left: 8px;
    top: 8px;
    z-index: 101;
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    opacity: 0.25;
    transition: opacity 0.15s;
  }

  #${PREFIX}-overlay:hover #${PREFIX}-overlaybar {
    opacity: 1;
  }

  #${PREFIX}-overlaybar button {
    border: 0;
    border-radius: 4px;
    padding: 6px 8px;
    color: white;
    background: #18181bcc;
    cursor: pointer;
  }

  #${PREFIX}-overlaybar button:hover {
    background: #9147ff;
  }
`;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.documentElement.appendChild(style);

  let toolbar, urlInput, status, results;
  let playerHost = null, overlay = null, activeId = '', previous = new Map();
  let currentPath = location.pathname, lastUrl = location.href, observer;
  let isRestoring = false;

  const channelName = () => {
    const part = location.pathname.split('/').filter(Boolean)[0] || '';
    return /^directory$|^downloads$|^settings$|^videos$|^search$/i.test(part) ? '' : part;
  };
  const storageKey = () => `${PREFIX}:stream:${channelName().toLowerCase()}`;

  function setStatus(text) {
    if (status) status.textContent = text;
  }

  function ytId(raw) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      throw new Error('Enter a valid YouTube URL.');
    }

    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    let id = '';

    if (host === 'youtu.be') {
      id = u.pathname.split('/').filter(Boolean)[0] || '';
    } else if (['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
      if (u.pathname === '/watch') {
        id = u.searchParams.get('v') || '';
      } else {
        id = (u.pathname.match(/^\/(?:live|embed|shorts)\/([^/?]+)/) || [])[1] || '';
      }
    }

    if (!/^[\w-]{11}$/.test(id)) {
      throw new Error('Could not extract a valid YouTube video ID.');
    }
    return id;
  }

  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 18000,
        headers: { 'Accept-Language': 'en-US,en;q=0.9' },
        onload: r => r.status >= 200 && r.status < 300
          ? resolve(r.responseText)
          : reject(new Error(`YouTube search returned HTTP ${r.status}`)),
        onerror: () => reject(new Error('Could not reach YouTube.')),
        ontimeout: () => reject(new Error('YouTube search timed out.'))
      });
    });
  }

  function walk(node, out) {
    if (!node || typeof node !== 'object') return;
    if (node.videoRenderer) out.push(node.videoRenderer);

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        value.forEach(v => walk(v, out));
      } else if (value && typeof value === 'object') {
        walk(value, out);
      }
    }
  }

  function textOf(value) {
    if (!value) return '';
    if (typeof value.simpleText === 'string') return value.simpleText;
    if (Array.isArray(value.runs)) return value.runs.map(x => x.text || '').join('');
    return '';
  }

  function liveRenderer(v) {
    const badges = JSON.stringify(v.badges || []);
    const overlay = JSON.stringify(v.thumbnailOverlays || []);
    const meta = JSON.stringify(v.metadata || []);

    return /LIVE|LIVE NOW|LIVE_STREAM/i.test(`${badges} ${overlay} ${meta}`) ||
      Boolean(v.badges?.some(b => /LIVE/i.test(JSON.stringify(b))));
  }

  function scoreCandidate(item, target) {
    const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const owner = textOf(item.ownerText) ||
      textOf(item.longBylineText) ||
      textOf(item.shortBylineText);
    const a = norm(owner);
    const b = norm(target);

    if (!a || !b) return 0;
    if (a === b) return 100;
    if (a.includes(b) || b.includes(a)) return 75;

    const tokensA = new Set(owner.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    const tokensB = new Set(target.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    let shared = 0;

    for (const t of tokensB) {
      if (t.length > 1 && tokensA.has(t)) shared++;
    }
    return shared ? 35 + 15 * shared / Math.max(1, tokensB.size) : 0;
  }

  async function discover() {
    const target = channelName();
    if (!target) {
      setStatus('Open a Twitch channel page first.');
      return;
    }

    results.replaceChildren();
    setStatus(`Searching YouTube for live streams matching “${target}”…`);

    try {
      const q = encodeURIComponent(`${target} live`);
      const searchUrl =
        `https://www.youtube.com/results?search_query=${q}&sp=EgJAAQ%253D%253D`;
      const html = await gmGet(searchUrl);

      const match = html.match(
        /(?:var\s+)?ytInitialData\s*=\s*(\{.*?\})\s*;\s*<\/script>/s
      ) || html.match(
        /ytInitialData\s*=\s*(\{.*?\})\s*;\s*<\/script>/s
      );

      if (!match) {
        throw new Error('Could not read YouTube search results. YouTube may have changed its page.');
      }

      let data;
      try {
        data = JSON.parse(match[1]);
      } catch {
        throw new Error('YouTube returned an unreadable search response.');
      }

      const renderers = [];
      walk(data, renderers);
      const seen = new Set();

      const candidates = renderers.map(v => {
        const id = v.videoId;
        const title = textOf(v.title);
        const owner = textOf(v.ownerText) ||
          textOf(v.longBylineText) ||
          textOf(v.shortBylineText) ||
          'Unknown channel';

        return {
          id,
          title,
          owner,
          live: liveRenderer(v),
          score: scoreCandidate(v, target)
        };
      }).filter(v => {
        if (!v.id || !/^[\w-]{11}$/.test(v.id) || !v.live || seen.has(v.id)) {
          return false;
        }
        seen.add(v.id);
        return true;
      }).sort((a, b) => b.score - a.score);

      if (!candidates.length) {
        setStatus('No live YouTube results found. Try pasting a YouTube URL instead.');
        return;
      }

      setStatus(`Found ${candidates.length} live result(s). Check the channel/title before selecting.`);

      for (const c of candidates.slice(0, 8)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = c.title || 'Untitled livestream';

        const small = document.createElement('small');
        small.textContent = `${c.owner} · match ${Math.round(c.score)}%`;
        b.appendChild(small);

        b.addEventListener('click', () => {
          urlInput.value = `https://www.youtube.com/watch?v=${c.id}`;
          startVideo(c.id);
        });

        results.appendChild(b);
      }
    } catch (e) {
      setStatus(`${e.message} You can still paste a YouTube URL manually.`);
    }
  }

  function findPlayerHost() {
    const selectors = [
      '[data-a-target="video-player"]',
      '.video-player',
      '[data-a-target="player-overlay-click-handler"]'
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && el.getBoundingClientRect().width > 250 &&
        el.getBoundingClientRect().height > 140) {
        return selector === '[data-a-target="player-overlay-click-handler"]'
          ? (el.closest('[data-a-target="video-player"]') ||
            el.closest('.video-player') || el)
          : el;
      }
    }
    return null;
  }

  function twitchVideos() {
    return [...document.querySelectorAll('video')].filter(v => !overlay?.contains(v));
  }

  function pauseTwitch() {
    for (const video of twitchVideos()) {
      if (!previous.has(video)) {
        previous.set(video, {
          muted: video.muted,
          volume: video.volume,
          wasPlaying: !video.paused
        });
      }
      video.pause();
      video.muted = true;
    }
  }

  function mountOverlay(id) {
    const host = findPlayerHost();

    if (!host) {
      throw new Error('Twitch player container not found. Wait for playback to load and try again.');
    }

    if (overlay) overlay.remove();
    playerHost = host;

    if (getComputedStyle(host).position === 'static') {
      host.style.position = 'relative';
    }

    overlay = document.createElement('div');
    overlay.id = `${PREFIX}-overlay`;

    const bar = document.createElement('div');
    bar.id = `${PREFIX}-overlaybar`;

    const restore = document.createElement('button');
    restore.textContent = 'Restore Twitch';
    restore.addEventListener('click', restoreTwitch);

    const openYT = document.createElement('button');
    openYT.textContent = 'Open YouTube';
    openYT.addEventListener('click', () => {
      window.open(`https://www.youtube.com/watch?v=${id}`, '_blank', 'noopener');
    });

    const theater = document.createElement('button');
    theater.textContent = 'Theater Mode';
    theater.title = 'Toggle Twitch Theater Mode';
    theater.addEventListener('click', toggleTheaterMode);

    bar.append(restore, theater, openYT);

    const iframe = document.createElement('iframe');
    iframe.title = 'YouTube livestream';
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.src =
      `https://www.youtube.com/embed/${encodeURIComponent(id)}?autoplay=1&playsinline=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`;

    overlay.append(iframe, bar);
    host.appendChild(overlay);
  }

  function startVideo(id) {
    try {
      pauseTwitch();
      mountOverlay(id);
      activeId = id;
      localStorage.setItem(storageKey(), id);
      setStatus('YouTube is displayed in the Twitch player area. Playback may require a click inside the video.');
    } catch (e) {
      setStatus(e.message);
    }
  }

  function restoreTwitch() {
    isRestoring = true;

    if (overlay) overlay.remove();
    overlay = null;
    activeId = '';

    for (const [video, state] of previous) {
      if (!video.isConnected) continue;
      video.muted = state.muted;
      video.volume = state.volume;
      if (state.wasPlaying) video.play().catch(() => { });
    }

    previous.clear();
    setStatus('Twitch player restored.');
    isRestoring = false;
  }


  function toggleTheaterMode() {
    const button =
      document.querySelector('button[data-a-target="player-theatre-mode-button"]') ||
      document.querySelector('button[aria-label*="Theatre"]') ||
      document.querySelector('button[aria-label*="Theater"]');

    if (button) {
      button.click();
      setStatus('Twitch Theater Mode toggled.');
    } else {
      setStatus('Could not find Twitch Theater Mode button. Try again after the player loads.');
    }
  }


  function syncLive() {
    if (!overlay) {
      setStatus('Start a YouTube stream first.');
      return;
    }

    const iframe = overlay.querySelector('iframe');
    iframe.contentWindow?.postMessage(JSON.stringify({
      event: 'command',
      func: 'seekTo',
      args: [8640000, true]
    }), 'https://www.youtube.com');

    setStatus('Requested a seek toward the live edge. YouTube may not support this for every stream.');
  }

  function makeUI() {
    if (document.getElementById(`${PREFIX}-toolbar`)) return;

    const host = document.querySelector('[data-a-target="video-player"]')?.parentElement
      || document.querySelector('.channel-root__player')
      || document.querySelector('main');

    if (!host) return;

    toolbar = document.createElement('div');
    toolbar.id = `${PREFIX}-toolbar`;

    const discoverBtn = document.createElement('button');
    discoverBtn.textContent = 'Find YouTube Stream';
    discoverBtn.addEventListener('click', discover);

    urlInput = document.createElement('input');
    urlInput.type = 'url';
    urlInput.placeholder = 'YouTube livestream URL…';
    urlInput.setAttribute('aria-label', 'YouTube livestream URL');

    urlInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        try {
          startVideo(ytId(urlInput.value.trim()));
        } catch (err) {
          setStatus(err.message);
        }
      }
    });

    const go = document.createElement('button');
    go.textContent = 'Use URL';
    go.addEventListener('click', () => {
      try {
        startVideo(ytId(urlInput.value.trim()));
      } catch (err) {
        setStatus(err.message);
      }
    });

    const sync = document.createElement('button');
    sync.textContent = 'Sync to Live';
    sync.addEventListener('click', syncLive);

    const restore = document.createElement('button');
    restore.textContent = 'Restore Twitch';
    restore.addEventListener('click', restoreTwitch);

    status = document.createElement('div');
    status.id = `${PREFIX}-status`;
    status.textContent = 'Find a live YouTube stream or paste its URL.';

    results = document.createElement('div');
    results.id = `${PREFIX}-results`;

    toolbar.append(discoverBtn, urlInput, go, sync, restore, status, results);
    host.insertBefore(toolbar, host.firstChild);
  }

  function handleNavigation() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;

    const nextPath = location.pathname;
    if (nextPath !== currentPath) {
      currentPath = nextPath;
      restoreTwitch();
      previous.clear();

      if (urlInput) urlInput.value = '';
      if (results) results.replaceChildren();

      setTimeout(() => {
        const saved = localStorage.getItem(storageKey());
        if (saved && urlInput) {
          urlInput.value = `https://www.youtube.com/watch?v=${saved}`;
        }
      }, 500);
    }
  }

  function init() {
    makeUI();

    const saved = localStorage.getItem(storageKey());
    if (saved && urlInput) {
      urlInput.value = `https://www.youtube.com/watch?v=${saved}`;
    }

    observer = new MutationObserver(() => {
      makeUI();
      handleNavigation();

      if (activeId && overlay && !overlay.isConnected && !isRestoring) {
        try {
          mountOverlay(activeId);
        } catch { }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    window.addEventListener('popstate', handleNavigation);

    const push = history.pushState;
    history.pushState = function (...args) {
      const r = push.apply(this, args);
      queueMicrotask(handleNavigation);
      return r;
    };

    const replace = history.replaceState;
    history.replaceState = function (...args) {
      const r = replace.apply(this, args);
      queueMicrotask(handleNavigation);
      return r;
    };
  }

  init();
})();
