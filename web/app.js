'use strict';

/* ---------------------------------------------------------------- state */

const TOKEN_KEY = 'repolens_token';

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  health: null,
  repos: [],
  selectedId: null,
  tab: 'chat',
  chats: {},        // repoId -> { messages: [{role, content, sources}], busy }
  reviews: {},      // repoId -> review rows
  busy: {},         // repoId -> { review, reindex, instructions }
  note: {},         // repoId -> transient job progress text
  pulls: {},        // repoId -> { rows, loading, error }
  pullJobs: {},     // repoId -> { prNumber: { jobId, progress } } for in-flight reviews
  pullJobsSeen: {}, // repoId -> { jobId: true } jobs already followed to completion
  postToGithub: true, // shared "Post to GitHub" preference
  mountKey: null,   // repoId + '|' + tab currently mounted in the panel
};

const $ = (id) => document.getElementById(id);
const dom = {};

/* ------------------------------------------------------------- dom utils */

function h(tag, props, children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children || [])) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

function fmtTime(value) {
  if (!value) return '—';
  const d = typeof value === 'number' ? new Date(value) : new Date(String(value).replace(' ', 'T'));
  return isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

function fmtCount(n) {
  return typeof n === 'number' ? n.toLocaleString() : '0';
}

function fmtRelative(value) {
  if (!value) return 'unknown';
  const d = typeof value === 'number' ? new Date(value) : new Date(String(value).replace(' ', 'T'));
  if (isNaN(d.getTime())) return String(value);
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  if (days < 30) return days + 'd ago';
  const months = Math.floor(days / 30);
  if (months < 12) return months + 'mo ago';
  return Math.floor(days / 365) + 'y ago';
}

function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z]+/g, '-');
}

function safeUrl(value) {
  return /^https?:\/\//i.test(String(value || '')) ? String(value) : null;
}

/* ------------------------------------------------------------ api client */

async function api(path, options = {}) {
  const opts = { method: options.method || 'GET', headers: { ...(options.headers || {}) } };
  if (options.body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(options.body);
  }
  if (state.token) opts.headers.Authorization = 'Bearer ' + state.token;

  const res = await fetch(path, opts);
  const raw = await res.text();
  let data = null;
  if (raw) {
    try { data = JSON.parse(raw); } catch { data = { error: raw.slice(0, 400) }; }
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || res.statusText || ('HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

function handleError(err) {
  if (err && err.status === 401) {
    dom.tokenHint.textContent = 'Unauthorized — enter a valid API token to continue.';
    dom.tokenHint.classList.add('hint-error');
    dom.tokenInput.focus();
    toast('Unauthorized (401). Enter your API token in the sidebar.');
    return;
  }
  toast((err && err.message) || 'Request failed');
}

/* ---------------------------------------------------------------- toasts */

function toast(message) {
  const box = h('div', { class: 'toast' }, [
    h('span', { class: 'toast-msg', text: message }),
    h('button', { class: 'toast-x', type: 'button', 'aria-label': 'Dismiss', text: '×', onclick: () => box.remove() }),
  ]);
  dom.toasts.appendChild(box);
  setTimeout(() => box.remove(), 9000);
}

/* -------------------------------------------------------------- markdown */

const UNSAFE_TAGS = 'script,style,iframe,object,embed,link,meta,form,base';

function sanitize(root) {
  root.querySelectorAll(UNSAFE_TAGS).forEach((n) => n.remove());
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      else if (/^(href|src|xlink:href|action|formaction)$/.test(name) && /^\s*(javascript|vbscript|data):/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
    if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
  });
  return root;
}

function markdown(textContent) {
  const box = h('div', { class: 'md' });
  if (window.marked && typeof window.marked.parse === 'function') {
    try {
      box.innerHTML = window.marked.parse(String(textContent || ''));
      return sanitize(box);
    } catch { /* fall through to plain text */ }
  }
  box.appendChild(h('pre', { class: 'md-fallback', text: String(textContent || '') }));
  return box;
}

/* ----------------------------------------------------------- data access */

function selectedRepo() {
  return state.repos.find((r) => r.id === state.selectedId) || null;
}

function chatFor(repoId) {
  if (!state.chats[repoId]) state.chats[repoId] = { messages: [], busy: false };
  return state.chats[repoId];
}

function busyFor(repoId) {
  if (!state.busy[repoId]) state.busy[repoId] = {};
  return state.busy[repoId];
}

function pullsFor(repoId) {
  if (!state.pulls[repoId]) state.pulls[repoId] = { rows: null, loading: false, error: null };
  return state.pulls[repoId];
}

function pullJobsFor(repoId) {
  if (!state.pullJobs[repoId]) state.pullJobs[repoId] = {};
  return state.pullJobs[repoId];
}

function pullJobsSeenFor(repoId) {
  if (!state.pullJobsSeen[repoId]) state.pullJobsSeen[repoId] = {};
  return state.pullJobsSeen[repoId];
}

function isGithubRepo(repo) {
  return !!repo && String(repo.id || '').startsWith('github:');
}

async function loadHealth() {
  try {
    state.health = await api('/api/health');
  } catch (err) {
    state.health = { error: err.message };
  }
  renderHealth();
}

async function loadRepos(quiet) {
  try {
    const data = await api('/api/repositories');
    state.repos = (data && data.repositories) || [];
    dom.tokenHint.textContent = 'Stored in localStorage.';
    dom.tokenHint.classList.remove('hint-error');
    if (state.selectedId && !state.repos.some((r) => r.id === state.selectedId)) {
      state.selectedId = null;
      state.mountKey = null;
    }
    renderRepoList();
    renderPanel();
    syncRepoPolling();
  } catch (err) {
    if (!quiet || err.status === 401) handleError(err);
  }
}

async function loadReviews(repoId) {
  try {
    const data = await api('/api/reviews?repository=' + encodeURIComponent(repoId));
    state.reviews[repoId] = (data && data.reviews) || [];
  } catch (err) {
    state.reviews[repoId] = [];
    handleError(err);
  }
  if (state.selectedId === repoId && state.tab === 'reviews') renderReviewList();
}

async function loadPulls(repoId) {
  const st = pullsFor(repoId);
  if (st.loading) return;
  st.loading = true;
  st.error = null;
  renderPulls();
  try {
    const data = await api('/api/repositories/' + encodeURIComponent(repoId) + '/pulls');
    st.rows = (data && data.pulls) || [];
    // Reviews queued elsewhere (webhook, another tab) still get followed to completion here.
    for (const pr of st.rows) {
      const review = pr.review || {};
      if (review.status === 'pending' && review.jobId) trackPullJob(repoId, pr.number, review.jobId);
    }
  } catch (err) {
    st.rows = st.rows || [];
    st.error = err.message || 'Could not load pull requests';
    handleError(err);
  } finally {
    st.loading = false;
    renderPulls();
  }
}

/* --------------------------------------------------------------- polling */

let repoTimer = null;

function syncRepoPolling() {
  const active = state.repos.some((r) => r.status === 'queued' || r.status === 'indexing');
  if (active && !repoTimer) repoTimer = setInterval(() => loadRepos(true), 5000);
  else if (!active && repoTimer) { clearInterval(repoTimer); repoTimer = null; }
}

function pollJob(jobId, onProgress) {
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const job = await api('/api/jobs/' + encodeURIComponent(jobId));
        if (onProgress) onProgress(job);
        if (job.status === 'done') return resolve(job);
        if (job.status === 'error') return reject(new Error(job.error || 'Job failed'));
        setTimeout(tick, 2000);
      } catch (err) {
        reject(err);
      }
    };
    tick();
  });
}

function setNote(repoId, textContent) {
  state.note[repoId] = textContent;
  const node = $('job-note');
  if (node && state.selectedId === repoId) node.textContent = textContent || '';
}

/* -------------------------------------------------------- sidebar render */

function renderHealth() {
  const box = dom.health;
  box.replaceChildren();
  const hp = state.health;
  if (!hp || hp.error) {
    box.appendChild(h('span', { class: 'dot dot-error' }));
    box.appendChild(h('span', { class: 'health-text', text: hp ? 'API unreachable' : 'checking…' }));
    return;
  }
  const llm = hp.llm || {};
  box.appendChild(h('span', { class: 'dot ' + (hp.ok ? 'dot-ok' : 'dot-error') }));
  box.appendChild(h('span', {
    class: 'health-text',
    text: [llm.provider, llm.model].filter(Boolean).join(' · ') || 'llm unknown',
  }));
  box.appendChild(h('span', {
    class: 'health-sub',
    text: 'embeddings ' + (hp.embeddings ? 'on (' + hp.embeddings + ')' : 'off'),
  }));
  dom.version.textContent = hp.version ? 'v' + hp.version : '';
}

function renderRepoList() {
  const list = dom.repoList;
  list.replaceChildren();
  if (!state.repos.length) {
    list.appendChild(h('li', { class: 'repo-empty', text: 'No repositories indexed yet.' }));
    return;
  }
  for (const repo of state.repos) {
    const sub = (repo.branch || 'default branch') + ' · ' + fmtCount(repo.file_count) + ' files · ' + fmtCount(repo.chunk_count) + ' chunks';
    list.appendChild(h('li', {
      class: 'repo-item' + (repo.id === state.selectedId ? ' is-selected' : ''),
      onclick: () => selectRepo(repo.id),
    }, [
      h('div', { class: 'repo-row' }, [
        h('span', { class: 'repo-name', text: repo.owner + '/' + repo.name }),
        h('span', { class: 'pill pill-' + repo.status, text: repo.status }),
      ]),
      h('div', { class: 'repo-sub', text: sub }),
      repo.status === 'error' && repo.error ? h('div', { class: 'repo-err', text: repo.error }) : null,
    ]));
  }
}

function selectRepo(id) {
  state.selectedId = id;
  renderRepoList();
  renderPanel();
}

/* ---------------------------------------------------------- panel render */

function renderPanel() {
  const repo = selectedRepo();
  dom.emptyState.hidden = !!repo;
  dom.repoPanel.hidden = !repo;
  if (!repo) { state.mountKey = null; return; }

  dom.repoTitle.textContent = repo.owner + '/' + repo.name;
  dom.repoMeta.replaceChildren(
    h('span', { class: 'pill pill-' + repo.status, text: repo.status }),
    h('span', { text: repo.branch || 'default branch' }),
    h('span', { text: fmtCount(repo.file_count) + ' files / ' + fmtCount(repo.chunk_count) + ' chunks' }),
    h('span', { text: 'indexed ' + fmtTime(repo.indexed_at) }),
    repo.last_commit ? h('code', { text: String(repo.last_commit).slice(0, 8) }) : null,
  );
  for (const btn of dom.tabs.querySelectorAll('.tab')) {
    btn.classList.toggle('is-active', btn.dataset.tab === state.tab);
  }
  renderTabBody();
}

function renderTabBody() {
  const repo = selectedRepo();
  if (!repo) return;
  const key = repo.id + '|' + state.tab;
  if (state.mountKey === key) {
    // Already mounted: refresh only the dynamic sections so inputs keep focus/value.
    if (state.tab === 'chat') renderChatLog();
    if (state.tab === 'reviews') { renderPulls(); renderReviewList(); }
    return;
  }
  state.mountKey = key;
  const body = dom.tabBody;
  body.replaceChildren();
  if (state.tab === 'chat') body.appendChild(buildChatTab(repo));
  else if (state.tab === 'reviews') body.appendChild(buildReviewsTab(repo));
  else body.appendChild(buildSettingsTab(repo));
}

/* ------------------------------------------------------------- chat tab */

function buildChatTab(repo) {
  const log = h('div', { class: 'chat-log', id: 'chat-log' });
  const input = h('textarea', {
    class: 'chat-input',
    id: 'chat-input',
    rows: 3,
    placeholder: 'Ask about ' + repo.owner + '/' + repo.name + '…  (Enter to send, Shift+Enter for newline)',
  });
  const send = h('button', { class: 'btn btn-primary', id: 'chat-send', type: 'button', text: 'Ask' });

  const submit = () => {
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    askQuestion(repo.id, q);
  };
  send.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });

  const wrap = h('div', { class: 'chat' }, [
    log,
    h('div', { class: 'chat-composer' }, [
      input,
      h('div', { class: 'chat-actions' }, [
        h('button', {
          class: 'btn btn-ghost btn-sm', type: 'button', text: 'Clear',
          onclick: () => { chatFor(repo.id).messages = []; renderChatLog(); },
        }),
        send,
      ]),
    ]),
  ]);
  setTimeout(renderChatLog, 0);
  return wrap;
}

function sourceUrl(repo, source) {
  const path = String(source.filepath || '').replace(/^\/+/, '');
  const base = 'https://github.com/' + repo.owner + '/' + repo.name + '/blob/' + (repo.branch || 'main') + '/' + path;
  if (source.linestart) return base + '#L' + source.linestart + (source.lineend ? '-L' + source.lineend : '');
  return base;
}

function renderChatLog() {
  const log = $('chat-log');
  const repo = selectedRepo();
  if (!log || !repo) return;
  const chat = chatFor(repo.id);
  const sendBtn = $('chat-send');
  if (sendBtn) { sendBtn.disabled = chat.busy; sendBtn.textContent = chat.busy ? 'Asking…' : 'Ask'; }
  log.replaceChildren();

  const bubble = (role, body) => h('div', { class: 'msg msg-' + role }, [h('div', { class: 'msg-role', text: role === 'user' ? 'You' : 'RepoLens' }), body]);

  if (!chat.messages.length && !chat.busy) {
    log.appendChild(h('div', { class: 'chat-hint' }, [
      h('p', { text: 'Ask anything about this codebase. Answers cite the files they came from.' }),
      h('p', { class: 'muted', text: 'Example: "How is authentication handled?" or "Where are database migrations run?"' }),
    ]));
  }

  for (const msg of chat.messages) {
    if (msg.role === 'user') {
      log.appendChild(bubble('user', h('div', { class: 'msg-body', text: msg.content })));
      continue;
    }
    const body = h('div', { class: 'msg-body' }, [markdown(msg.content)]);
    if (msg.sources && msg.sources.length) {
      body.appendChild(h('div', { class: 'sources' }, [
        h('div', { class: 'sources-head', text: 'Sources (' + msg.sources.length + ')' }),
        h('ul', { class: 'sources-list' }, msg.sources.map((s) => h('li', {}, [
          h('a', {
            class: 'src-link', href: sourceUrl(repo, s), target: '_blank', rel: 'noopener noreferrer',
            text: s.filepath + (s.linestart ? ':' + s.linestart + '-' + (s.lineend || s.linestart) : ''),
          }),
          s.summary ? h('span', { class: 'src-summary', text: s.summary }) : null,
        ]))),
      ]));
    }
    log.appendChild(bubble('assistant', body));
  }

  if (chat.busy) {
    log.appendChild(bubble('assistant', h('div', { class: 'msg-body' }, [h('div', { class: 'spinner-row' }, [
      h('span', { class: 'spinner' }),
      h('span', { text: 'Searching the codebase and drafting an answer… this can take 30–120 s.' }),
    ])])));
  }
  log.scrollTop = log.scrollHeight;
}

async function askQuestion(repoId, question) {
  const chat = chatFor(repoId);
  if (chat.busy) return;
  chat.messages.push({ role: 'user', content: question });
  chat.busy = true;
  renderChatLog();
  try {
    const payload = { messages: chat.messages.map((m) => ({ role: m.role, content: m.content })), repositories: [repoId] };
    const data = await api('/api/query', { method: 'POST', body: payload });
    chat.messages.push({ role: 'assistant', content: (data && data.message) || '', sources: (data && data.sources) || [] });
  } catch (err) {
    handleError(err);
    chat.messages.pop(); // drop the unanswered turn and hand the question back for a clean retry
    const input = $('chat-input');
    if (input && !input.value.trim()) input.value = question;
  } finally {
    chat.busy = false;
    renderChatLog();
  }
}

/* ---------------------------------------------------------- reviews tab */

function postCheckbox(id) {
  const box = h('input', { type: 'checkbox', class: 'post-check', id, checked: state.postToGithub !== false });
  box.addEventListener('change', () => {
    state.postToGithub = box.checked;
    for (const other of document.querySelectorAll('.post-check')) other.checked = state.postToGithub;
  });
  return box;
}

function buildPullsCard(repo) {
  const github = isGithubRepo(repo);

  const refreshBtn = h('button', {
    class: 'btn btn-ghost btn-sm', type: 'button', title: 'Refresh', text: '\u21bb',
    hidden: !github, onclick: () => loadPulls(repo.id),
  });

  const allBtn = h('button', { class: 'btn btn-primary btn-sm', id: 'pulls-review-all', type: 'button', text: 'Review all unreviewed' });
  allBtn.addEventListener('click', () => reviewPulls(repo.id, null, false, allBtn));

  const toolbar = h('div', { class: 'row-form', id: 'pulls-toolbar', hidden: !github }, [
    allBtn,
    h('label', { class: 'check' }, [postCheckbox('pulls-post'), h('span', { text: 'Post to GitHub' })]),
    h('span', { class: 'job-note', id: 'pulls-count' }),
  ]);

  const card = h('section', { class: 'card' }, [
    h('div', { class: 'card-head' }, [h('h3', { text: 'Open pull requests' }), refreshBtn]),
    toolbar,
    h('div', { class: 'pulls', id: 'pulls-list' }, [h('p', { class: 'muted', text: github ? 'Loading\u2026' : '' })]),
  ]);

  if (github) loadPulls(repo.id);
  else setTimeout(renderPulls, 0);
  return card;
}

function buildReviewsTab(repo) {
  const prInput = h('input', { type: 'number', min: '1', id: 'pr-number', placeholder: 'PR number', required: true });
  const postBox = postCheckbox('pr-post');
  const runBtn = h('button', { class: 'btn btn-primary', type: 'submit', text: 'Run review' });

  const form = h('form', { class: 'row-form', onsubmit: (e) => {
    e.preventDefault();
    const n = parseInt(prInput.value, 10);
    if (!n) return toast('Enter a pull request number.');
    runReview(repo.id, n, postBox.checked, runBtn);
  } }, [
    prInput,
    h('label', { class: 'check' }, [postBox, h('span', { text: 'Post to GitHub' })]),
    runBtn,
    h('span', { class: 'job-note', id: 'job-note', text: state.note[repo.id] || '' }),
  ]);

  const wrap = h('div', { class: 'tab-pane' }, [
    buildPullsCard(repo),
    h('section', { class: 'card' }, [h('h3', { text: 'Run a review by pull request number' }), form]),
    h('section', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h3', { text: 'Past reviews' }),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '\u21bb', onclick: () => loadReviews(repo.id) }),
      ]),
      h('div', { class: 'review-list', id: 'review-list' }, [h('p', { class: 'muted', text: 'Loading\u2026' })]),
    ]),
  ]);
  loadReviews(repo.id);
  return wrap;
}

/* ------------------------------------------------------ open pull requests */

function findingCount(review) {
  if (Array.isArray(review.findings)) return review.findings.length;
  return typeof review.findings === 'number' ? review.findings : null;
}

function pullStatusBits(review, job) {
  const status = job ? 'pending' : String(review.status || 'none');
  if (status === 'pending') {
    const bits = [h('span', { class: 'pill pill-queued', text: 'queued' })];
    if (job && job.progress) bits.push(h('span', { class: 'pull-progress', text: job.progress }));
    return bits;
  }
  if (status === 'reviewed') {
    const bits = [h('span', { class: 'pill pill-done', text: 'reviewed' })];
    if (review.verdict) bits.push(h('span', { class: 'badge badge-' + slug(review.verdict), text: String(review.verdict).replace(/_/g, ' ') }));
    const n = findingCount(review);
    if (n !== null) bits.push(h('span', { class: 'pull-findings', text: n + (n === 1 ? ' finding' : ' findings') }));
    bits.push(h('span', {
      class: 'review-posted' + (review.posted ? ' is-posted' : ''),
      text: review.posted ? 'posted' : 'not posted',
    }));
    return bits;
  }
  if (status === 'error') {
    return [h('span', { class: 'pill pill-error', title: review.error || 'Review failed', text: 'error' })];
  }
  return [h('span', { class: 'pill', text: 'not reviewed' })];
}

function pullRow(repo, pr, job) {
  const review = pr.review || { status: 'none' };
  const pending = !!job || review.status === 'pending';
  const reviewed = !pending && review.status === 'reviewed';
  const href = safeUrl(pr.htmlUrl);

  const btn = h('button', {
    class: 'btn btn-sm' + (reviewed ? '' : ' btn-primary'),
    type: 'button',
    text: reviewed ? 'Re-review' : 'Review',
    disabled: pending,
  });
  btn.addEventListener('click', () => reviewPulls(repo.id, [pr.number], reviewed, btn));

  const link = (cls, textContent) => (href
    ? h('a', { class: cls, href, target: '_blank', rel: 'noopener noreferrer', text: textContent })
    : h('span', { class: cls, text: textContent }));

  return h('div', { class: 'pull' }, [
    h('div', { class: 'pull-main' }, [
      h('div', { class: 'pull-title' }, [
        link('pull-num', '#' + pr.number),
        link('pull-name', pr.title || '(untitled)'),
        pr.draft ? h('span', { class: 'badge badge-draft', text: 'draft' }) : null,
      ]),
      h('div', { class: 'pull-meta' }, [
        h('span', { text: pr.author ? '@' + pr.author : 'unknown author' }),
        h('span', { text: '\u2192 ' + (pr.baseRef || 'default branch') }),
        h('span', { title: fmtTime(pr.updatedAt), text: 'updated ' + fmtRelative(pr.updatedAt) }),
      ]),
    ]),
    h('div', { class: 'pull-status' }, pullStatusBits(review, job)),
    btn,
  ]);
}

function renderPulls() {
  const repo = selectedRepo();
  const box = $('pulls-list');
  if (!box || !repo) return;
  const countLine = $('pulls-count');
  const allBtn = $('pulls-review-all');
  box.replaceChildren();

  if (!isGithubRepo(repo)) {
    box.appendChild(h('p', { class: 'muted', text: 'Pull requests need a GitHub repository \u2014 this repository was indexed from a local path.' }));
    if (countLine) countLine.textContent = '';
    return;
  }

  const st = pullsFor(repo.id);
  const jobs = pullJobsFor(repo.id);
  const rows = st.rows;

  if (st.error) box.appendChild(h('p', { class: 'pulls-err', text: st.error }));
  if (!rows) {
    box.appendChild(h('p', { class: 'muted', text: st.loading ? 'Loading\u2026' : 'No pull requests loaded.' }));
    if (countLine) countLine.textContent = '';
    if (allBtn) allBtn.disabled = true;
    return;
  }
  if (!rows.length && !st.error) box.appendChild(h('p', { class: 'muted', text: 'No open pull requests.' }));

  let queued = 0;
  let unreviewed = 0;
  for (const pr of rows) {
    const job = jobs[pr.number];
    const review = pr.review || { status: 'none' };
    if (job || review.status === 'pending') queued += 1;
    else if (!pr.draft && review.status !== 'reviewed') unreviewed += 1;
    box.appendChild(pullRow(repo, pr, job));
  }

  if (countLine) {
    countLine.textContent = rows.length + ' open \u00b7 ' + unreviewed + ' unreviewed \u00b7 ' + queued + ' queued';
  }
  if (allBtn) allBtn.disabled = st.loading || unreviewed === 0;
}

async function reviewPulls(repoId, prNumbers, force, btn) {
  const body = { post: state.postToGithub !== false };
  if (prNumbers && prNumbers.length) body.prNumbers = prNumbers;
  if (force) body.force = true;
  if (btn) btn.disabled = true;
  try {
    const data = await api('/api/repositories/' + encodeURIComponent(repoId) + '/pulls/review', { method: 'POST', body });
    const jobs = (data && data.jobs) || [];
    const skipped = (data && data.skipped) || [];
    let message = jobs.length
      ? jobs.length + (jobs.length === 1 ? ' review queued.' : ' reviews queued.')
      : 'Nothing queued.';
    if (skipped.length) {
      message += ' Skipped ' + skipped.map((s) => '#' + s.prNumber + ' (' + (s.reason || 'no reason given') + ')').join(', ') + '.';
    }
    toast(message);
    for (const job of jobs) trackPullJob(repoId, job.prNumber, job.jobId);
  } catch (err) {
    handleError(err);
  } finally {
    if (btn) btn.disabled = false;
    renderPulls();
  }
}

function trackPullJob(repoId, prNumber, jobId) {
  const jobs = pullJobsFor(repoId);
  const seen = pullJobsSeenFor(repoId);
  if (!jobId || jobs[prNumber] || seen[jobId]) return;
  seen[jobId] = true;
  jobs[prNumber] = { jobId, progress: 'queued' };
  const repaint = () => { if (state.selectedId === repoId && state.tab === 'reviews') renderPulls(); };
  repaint();

  pollJob(jobId, (job) => {
    const tracked = pullJobsFor(repoId)[prNumber];
    if (tracked) tracked.progress = job.status + (job.progress ? ' \u2014 ' + job.progress : '');
    repaint();
  }).catch((err) => {
    toast('Review of #' + prNumber + ' failed: ' + ((err && err.message) || 'unknown error'));
  }).then(() => {
    delete pullJobsFor(repoId)[prNumber];
    if (Object.keys(pullJobsFor(repoId)).length) return repaint();
    loadReviews(repoId);
    const repo = state.repos.find((r) => r.id === repoId);
    if (isGithubRepo(repo)) loadPulls(repoId);
    else repaint();
  });
}

function severityRank(s) {
  return { critical: 0, high: 1, error: 1, medium: 2, warning: 2, low: 3, info: 4, nit: 4 }[String(s || '').toLowerCase()] ?? 5;
}

function renderReviewList() {
  const box = $('review-list');
  const repo = selectedRepo();
  if (!box || !repo) return;
  const rows = state.reviews[repo.id];
  box.replaceChildren();
  if (!rows) return box.appendChild(h('p', { class: 'muted', text: 'Loading…' }));
  if (!rows.length) return box.appendChild(h('p', { class: 'muted', text: 'No reviews yet.' }));

  for (const rv of rows) {
    let findings = [];
    try { findings = JSON.parse(rv.comments_json || '[]') || []; } catch { findings = []; }
    findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

    const head = h('div', { class: 'review-head' }, [
      h('a', {
        class: 'review-pr', href: 'https://github.com/' + repo.owner + '/' + repo.name + '/pull/' + rv.pr_number,
        target: '_blank', rel: 'noopener noreferrer', text: '#' + rv.pr_number,
      }),
      rv.verdict ? h('span', { class: 'badge badge-' + String(rv.verdict).toLowerCase().replace(/[^a-z]+/g, '-'), text: String(rv.verdict).replace(/_/g, ' ') }) : null,
      h('span', { class: 'pill pill-' + rv.status, text: rv.status }),
      h('span', { class: 'review-time', text: fmtTime(rv.created_at) }),
      h('span', { class: 'review-posted ' + (rv.posted ? 'is-posted' : ''), text: rv.posted ? 'posted to GitHub' : 'not posted' }),
      rv.head_sha ? h('code', { text: String(rv.head_sha).slice(0, 8) }) : null,
    ]);

    const parts = [head];
    if (rv.error) parts.push(h('div', { class: 'review-err', text: rv.error }));
    if (rv.summary) parts.push(h('div', { class: 'review-summary' }, [markdown(rv.summary)]));

    if (findings.length) {
      const rows2 = findings.map((f) => h('tr', {}, [
        h('td', {}, [h('span', { class: 'sev sev-' + String(f.severity || 'info').toLowerCase(), text: f.severity || 'info' })]),
        h('td', {}, [f.path
          ? h('a', {
              class: 'src-link', target: '_blank', rel: 'noopener noreferrer',
              href: sourceUrl(repo, { filepath: f.path, linestart: f.line }),
              text: f.path + (f.line ? ':' + f.line : ''),
            })
          : h('span', { class: 'muted', text: '—' })]),
        h('td', {}, [
          h('div', { class: 'finding-title', text: f.title || '' }),
          f.body ? h('div', { class: 'finding-body' }, [markdown(f.body)]) : null,
        ]),
      ]));
      parts.push(h('table', { class: 'findings' }, [
        h('thead', {}, [h('tr', {}, [h('th', { text: 'Severity' }), h('th', { text: 'Location' }), h('th', { text: 'Finding' })])]),
        h('tbody', {}, rows2),
      ]));
    } else if (rv.status === 'done') {
      parts.push(h('p', { class: 'muted', text: 'No inline findings.' }));
    }
    box.appendChild(h('article', { class: 'review' }, parts));
  }
}

async function runReview(repoId, prNumber, post, btn) {
  const busy = busyFor(repoId);
  if (busy.review) return;
  busy.review = true;
  btn.disabled = true;
  setNote(repoId, 'queued…');
  try {
    const { jobId } = await api('/api/reviews', { method: 'POST', body: { repository: repoId, prNumber, post: post !== false } });
    await pollJob(jobId, (job) => setNote(repoId, job.status + (job.progress ? ' — ' + job.progress : '')));
    setNote(repoId, 'review complete');
    await loadReviews(repoId);
  } catch (err) {
    setNote(repoId, '');
    handleError(err);
  } finally {
    busy.review = false;
    btn.disabled = false;
  }
}

/* --------------------------------------------------------- settings tab */

function buildSettingsTab(repo) {
  const area = h('textarea', { class: 'instructions', rows: 10, placeholder: 'Custom review instructions for this repository…' });
  area.value = repo.instructions || '';
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', text: 'Save instructions' });
  saveBtn.addEventListener('click', () => saveInstructions(repo.id, area.value, saveBtn));

  const reindexBtn = h('button', { class: 'btn', type: 'button', text: 'Reindex repository' });
  reindexBtn.addEventListener('click', () => reindexRepo(repo.id, reindexBtn));

  const confirmBox = h('div', { class: 'confirm', hidden: true });
  const deleteBtn = h('button', { class: 'btn btn-danger', type: 'button', text: 'Delete repository' });
  deleteBtn.addEventListener('click', () => { confirmBox.hidden = false; deleteBtn.hidden = true; });
  confirmBox.append(
    h('span', { class: 'confirm-text', text: 'Delete ' + repo.owner + '/' + repo.name + ' and all of its indexed data?' }),
    h('button', { class: 'btn btn-danger btn-sm', type: 'button', text: 'Yes, delete', onclick: () => deleteRepo(repo.id) }),
    h('button', {
      class: 'btn btn-ghost btn-sm', type: 'button', text: 'Cancel',
      onclick: () => { confirmBox.hidden = true; deleteBtn.hidden = false; },
    }),
  );

  return h('div', { class: 'tab-pane' }, [
    h('section', { class: 'card' }, [
      h('h3', { text: 'Custom review instructions' }),
      h('p', { class: 'muted', text: 'Extra guidance given to the model when reviewing pull requests in this repository.' }),
      area,
      h('div', { class: 'row-form' }, [saveBtn]),
    ]),
    h('section', { class: 'card' }, [
      h('h3', { text: 'Index' }),
      h('div', { class: 'kv' }, [
        ['Remote', repo.remote || 'github'],
        ['Branch', repo.branch || 'default branch (resolving)'],
        ['Last commit', repo.last_commit || '—'],
        ['Indexed', fmtTime(repo.indexed_at)],
        ['Added', fmtTime(repo.created_at)],
        ['Size', fmtCount(repo.file_count) + ' files / ' + fmtCount(repo.chunk_count) + ' chunks'],
      ].map(([k, v]) => h('div', {}, [h('span', { class: 'k', text: k }), h('span', { text: v })]))),
      h('div', { class: 'row-form' }, [reindexBtn, h('span', { class: 'job-note', id: 'job-note', text: state.note[repo.id] || '' })]),
    ]),
    h('section', { class: 'card card-danger' }, [
      h('h3', { text: 'Danger zone' }),
      deleteBtn,
      confirmBox,
    ]),
  ]);
}

async function saveInstructions(repoId, instructions, btn) {
  btn.disabled = true;
  try {
    await api('/api/repositories/' + encodeURIComponent(repoId) + '/instructions', { method: 'PUT', body: { instructions } });
    toast('Instructions saved.');
    await loadRepos(true);
  } catch (err) {
    handleError(err);
  } finally {
    btn.disabled = false;
  }
}

async function reindexRepo(repoId, btn) {
  const busy = busyFor(repoId);
  if (busy.reindex) return;
  busy.reindex = true;
  btn.disabled = true;
  setNote(repoId, 'queued…');
  try {
    const { jobId } = await api('/api/repositories/' + encodeURIComponent(repoId) + '/reindex', { method: 'POST' });
    loadRepos(true);
    await pollJob(jobId, (job) => setNote(repoId, job.status + (job.progress ? ' — ' + job.progress : '')));
    setNote(repoId, 'reindex complete');
  } catch (err) {
    setNote(repoId, '');
    handleError(err);
  } finally {
    busy.reindex = false;
    btn.disabled = false;
    loadRepos(true);
  }
}

async function deleteRepo(repoId) {
  try {
    await api('/api/repositories/' + encodeURIComponent(repoId), { method: 'DELETE' });
    delete state.chats[repoId];
    delete state.reviews[repoId];
    state.selectedId = null;
    state.mountKey = null;
    toast('Repository deleted.');
    await loadRepos(true);
  } catch (err) {
    handleError(err);
  }
}

/* ------------------------------------------------------------ add a repo */

async function addRepo(repository, branch, btn) {
  btn.disabled = true;
  try {
    const body = { remote: 'github', repository };
    if (branch) body.branch = branch;
    const data = await api('/api/repositories', { method: 'POST', body });
    dom.addName.value = '';
    dom.addBranch.value = '';
    await loadRepos(true);
    if (data && data.repository) selectRepo(data.repository.id);
    toast('Indexing started for ' + repository + '.');
  } catch (err) {
    handleError(err);
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ init */

function init() {
  Object.assign(dom, {
    health: $('health'), version: $('version'), repoList: $('repo-list'), toasts: $('toasts'),
    tokenInput: $('token-input'), tokenHint: $('token-hint'), addName: $('add-repo-name'),
    addBranch: $('add-repo-branch'), emptyState: $('empty-state'), repoPanel: $('repo-panel'),
    repoTitle: $('repo-title'), repoMeta: $('repo-meta'), tabs: $('tabs'), tabBody: $('tab-body'),
  });

  dom.tokenInput.value = state.token;
  $('token-save').addEventListener('click', () => {
    state.token = dom.tokenInput.value.trim();
    localStorage.setItem(TOKEN_KEY, state.token);
    dom.tokenHint.textContent = 'Token saved.';
    dom.tokenHint.classList.remove('hint-error');
    loadHealth();
    loadRepos();
  });
  dom.tokenInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('token-save').click(); });

  $('refresh-repos').addEventListener('click', () => loadRepos());

  $('add-repo-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = dom.addName.value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
    if (!/^[^/\s]+\/[^/\s]+$/.test(name)) return toast('Enter the repository as owner/name.');
    addRepo(name, dom.addBranch.value.trim(), e.target.querySelector('button[type=submit]'));
  });

  dom.tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    state.tab = btn.dataset.tab;
    renderPanel();
  });

  loadHealth();
  loadRepos();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
