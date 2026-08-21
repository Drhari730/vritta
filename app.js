/* ==========================================================================
   Vritta (वृत्त) — Personal Meeting Notes & Minutes
   Fully client-side. No server, no fabricated data.
   - Live transcription via the browser Web Speech API (with robust auto-restart)
   - Meetings saved permanently in localStorage
   - Clean minutes built only from what was actually said + what you type
   ========================================================================== */

(function () {
  'use strict';

  const STORE_KEY = 'vritta.meetings.v1';
  const DRAFT_KEY = 'vritta.draft.v1';

  /* ---------- small helpers ---------- */
  const $ = (id) => document.getElementById(id);
  const el = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function toast(msg, kind) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.className = 'toast'; }, 2600);
  }

  function fmtClock(totalSec) {
    const s = Math.max(0, Math.floor(totalSec));
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${h}:${m}:${ss}`;
  }
  function fmtStamp(sec) {
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(Math.floor(sec % 60)).padStart(2, '0');
    return `${m}:${s}`;
  }
  function prettyDate(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  /* ==========================================================================
     Server API + session
     ========================================================================== */
  const session = { email: null, emailConfigured: false };

  async function api(path, opts) {
    const res = await fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin'
    }, opts));
    let body = null;
    try { body = await res.json(); } catch (e) {}
    if (!res.ok) {
      const err = new Error((body && body.error) || ('Request failed (' + res.status + ')'));
      err.status = res.status; err.body = body;
      throw err;
    }
    return body;
  }

  /* ==========================================================================
     State
     ========================================================================== */
  const state = {
    id: null,                 // set once saved
    title: '',
    date: new Date().toISOString().split('T')[0],
    time: '',
    chair: '',
    venue: '',
    org: '',
    attendees: [],            // { name, role }
    agenda: '',               // raw textarea text
    segments: [],             // { t: seconds, text, speaker }
    summary: '',
    discussionEdited: '',     // if the user edits the discussion text, it wins over segments
    decisions: [],            // strings
    actions: [],              // { task, owner, due, done }
    approvedBy: '',           // name & designation shown in the "Approved by" sign-off
    savedAt: null
  };

  let currentSpeaker = '';    // who is speaking "now" (manual tag; not persisted)

  /* ==========================================================================
     Tab navigation
     ========================================================================== */
  function switchTab(tabId) {
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === tabId));
    document.querySelectorAll('.nav-tab, .mob-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === tabId));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (tabId === 'tab-saved') renderSaved();
    if (tabId === 'tab-tasks') renderTasks();
  }
  document.querySelectorAll('.nav-tab, .mob-btn').forEach(b =>
    b.addEventListener('click', () => switchTab(b.dataset.tab)));

  /* ==========================================================================
     Meeting-detail form bindings
     ========================================================================== */
  $('mDate').value = state.date;

  const detailBindings = {
    mTitle: 'title', mDate: 'date', mTime: 'time',
    mChair: 'chair', mVenue: 'venue', mOrg: 'org', mAgenda: 'agenda'
  };
  Object.entries(detailBindings).forEach(([id, key]) => {
    $(id).addEventListener('input', (e) => { state[key] = e.target.value; scheduleDraftSave(); });
  });

  function loadDetailsToForm() {
    Object.entries(detailBindings).forEach(([id, key]) => { $(id).value = state[key] || ''; });
  }

  /* ---------- attendees ---------- */
  function renderAttendeeChips() {
    const box = $('attendeeChips');
    if (!state.attendees.length) {
      box.innerHTML = '<span class="empty-hint">No attendees added yet.</span>';
      return;
    }
    box.innerHTML = state.attendees.map((a, i) => `
      <span class="chip" data-i="${i}">
        <span>${esc(a.name)}${a.role ? ` <span class="chip-role">(${esc(a.role)})</span>` : ''}${a.email ? ' <span class="chip-role" title="' + esc(a.email) + '">✉</span>' : ''}</span>
        <span class="chip-x" data-i="${i}" title="Remove">&times;</span>
      </span>`).join('');
    box.querySelectorAll('.chip-x').forEach(x =>
      x.addEventListener('click', () => { state.attendees.splice(+x.dataset.i, 1); renderAttendeeChips(); renderSpeakerChips(); scheduleDraftSave(); }));
  }

  /* ---------- speaker tagging (manual "who is speaking") ---------- */
  function speakerOptions() {
    const names = state.attendees.map(a => a.name).filter(Boolean);
    // Always offer a couple of generic speakers so labelling works before
    // attendees are added, plus an explicit "Unknown".
    const generic = ['Speaker 1', 'Speaker 2', 'Speaker 3'];
    const list = names.length ? names.slice() : generic;
    list.push('Unknown');
    return list;
  }
  function renderSpeakerChips() {
    const box = $('speakerChips');
    if (!box) return;
    const opts = speakerOptions();
    if (currentSpeaker && !opts.includes(currentSpeaker)) currentSpeaker = '';
    box.innerHTML = opts.map(n =>
      `<button class="sb-chip${n === currentSpeaker ? ' active' : ''}" data-spk="${esc(n)}">${esc(n)}</button>`).join('');
    box.querySelectorAll('.sb-chip').forEach(b =>
      b.addEventListener('click', () => {
        currentSpeaker = (currentSpeaker === b.dataset.spk) ? '' : b.dataset.spk;
        renderSpeakerChips();
      }));
  }
  function addAttendee() {
    const name = $('attName').value.trim();
    const role = $('attRole').value.trim();
    const email = $('attEmail').value.trim();
    if (!name) { toast('Enter a name', 'err'); return; }
    state.attendees.push({ name, role, email });
    $('attName').value = ''; $('attRole').value = ''; $('attEmail').value = '';
    $('attName').focus();
    renderAttendeeChips(); renderSpeakerChips(); scheduleDraftSave();
  }
  $('addAttBtn').addEventListener('click', addAttendee);
  $('attEmail').addEventListener('keydown', e => { if (e.key === 'Enter') addAttendee(); });
  $('attRole').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('attEmail').focus(); } });
  $('attName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('attRole').focus(); } });

  $('resetMeetingBtn').addEventListener('click', () => {
    // Only warn when there is unsaved work; after saving, jump straight to fresh.
    const unsaved = state.segments.length && !state.savedAt;
    if (unsaved && !confirm('Start a fresh meeting? Unsaved changes to the current one will be cleared.')) return;
    resetMeeting();
    toast('New meeting — ready to record');
  });

  function resetMeeting() {
    stopRecording(true);
    Object.assign(state, {
      id: null, title: '', date: new Date().toISOString().split('T')[0], time: '',
      chair: '', venue: '', org: '', attendees: [], agenda: '',
      segments: [], summary: '', discussionEdited: '', decisions: [], actions: [], approvedBy: '', savedAt: null
    });
    currentSpeaker = '';
    sessionHasRecorded = false;
    $('mDate').value = state.date;
    loadDetailsToForm();
    renderAttendeeChips();
    renderSpeakerChips();
    renderTranscript();
    showMinutesEmpty(true);
    localStorage.removeItem(DRAFT_KEY);
    $('recStatus').textContent = 'Tap start and allow microphone access. Best in Chrome or Edge.';
    $('recTimer').textContent = '00:00:00';
    switchTab('tab-new');
    $('mTitle').focus();
  }

  /* ==========================================================================
     Waveform visualiser
     ========================================================================== */
  const canvas = $('waveCanvas');
  const cctx = canvas.getContext('2d');
  let analyser = null, freqData = null, timeData = null, wavePhase = 0;

  function sizeCanvas() {
    const r = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = r.width * dpr; canvas.height = r.height * dpr;
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', sizeCanvas);
  sizeCanvas();

  // Flowing crossing-waves visualiser (the original look) — layered sine waves
  // in teal + orange with a glowing centre dot, all reacting to the mic level.
  let ampEnv = 0.5;   // eased amplitude multiplier
  function drawWave() {
    const w = canvas.clientWidth, h = canvas.clientHeight, mid = h / 2;
    // Recorder canvas has zero size when its tab/login is covering it — skip.
    if (w <= 8 || h <= 8) { requestAnimationFrame(drawWave); return; }
    // Self-heal: if the backing store wasn't sized while visible, size it now.
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) sizeCanvas();
    cctx.clearRect(0, 0, w, h);
    wavePhase += 0.035;

    // amplitude multiplier: driven by the live mic when recording, gentle idle otherwise
    let target = 0.55;
    if (rec.active && analyser && freqData) {
      analyser.getByteFrequencyData(freqData);
      let sum = 0; for (let i = 0; i < freqData.length; i++) sum += freqData[i];
      const avg = sum / freqData.length;
      target = Math.max(0.35, (avg / 120) * 1.7);
    }
    ampEnv += (target - ampEnv) * 0.18;
    const amp = ampEnv;

    const layers = [
      { color: 'rgba(64,184,178,0.85)',  a: 24, freq: 0.015, speed: 1.0, width: 3 },   // teal
      { color: 'rgba(255,140,80,0.80)',  a: 30, freq: 0.020, speed: 1.3, width: 2 },   // orange
      { color: 'rgba(120,175,225,0.65)', a: 36, freq: 0.012, speed: 0.7, width: 2.5 }  // soft blue
    ];
    layers.forEach(L => {
      cctx.strokeStyle = L.color; cctx.lineWidth = L.width; cctx.beginPath();
      const amX = L.a * amp;
      for (let x = 0; x <= w; x += 4) {
        const y = mid + Math.sin(x * L.freq + wavePhase * L.speed) * amX
                      + Math.cos(x * 0.008 + wavePhase * 0.4) * (amX * 0.35);
        x === 0 ? cctx.moveTo(x, y) : cctx.lineTo(x, y);
      }
      cctx.stroke();
    });

    // glowing centre dot that pulses with the level
    cctx.fillStyle = '#e8541e';
    cctx.shadowColor = '#e8541e';
    cctx.shadowBlur = 14;
    cctx.beginPath();
    cctx.arc(w / 2, mid, 4 + amp * 8, 0, Math.PI * 2);
    cctx.fill();
    cctx.shadowBlur = 0;

    requestAnimationFrame(drawWave);
  }
  requestAnimationFrame(drawWave);

  /* ==========================================================================
     LIVE TRANSCRIPTION  (Web Speech API — robust)
     The core fix: finalised results are appended and kept; recognition is
     auto-restarted whenever the browser ends the session mid-meeting.
     ========================================================================== */
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = {
    active: false,          // user intends to be recording
    recog: null,
    stream: null,
    audioCtx: null,
    startedAt: 0,
    timerInt: null,
    restartTimer: null
  };

  // True once a recording has happened in THIS page session. A transcript that
  // is present without this flag came from a reload / saved / opened meeting,
  // so pressing record should start it fresh rather than append.
  let sessionHasRecorded = false;

  const recordBtn = $('recordBtn');
  const recordLabel = $('recordLabel');
  const recStatus = $('recStatus');
  const liveBadge = $('liveBadge');
  const interimLine = $('interimLine');

  recordBtn.addEventListener('click', () => rec.active ? stopRecording() : startRecording());

  async function startRecording() {
    // Recording after a saved/loaded/reloaded meeting starts a brand-new one,
    // so the new transcript & minutes are clean (details are kept to reuse/edit).
    if (!sessionHasRecorded && (state.segments.length || state.savedAt)) {
      state.id = null; state.savedAt = null;
      state.segments = []; state.discussionEdited = '';
      state.summary = ''; state.decisions = []; state.actions = []; state.approvedBy = '';
      renderTranscript();
      showMinutesEmpty(true);
      $('tbSavedState').textContent = 'Unsaved draft';
    }
    if (!SpeechRecognition) {
      toast('Live speech needs Chrome or Edge', 'err');
      recStatus.textContent = 'This browser has no built-in speech recognition. Use Chrome or Edge, or type the transcript directly below.';
      // still allow the mic waveform + manual typing
    }

    // Mic for the waveform (and to prompt permission clearly)
    try {
      rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      rec.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = rec.audioCtx.createMediaStreamSource(rec.stream);
      analyser = rec.audioCtx.createAnalyser();
      analyser.fftSize = 2048;           // time-domain samples for a smooth waveform
      analyser.smoothingTimeConstant = 0.85;
      src.connect(analyser);
      freqData = new Uint8Array(analyser.frequencyBinCount);
      timeData = new Uint8Array(analyser.fftSize);
    } catch (err) {
      toast('Microphone blocked', 'err');
      recStatus.textContent = 'Microphone access was denied. Allow it in your browser’s address bar, or type the transcript below.';
      return;
    }

    rec.active = true;
    sessionHasRecorded = true;
    rec.startedAt = Date.now();
    recordBtn.classList.add('recording');
    recordLabel.textContent = 'Stop recording';
    liveBadge.classList.add('on');
    $('transcriptEmpty').style.display = 'none';
    recStatus.textContent = 'Listening… speak naturally. Your words are saved as you go.';
    startTimer();

    if (SpeechRecognition) beginRecognition();
  }

  function beginRecognition() {
    try {
      const r = new SpeechRecognition();
      r.continuous = true;
      r.interimResults = true;
      r.lang = $('langSelect').value || 'en-IN';
      r.maxAlternatives = 1;

      r.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const res = event.results[i];
          const txt = res[0].transcript;
          if (res.isFinal) {
            const clean = txt.trim();
            if (clean) {
              const t = (Date.now() - rec.startedAt) / 1000;
              state.segments.push({ t, text: capitalise(clean), speaker: currentSpeaker || '' });
              renderTranscript();
              scheduleDraftSave();
            }
          } else {
            interim += txt;
          }
        }
        if (interim.trim()) {
          interimLine.textContent = interim;
          interimLine.style.display = 'block';
          $('transcriptBox').scrollTop = $('transcriptBox').scrollHeight;
        } else {
          interimLine.style.display = 'none';
        }
      };

      r.onerror = (e) => {
        // 'no-speech' and 'aborted' are normal during long meetings — just let onend restart.
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          recStatus.textContent = 'Speech recognition was blocked by the browser. Allow microphone access and try again.';
          stopRecording();
        } else if (e.error === 'network') {
          recStatus.textContent = 'Network hiccup — reconnecting the speech engine…';
        }
      };

      r.onend = () => {
        // The browser stops recognition periodically. If the user is still
        // recording, restart it so transcription is continuous.
        interimLine.style.display = 'none';
        if (rec.active) {
          clearTimeout(rec.restartTimer);
          rec.restartTimer = setTimeout(() => { if (rec.active) beginRecognition(); }, 250);
        }
      };

      rec.recog = r;
      r.start();
    } catch (err) {
      // start() throws if called too quickly after a stop — retry shortly.
      if (rec.active) {
        clearTimeout(rec.restartTimer);
        rec.restartTimer = setTimeout(() => { if (rec.active) beginRecognition(); }, 400);
      }
    }
  }

  function stopRecording(silent) {
    if (!rec.active && silent) return;
    rec.active = false;
    clearTimeout(rec.restartTimer);
    if (rec.recog) { try { rec.recog.onend = null; rec.recog.stop(); } catch (e) {} rec.recog = null; }
    if (rec.stream) { rec.stream.getTracks().forEach(t => t.stop()); rec.stream = null; }
    if (rec.audioCtx) { try { rec.audioCtx.close(); } catch (e) {} rec.audioCtx = null; }
    analyser = null; freqData = null; timeData = null;
    stopTimer();
    recordBtn.classList.remove('recording');
    recordLabel.textContent = 'Start recording';
    liveBadge.classList.remove('on');
    interimLine.style.display = 'none';
    if (!silent) {
      recStatus.textContent = state.segments.length
        ? 'Recording stopped. Review the transcript, then build your minutes.'
        : 'Recording stopped. Nothing was captured — check your microphone and try again.';
    }
  }

  function startTimer() {
    updateTimer();
    rec.timerInt = setInterval(updateTimer, 500);
  }
  function stopTimer() { clearInterval(rec.timerInt); }
  function updateTimer() { $('recTimer').textContent = fmtClock((Date.now() - rec.startedAt) / 1000); }

  function capitalise(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  /* ---------- transcript rendering (editable) ---------- */
  function renderTranscript() {
    const box = $('transcriptSegments');
    if (!state.segments.length) {
      box.innerHTML = '';
      $('transcriptEmpty').style.display = rec.active ? 'none' : 'block';
      return;
    }
    $('transcriptEmpty').style.display = 'none';
    box.innerHTML = state.segments.map((s, i) => {
      const prev = state.segments[i - 1];
      const changed = i === 0 || (prev && (prev.speaker || '') !== (s.speaker || ''));
      const spk = s.speaker && changed ? `<span class="t-spk">${esc(s.speaker)}:</span>` : '';
      return `
      <div class="t-seg${s.speaker && changed ? ' spk-change' : ''}" data-i="${i}">
        <span class="t-time">${fmtStamp(s.t)}</span>${spk}<span class="t-text">${esc(s.text)}</span>
      </div>`;
    }).join('');
    box.scrollTop = box.scrollHeight;
    $('transcriptBox').scrollTop = $('transcriptBox').scrollHeight;
  }

  // Let the user edit any finalised line by double-clicking it.
  $('transcriptSegments').addEventListener('dblclick', (e) => {
    const seg = e.target.closest('.t-seg');
    if (!seg) return;
    const i = +seg.dataset.i;
    const cur = state.segments[i].text;
    const next = prompt('Edit this line:', cur);
    if (next != null) {
      const v = next.trim();
      if (v) state.segments[i].text = v; else state.segments.splice(i, 1);
      renderTranscript(); scheduleDraftSave();
    }
  });

  $('clearTranscriptBtn').addEventListener('click', () => {
    if (!state.segments.length) return;
    if (!confirm('Clear the whole transcript?')) return;
    state.segments = [];
    renderTranscript(); scheduleDraftSave();
  });

  $('copyTranscriptBtn').addEventListener('click', () => {
    const text = state.segments.map(s => s.text).join('\n');
    if (!text) { toast('Nothing to copy', 'err'); return; }
    navigator.clipboard.writeText(text).then(() => toast('Transcript copied', 'ok'));
  });

  /* ==========================================================================
     Build minutes
     ========================================================================== */
  $('buildMinutesBtn').addEventListener('click', () => {
    syncDetailsFromForm();
    if (!state.title.trim()) { toast('Add a meeting title first', 'err'); $('mTitle').focus(); return; }
    renderMinutes();
    switchTab('tab-minutes');
    // Auto-draft the summary/decisions/actions the first time, if there's a transcript.
    if (state.segments.length && !state.summary && !state.decisions.length && !state.actions.length) {
      autoSummarize();
    } else {
      toast('Minutes built — edit, save or export');
    }
  });

  function syncDetailsFromForm() {
    Object.entries(detailBindings).forEach(([id, key]) => { state[key] = $(id).value; });
  }

  function agendaItems() {
    return state.agenda.split('\n').map(l => l.replace(/^[\s\-•*\d.)]+/, '').trim()).filter(Boolean);
  }
  function transcriptText() { return state.segments.map(s => s.text).join(' '); }

  // Group consecutive segments by the same speaker into turns.
  function groupTurns(segments) {
    const turns = [];
    (segments || []).forEach(s => {
      const spk = s.speaker || '';
      const last = turns[turns.length - 1];
      if (last && last.speaker === spk) last.text += ' ' + s.text;
      else turns.push({ speaker: spk, text: s.text });
    });
    return turns;
  }
  function hasSpeakers(segments) { return (segments || []).some(s => s.speaker); }

  function discussionHTML(segments) {
    if (!(segments || []).length) return 'No transcript was recorded for this meeting.';
    if (!hasSpeakers(segments)) return esc(segments.map(s => s.text).join(' '));
    return groupTurns(segments).map(t =>
      `<div class="disc-turn">${t.speaker ? `<span class="disc-spk">${esc(t.speaker)}:</span> ` : ''}${esc(t.text)}</div>`
    ).join('');
  }
  function discussionPlain(segments) {
    if (!(segments || []).length) return '';
    if (!hasSpeakers(segments)) return segments.map(s => s.text).join(' ');
    return groupTurns(segments).map(t => (t.speaker ? t.speaker + ': ' : '') + t.text).join('\n');
  }

  function showMinutesEmpty(isEmpty) {
    $('minutesEmpty').style.display = isEmpty ? 'block' : 'none';
    $('minutesDoc').style.display = isEmpty ? 'none' : 'block';
  }

  function renderMinutes() {
    showMinutesEmpty(false);

    $('docOrg').textContent = state.org || '';
    $('docOrg').style.display = state.org ? 'block' : 'none';
    $('docTitle').textContent = state.title || 'Untitled meeting';

    // 1. Meeting info
    const meta = [];
    if (state.date) meta.push(['Date', prettyDate(state.date)]);
    if (state.time) meta.push(['Time', state.time]);
    if (state.venue) meta.push(['Venue / platform', state.venue]);
    if (state.chair) meta.push(['Chaired / led by', state.chair]);
    meta.push(['Attendees', String(state.attendees.length)]);
    $('docMeta').innerHTML = meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');

    // 2. Attendees
    const attSec = $('docAttendeesSection');
    if (state.attendees.length) {
      attSec.style.display = 'block';
      el('tbody', $('docAttendeesTable')).innerHTML = state.attendees.map(a =>
        `<tr><td>${esc(a.name)}</td><td>${esc(a.role || '—')}</td></tr>`).join('');
    } else {
      attSec.style.display = 'none';
    }

    // 3. Agenda
    const items = agendaItems();
    const agSec = $('docAgendaSection');
    if (items.length) {
      agSec.style.display = 'block';
      $('docAgendaList').innerHTML = items.map(i => `<li>${esc(i)}</li>`).join('');
    } else {
      agSec.style.display = 'none';
    }

    // 4. Summary
    $('docSummary').value = state.summary || '';

    // 5. Discussion / transcript (grouped by speaker; editable, edits win)
    if (state.discussionEdited && state.discussionEdited.trim()) {
      $('docTranscript').textContent = state.discussionEdited;
    } else {
      $('docTranscript').innerHTML = discussionHTML(state.segments);
    }

    // 6. Decisions
    renderDecisions();

    // 7. Actions
    renderActions();

    // Sign-off
    $('signPreparedName').textContent = state.chair ? state.chair : 'Prepared by';
    $('signApprovedName').textContent = state.approvedBy || '';

    $('tbSavedState').textContent = state.savedAt ? 'Saved · ' + new Date(state.savedAt).toLocaleString() : 'Unsaved draft';
  }

  // summary edits
  $('docSummary').addEventListener('input', e => { state.summary = e.target.value; scheduleDraftSave(); });

  // editable minutes title (keep the Record-tab field in sync so Save keeps it)
  $('docTitle').addEventListener('input', e => {
    state.title = e.target.textContent.trim();
    $('mTitle').value = state.title;
    scheduleDraftSave();
  });
  // editable discussion notes (edits win over the raw transcript on export)
  $('docTranscript').addEventListener('input', e => {
    state.discussionEdited = e.target.innerText;
    scheduleDraftSave();
  });
  // editable "Approved by" in the sign-off
  $('signApprovedName').addEventListener('input', e => {
    state.approvedBy = e.target.textContent.trim();
    scheduleDraftSave();
  });
  $('draftSummaryBtn').addEventListener('click', () => {
    const tt = transcriptText().trim();
    if (!tt) { toast('No transcript to draft from', 'err'); return; }
    // Honest draft: just the opening of the actual transcript, clearly a starting point.
    const draft = tt.length > 480 ? tt.slice(0, 480).replace(/\s+\S*$/, '') + '…' : tt;
    $('docSummary').value = draft; state.summary = draft; scheduleDraftSave();
    toast('Opening of the transcript copied — edit as needed');
  });

  /* ---------- decisions ---------- */
  function renderDecisions() {
    const box = $('decisionsList');
    if (!state.decisions.length) {
      box.innerHTML = '<div class="empty-hint">No decisions recorded yet.</div>';
    } else {
      box.innerHTML = state.decisions.map((d, i) => `
        <div class="edit-row" data-i="${i}">
          <span class="txt">${esc(d)}</span>
          <button class="btn btn-ghost btn-sm del-dec" data-i="${i}">Remove</button>
        </div>`).join('');
      box.querySelectorAll('.del-dec').forEach(b =>
        b.addEventListener('click', () => { state.decisions.splice(+b.dataset.i, 1); renderDecisions(); scheduleDraftSave(); }));
    }
  }
  function addDecision() {
    const v = $('newDecision').value.trim();
    if (!v) return;
    state.decisions.push(v);
    $('newDecision').value = ''; $('newDecision').focus();
    renderDecisions(); scheduleDraftSave();
  }
  $('addDecisionBtn').addEventListener('click', addDecision);
  $('newDecision').addEventListener('keydown', e => { if (e.key === 'Enter') addDecision(); });

  /* ---------- actions ---------- */
  function renderActions() {
    const tb = el('tbody', $('actionsTable'));
    if (!state.actions.length) {
      tb.innerHTML = '<tr><td colspan="4" class="empty-hint" style="border:1px solid var(--rule);">No action items yet.</td></tr>';
      return;
    }
    tb.innerHTML = state.actions.map((a, i) => `
      <tr data-i="${i}">
        <td>${esc(a.task)}</td>
        <td>${esc(a.owner || '—')}</td>
        <td>${a.due ? esc(prettyDate(a.due)) : '—'}</td>
        <td><button class="btn btn-ghost btn-sm del-act" data-i="${i}" title="Remove">&times;</button></td>
      </tr>`).join('');
    tb.querySelectorAll('.del-act').forEach(b =>
      b.addEventListener('click', () => { state.actions.splice(+b.dataset.i, 1); renderActions(); scheduleDraftSave(); }));
  }
  function addAction() {
    const task = $('newActionTask').value.trim();
    if (!task) { toast('Enter a task', 'err'); return; }
    state.actions.push({ task, owner: $('newActionOwner').value.trim(), due: $('newActionDue').value });
    $('newActionTask').value = ''; $('newActionOwner').value = ''; $('newActionDue').value = '';
    $('newActionTask').focus();
    renderActions(); scheduleDraftSave();
  }
  $('addActionBtn').addEventListener('click', addAction);
  $('newActionTask').addEventListener('keydown', e => { if (e.key === 'Enter') addAction(); });

  /* ==========================================================================
     Summarization engine — drafts summary, decisions & action items from the
     transcript. Uses the server's Claude endpoint when a key is configured,
     otherwise a solid on-device analysis (nothing leaves the browser).
     ========================================================================== */
  const STOP = new Set(('a an the and or but so of to in on at for with from by as is are was were be been being this that these those it its we you they he she i our your their them us me my his her not no yes will shall can could would should may might do does did have has had okay ok right just now then here there what which who whom when where why how also about into over under out up down more most some any all each every').split(' '));

  const DECISION_RE = /\b(decided|agree(?:d)?|approv(?:e|ed|al)|resolv(?:e|ed)|finali[sz]e(?:d)?|conclud(?:e|ed)|ratif(?:y|ied)|confirm(?:ed)?|sign(?:ed)? off|go(?:ing)? ahead|will proceed|settle(?:d)? on)\b/i;
  const ACTION_RE = /\b(will|shall|need(?:s)? to|have to|has to|must|going to|plan to|to be done|action item|assign(?:ed)?|follow[ -]?up|take up|prepare|submit|circulate|draft|schedule|deliver|arrange|organi[sz]e)\b/i;
  const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

  function splitSentences(text) {
    return String(text || '').replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => s.length > 4);
  }
  function tidy(s) {
    s = s.trim().replace(/^[\-•*\d.)\s]+/, '');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // Format a Date as a local YYYY-MM-DD (no UTC shift).
  function fmtISO(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

  // Best-effort due-date parsing relative to the meeting date (or today).
  function parseDue(text) {
    const base = state.date ? new Date(state.date + 'T00:00:00') : new Date();
    const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
    if (iso) return iso[0];
    const dm = text.match(new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(' + MONTHS.join('|') + ')', 'i'));
    if (dm) {
      const y = base.getFullYear();
      const mo = MONTHS.indexOf(dm[2].toLowerCase());
      const d = new Date(y, mo, parseInt(dm[1], 10));
      if (d < base) d.setFullYear(y + 1);
      return fmtISO(d);
    }
    if (/\btomorrow\b/i.test(text)) { const d = new Date(base); d.setDate(d.getDate() + 1); return fmtISO(d); }
    if (/\bnext week\b/i.test(text)) { const d = new Date(base); d.setDate(d.getDate() + 7); return fmtISO(d); }
    const wd = text.match(new RegExp('\\b(?:by|on|before)\\s+(' + WEEKDAYS.join('|') + ')', 'i'));
    if (wd) {
      const target = WEEKDAYS.indexOf(wd[1].toLowerCase());
      const d = new Date(base); let add = (target - d.getDay() + 7) % 7; if (add === 0) add = 7;
      d.setDate(d.getDate() + add); return fmtISO(d);
    }
    return '';
  }

  function analyzeLocal(segments) {
    const segs = (segments || []).filter(s => s.text && s.text.trim());
    if (!segs.length) return { summary: '', decisions: [], actions: [] };

    // word frequencies for salience scoring
    const freq = {};
    segs.forEach(s => s.text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).forEach(w => {
      if (w.length > 2 && !STOP.has(w)) freq[w] = (freq[w] || 0) + 1;
    }));

    // build sentence units carrying their speaker
    const units = [];
    segs.forEach(s => splitSentences(s.text).forEach(sen => units.push({ sen, speaker: s.speaker || '' })));

    // summary: top-scoring sentences, kept in order
    const scored = units.map((u, i) => {
      const words = u.sen.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
      const score = words.reduce((n, w) => n + (freq[w] || 0), 0) / Math.max(6, words.length);
      return { i, sen: u.sen, score };
    });
    const want = Math.min(5, Math.max(2, Math.round(units.length * 0.25)));
    const top = scored.slice().sort((a, b) => b.score - a.score).slice(0, want).sort((a, b) => a.i - b.i);
    const summary = top.map(t => t.sen.replace(/\s*[.!?]*$/, '.')).join(' ');

    // decisions & actions
    const decisions = [];
    const actions = [];
    const seenD = new Set(), seenA = new Set();
    units.forEach(u => {
      const s = u.sen;
      if (DECISION_RE.test(s) && s.length < 240) {
        const key = s.toLowerCase().slice(0, 60);
        if (!seenD.has(key)) { seenD.add(key); decisions.push(tidy(s.replace(/\s*[.!?]*$/, '.'))); }
      }
      if (ACTION_RE.test(s) && s.length < 240) {
        const key = s.toLowerCase().slice(0, 60);
        if (!seenA.has(key)) {
          seenA.add(key);
          actions.push({ task: tidy(s.replace(/\s*[.!?]*$/, '')), owner: u.speaker || '', due: parseDue(s) });
        }
      }
    });
    return { summary, decisions: decisions.slice(0, 8), actions: actions.slice(0, 12) };
  }

  function mergeUnique(arr, incoming, keyFn) {
    const seen = new Set(arr.map(keyFn));
    incoming.forEach(x => { const k = keyFn(x); if (k && !seen.has(k)) { seen.add(k); arr.push(x); } });
  }

  function applyAnalysis(r) {
    if (r.summary) { state.summary = r.summary; $('docSummary').value = r.summary; }
    if (Array.isArray(r.decisions)) mergeUnique(state.decisions, r.decisions, d => String(d).toLowerCase().slice(0, 50));
    if (Array.isArray(r.actions)) mergeUnique(state.actions, r.actions, a => String(a.task || '').toLowerCase().slice(0, 50));
    renderDecisions(); renderActions();
    scheduleDraftSave();
  }

  function setEngineWorking(on, note) {
    const btn = $('autoSummarizeBtn');
    btn.classList.toggle('working', on);
    btn.disabled = on;
    $('autoSummarizeLabel').textContent = on ? 'Summarizing…' : 'Summarize';
    if (note) $('engineSub').textContent = note;
  }

  function autoSummarize() {
    if (!state.segments.length) { toast('Record or type something first', 'err'); return; }
    setEngineWorking(true);
    // Runs entirely on your device — no network, no API key.
    setTimeout(() => {
      applyAnalysis(analyzeLocal(state.segments));
      setEngineWorking(false, 'Drafted from your transcript on this device — edit anything below before exporting.');
      toast('Draft ready — edit before exporting', 'ok');
    }, 60);
  }
  $('autoSummarizeBtn').addEventListener('click', autoSummarize);

  /* ==========================================================================
     Persistence — server account (with a local offline cache/fallback)
     ========================================================================== */
  // Local cache mirrors the server list so the Journal still renders offline
  // and nothing is lost if a save can't reach the server (e.g. weak signal).
  function loadLocal() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
    catch (e) { return []; }
  }
  function saveLocal(list) { try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch (e) {} }
  function cacheMeeting(rec) {
    const list = loadLocal().filter(m => m.id !== rec.id);
    list.unshift(rec);
    saveLocal(list);
  }

  function snapshot() {
    syncDetailsFromForm();
    return {
      id: state.id, title: state.title, date: state.date, time: state.time,
      chair: state.chair, venue: state.venue, org: state.org,
      attendees: state.attendees.slice(), agenda: state.agenda,
      segments: state.segments.slice(), summary: state.summary,
      discussionEdited: state.discussionEdited || '',
      decisions: state.decisions.slice(), actions: state.actions.slice(),
      approvedBy: state.approvedBy || '',
      savedAt: state.savedAt
    };
  }

  $('saveMeetingBtn').addEventListener('click', saveMeeting);
  async function saveMeeting() {
    syncDetailsFromForm();
    if (!state.title.trim()) { toast('Add a meeting title first', 'err'); return; }
    if (!state.id) state.id = uid();
    state.savedAt = Date.now();
    const rec = snapshot();
    cacheMeeting(rec);                       // always keep a local copy
    try {
      const out = await api('/api/vritta/meetings', { method: 'POST', body: JSON.stringify(rec) });
      state.savedAt = out.savedAt || state.savedAt;
      localStorage.removeItem(DRAFT_KEY);
      sessionHasRecorded = false;   // next recording begins a fresh meeting
      $('tbSavedState').textContent = 'Saved to your account · ' + new Date(state.savedAt).toLocaleString();
      toast('Saved to your account', 'ok');
    } catch (err) {
      if (err.status === 401) { toast('Please sign in to save', 'err'); showLogin(); return; }
      $('tbSavedState').textContent = 'Saved offline (will sync when online)';
      toast('Saved offline — could not reach the server', 'err');
    }
  }

  /* ---------- draft autosave (so a refresh mid-meeting loses nothing) ---------- */
  let draftTimer = null;
  function scheduleDraftSave() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify(snapshot())); } catch (e) {}
    }, 600);
  }
  window.addEventListener('beforeunload', () => {
    if (rec.active || state.segments.length || state.title) {
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify(snapshot())); } catch (e) {}
    }
  });

  function restoreDraft() {
    let d;
    try { d = JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch (e) { return; }
    if (!d || (!d.title && !(d.segments && d.segments.length))) return;
    Object.assign(state, d);
    sessionHasRecorded = false;
    $('mDate').value = state.date || new Date().toISOString().split('T')[0];
    loadDetailsToForm();
    renderAttendeeChips();
    renderSpeakerChips();
    renderTranscript();
    if (state.segments.length || state.summary || state.decisions.length || state.actions.length) {
      renderMinutes();
    }
    toast('Restored your last unsaved meeting');
  }

  /* ==========================================================================
     Journal (server account, with offline cache fallback)
     ========================================================================== */
  let journalCache = [];   // list view (no segments)

  async function renderSaved() {
    const box = $('savedList');
    box.innerHTML = `<div class="empty-hint" style="padding:1rem;">Loading your journal…</div>`;
    try {
      journalCache = await api('/api/vritta/meetings');
    } catch (err) {
      if (err.status === 401) { showLogin(); return; }
      journalCache = loadLocal();   // offline fallback
      toast('Showing offline copy — could not reach the server', 'err');
    }
    paintSaved();
  }

  function paintSaved() {
    const list = journalCache;
    const q = $('savedSearch').value.trim().toLowerCase();
    const filtered = !q ? list : list.filter(m => {
      const hay = [m.title, m.chair, m.org, m.venue,
        (m.attendees || []).map(a => a.name).join(' '),
        (m.segments || []).map(s => s.text).join(' '),
        m.summary].join(' ').toLowerCase();
      return hay.includes(q);
    });

    const box = $('savedList');
    if (!list.length) {
      box.innerHTML = `<div class="minutes-empty" style="padding:2.5rem 1rem;"><p>No meetings in your journal yet. Record or type a meeting, build the minutes, then tap <strong>Save</strong> — it will be stored in your account and appear here on any device.</p></div>`;
      return;
    }
    if (!filtered.length) {
      box.innerHTML = `<div class="empty-hint" style="padding:1rem;">No meetings match “${esc(q)}”.</div>`;
      return;
    }

    box.innerHTML = filtered.map(m => {
      const d = new Date((m.date || '') + 'T00:00:00');
      const mm = isNaN(d) ? '' : d.toLocaleString('en-GB', { month: 'short' });
      const dd = isNaN(d) ? '·' : d.getDate();
      const yy = isNaN(d) ? '' : d.getFullYear();
      const words = (typeof m.wordCount === 'number') ? m.wordCount
        : (m.segments || []).reduce((n, s) => n + s.text.split(/\s+/).length, 0);
      return `
        <div class="saved-card">
          <div class="date-badge"><div class="m">${mm}</div><div class="d">${dd}</div><div class="y">${yy}</div></div>
          <div class="saved-main">
            <div class="saved-title">${esc(m.title || 'Untitled meeting')}</div>
            ${m.org ? `<div class="saved-sub">${esc(m.org)}</div>` : ''}
            <div class="saved-meta">
              ${m.chair ? `<span><strong>Chair:</strong> ${esc(m.chair)}</span>` : ''}
              <span><strong>Attendees:</strong> ${(m.attendees || []).length}</span>
              <span><strong>Words:</strong> ${words}</span>
              ${(m.actions || []).length ? `<span><strong>Actions:</strong> ${m.actions.length}</span>` : ''}
              ${m.savedAt ? `<span><strong>Saved:</strong> ${new Date(m.savedAt).toLocaleDateString()}</span>` : ''}
            </div>
          </div>
          <div class="saved-actions">
            <button class="btn btn-primary btn-sm open-m" data-id="${m.id}">Open</button>
            <button class="btn btn-ghost btn-sm del-m" data-id="${m.id}">Delete</button>
          </div>
        </div>`;
    }).join('');

    box.querySelectorAll('.open-m').forEach(b => b.addEventListener('click', () => openSaved(b.dataset.id)));
    box.querySelectorAll('.del-m').forEach(b => b.addEventListener('click', () => deleteSaved(b.dataset.id)));
  }

  async function fetchFull(id) {
    try { return await api('/api/vritta/meetings/' + encodeURIComponent(id)); }
    catch (err) { return loadLocal().find(x => x.id === id) || null; }
  }

  async function openSaved(id) {
    const m = await fetchFull(id);
    if (!m) { toast('Could not open that meeting', 'err'); return; }
    Object.assign(state, JSON.parse(JSON.stringify(m)));
    currentSpeaker = '';
    sessionHasRecorded = false;
    $('mDate').value = state.date || '';
    loadDetailsToForm();
    renderAttendeeChips();
    renderSpeakerChips();
    renderTranscript();
    renderMinutes();
    switchTab('tab-minutes');
  }

  async function deleteSaved(id) {
    const m = journalCache.find(x => x.id === id);
    if (!confirm(`Delete “${(m && m.title) || 'this meeting'}” permanently? This cannot be undone.`)) return;
    try { await api('/api/vritta/meetings/' + encodeURIComponent(id), { method: 'DELETE' }); }
    catch (err) { if (err.status === 401) { showLogin(); return; } toast('Could not delete on the server', 'err'); }
    saveLocal(loadLocal().filter(x => x.id !== id));
    if (state.id === id) { state.id = null; state.savedAt = null; $('tbSavedState').textContent = 'Unsaved draft'; }
    renderSaved();
    toast('Meeting deleted');
  }

  $('savedSearch').addEventListener('input', paintSaved);

  /* ---------- backup export / import ---------- */
  $('exportAllBtn').addEventListener('click', async () => {
    let list;
    try { list = await api('/api/vritta/meetings'); }
    catch (err) { list = loadLocal(); }
    if (!list.length) { toast('Nothing to export yet', 'err'); return; }
    const full = [];
    for (const m of list) { const f = await fetchFull(m.id); if (f) full.push(f); }
    downloadBlob(JSON.stringify(full, null, 2),
      `vritta-backup-${new Date().toISOString().split('T')[0]}.json`, 'application/json');
    toast('Backup downloaded', 'ok');
  });
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const incoming = JSON.parse(reader.result);
        if (!Array.isArray(incoming)) throw new Error('bad');
        let ok = 0;
        for (const m of incoming) {
          if (!m || !m.id || !m.title) continue;
          try { await api('/api/vritta/meetings', { method: 'POST', body: JSON.stringify(m) }); ok++; }
          catch (err) { if (err.status === 401) { showLogin(); return; } }
        }
        renderSaved();
        toast(`Imported ${ok} meeting${ok === 1 ? '' : 's'}`, 'ok');
      } catch (err) { toast('That file could not be read', 'err'); }
      $('importFile').value = '';
    };
    reader.readAsText(file);
  });

  // One-time migration: push any meetings saved in this browser (older builds)
  // up to the account, so nothing from before the login is stranded.
  async function migrateLocalToServer() {
    const local = loadLocal();
    if (!local.length) return;
    let migrated = 0;
    for (const m of local) {
      if (!m || !m.id || !m.title) continue;
      try { await api('/api/vritta/meetings', { method: 'POST', body: JSON.stringify(m) }); migrated++; }
      catch (err) { return; }
    }
    if (migrated) toast(`Moved ${migrated} earlier meeting${migrated === 1 ? '' : 's'} into your account`, 'ok');
  }

  /* ==========================================================================
     Tasks tab — every action item across all meetings, with done-toggle
     ========================================================================== */
  let taskFilter = 'open';
  let allTasks = [];

  async function renderTasks() {
    const box = $('tasksList');
    box.innerHTML = `<div class="empty-hint" style="padding:1rem;">Loading tasks…</div>`;
    let list;
    try { list = await api('/api/vritta/meetings'); journalCache = list; }
    catch (err) { if (err.status === 401) { showLogin(); return; } list = loadLocal(); }
    allTasks = [];
    list.forEach(m => (m.actions || []).forEach((a, idx) => {
      allTasks.push({ mId: m.id, mTitle: m.title, mDate: m.date, idx, task: a.task, owner: a.owner, due: a.due, done: !!a.done });
    }));
    paintTasks();
  }

  function paintTasks() {
    const box = $('tasksList');
    let tasks = allTasks.slice();
    if (taskFilter === 'open') tasks = tasks.filter(t => !t.done);
    else if (taskFilter === 'done') tasks = tasks.filter(t => t.done);
    // sort: overdue/soonest first, undated last, done at bottom
    tasks.sort((a, b) => (a.done - b.done) || ((a.due || '9999') > (b.due || '9999') ? 1 : -1));

    if (!allTasks.length) {
      box.innerHTML = `<div class="tasks-empty">No action items yet. They’re created automatically when you add action items to a meeting’s minutes.</div>`;
      return;
    }
    if (!tasks.length) {
      box.innerHTML = `<div class="tasks-empty">Nothing here — try a different filter.</div>`;
      return;
    }
    const today = new Date().toISOString().split('T')[0];
    box.innerHTML = tasks.map(t => {
      const overdue = t.due && !t.done && t.due < today;
      return `
        <div class="task-card${t.done ? ' is-done' : ''}">
          <button class="task-check${t.done ? ' done' : ''}" data-m="${t.mId}" data-i="${t.idx}" title="Mark ${t.done ? 'not done' : 'done'}">
            ${t.done ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5"/></svg>' : ''}
          </button>
          <div class="task-main">
            <div class="task-title">${esc(t.task)}</div>
            <div class="task-meta">
              ${t.owner ? `<span><strong>Owner:</strong> ${esc(t.owner)}</span>` : ''}
              ${t.due ? `<span class="task-due${overdue ? ' overdue' : ''}"><strong>Due:</strong> ${esc(prettyDate(t.due))}${overdue ? ' · overdue' : ''}</span>` : ''}
              <span class="task-src" data-open="${t.mId}">${esc(t.mTitle || 'meeting')} ↗</span>
            </div>
          </div>
        </div>`;
    }).join('');

    box.querySelectorAll('.task-check').forEach(b =>
      b.addEventListener('click', () => toggleTask(b.dataset.m, +b.dataset.i)));
    box.querySelectorAll('.task-src').forEach(s =>
      s.addEventListener('click', () => openSaved(s.dataset.open)));
  }

  async function toggleTask(mId, idx) {
    const full = await fetchFull(mId);
    if (!full || !full.actions || !full.actions[idx]) return;
    full.actions[idx].done = !full.actions[idx].done;
    try { await api('/api/vritta/meetings', { method: 'POST', body: JSON.stringify(full) }); }
    catch (err) { if (err.status === 401) { showLogin(); return; } toast('Could not update the task', 'err'); return; }
    cacheMeeting(full);
    const t = allTasks.find(t => t.mId === mId && t.idx === idx);
    if (t) t.done = full.actions[idx].done;
    // keep the open meeting's state in sync if it's the current one
    if (state.id === mId && state.actions[idx]) state.actions[idx].done = full.actions[idx].done;
    paintTasks();
  }

  document.querySelectorAll('.chip-filter').forEach(b =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.chip-filter').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      taskFilter = b.dataset.filter;
      paintTasks();
    }));

  /* ==========================================================================
     Exports — Print, Word (.doc HTML), Copy
     ========================================================================== */
  $('printBtn').addEventListener('click', () => {
    // Capture any inline edits before printing (don't clobber them).
    state.discussionEdited = $('docTranscript').innerText;
    window.print();
  });

  $('copyMinutesBtn').addEventListener('click', () => {
    navigator.clipboard.writeText(minutesPlainText(state)).then(() => toast('Minutes copied', 'ok'));
  });

  $('exportWordBtn').addEventListener('click', () => { syncDetailsFromForm(); exportWord(state); });

  function minutesPlainText(m) {
    const L = [];
    if (m.org) L.push(m.org);
    L.push('MINUTES OF MEETING');
    L.push('='.repeat(40));
    L.push((m.title || 'Untitled meeting').toUpperCase());
    L.push('');
    if (m.date) L.push('Date: ' + prettyDate(m.date));
    if (m.time) L.push('Time: ' + m.time);
    if (m.venue) L.push('Venue: ' + m.venue);
    if (m.chair) L.push('Chair: ' + m.chair);
    L.push('');
    if ((m.attendees || []).length) {
      L.push('ATTENDEES');
      m.attendees.forEach(a => L.push(' - ' + a.name + (a.role ? ' (' + a.role + ')' : '')));
      L.push('');
    }
    const items = (m.agenda || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (items.length) { L.push('AGENDA'); items.forEach((a, i) => L.push(` ${i + 1}. ${a}`)); L.push(''); }
    if (m.summary) { L.push('SUMMARY'); L.push(m.summary); L.push(''); }
    const tt = (m.discussionEdited && m.discussionEdited.trim()) ? m.discussionEdited : discussionPlain(m.segments);
    if (tt) { L.push('DISCUSSION NOTES'); L.push(tt); L.push(''); }
    if ((m.decisions || []).length) { L.push('DECISIONS'); m.decisions.forEach((d, i) => L.push(` ${i + 1}. ${d}`)); L.push(''); }
    if ((m.actions || []).length) {
      L.push('ACTION ITEMS');
      m.actions.forEach(a => L.push(` - ${a.task} — ${a.owner || 'unassigned'}${a.due ? ', due ' + prettyDate(a.due) : ''}`));
      L.push('');
    }
    return L.join('\n');
  }

  // Shared minutes body (RUAS letterhead: purple + orange). Used by both the
  // Word export and the email sender so they always match.
  const PURPLE = '#3d1a5e', ORANGE = '#e8541e';
  function buildMinutesBody(m) {
    const items = (m.agenda || '').split('\n').map(s => s.replace(/^[\s\-•*\d.)]+/, '').trim()).filter(Boolean);
    const turns = (m.segments || []).length ? groupTurns(m.segments) : [];
    const h = (n, t) => `<h2 style="font-family:Georgia,serif;font-size:13pt;color:${PURPLE};border-bottom:1px solid #ddd;padding-bottom:3px;margin:16px 0 8px;"><span style="color:${ORANGE}">${n}.</span> ${esc(t)}</h2>`;

    let body = '';
    body += `<div style="text-align:center;border-bottom:2px solid ${ORANGE};padding-bottom:8px;margin-bottom:14px;">`;
    body += `<div style="font-weight:bold;color:${PURPLE};font-size:13pt;">M. S. Ramaiah University of Applied Sciences</div>`;
    body += `<div style="color:#6f6577;font-size:9pt;">Bengaluru</div>`;
    if (m.org) body += `<div style="font-weight:bold;color:${PURPLE};font-size:11pt;margin-top:2px;">${esc(m.org)}</div>`;
    body += `<div style="font-family:Georgia,serif;font-size:20pt;font-weight:bold;color:${PURPLE};margin-top:4px;">Minutes of Meeting</div>`;
    body += `<div style="letter-spacing:2px;color:${ORANGE};font-size:8pt;">कार्यवृत्त · KARYAVRITTA</div></div>`;
    body += `<div style="text-align:center;background:#f4f0f8;padding:8px;margin-bottom:14px;"><div style="font-family:Georgia,serif;font-size:14pt;font-weight:bold;color:${PURPLE};">${esc(m.title || 'Untitled meeting')}</div></div>`;

    body += h(1, 'Meeting information');
    body += '<table style="font-size:10.5pt;border-collapse:collapse;">';
    const meta = [];
    if (m.date) meta.push(['Date', prettyDate(m.date)]);
    if (m.time) meta.push(['Time', m.time]);
    if (m.venue) meta.push(['Venue / platform', m.venue]);
    if (m.chair) meta.push(['Chaired / led by', m.chair]);
    meta.forEach(([k, v]) => body += `<tr><td style="padding:2px 12px 2px 0;font-weight:bold;color:${PURPLE};">${esc(k)}</td><td style="padding:2px 0;">${esc(v)}</td></tr>`);
    body += '</table>';

    if ((m.attendees || []).length) {
      body += h(2, 'Attendees');
      body += `<table style="width:100%;border-collapse:collapse;font-size:10pt;"><tr><th style="background:${PURPLE};color:#fff;text-align:left;padding:5px;">Name</th><th style="background:${PURPLE};color:#fff;text-align:left;padding:5px;">Role</th></tr>`;
      m.attendees.forEach(a => body += `<tr><td style="border:1px solid #ddd;padding:5px;">${esc(a.name)}</td><td style="border:1px solid #ddd;padding:5px;">${esc(a.role || '—')}</td></tr>`);
      body += '</table>';
    }
    if (items.length) { body += h(3, 'Agenda') + '<ol style="font-size:10.5pt;">' + items.map(i => `<li>${esc(i)}</li>`).join('') + '</ol>'; }
    if (m.summary) { body += h(4, 'Summary') + `<p style="font-size:10.5pt;line-height:1.6;">${esc(m.summary).replace(/\n/g, '<br>')}</p>`; }
    if (m.discussionEdited && m.discussionEdited.trim()) {
      body += h(5, 'Discussion notes') + `<p style="font-size:10.5pt;line-height:1.6;">${esc(m.discussionEdited).replace(/\n/g, '<br>')}</p>`;
    } else if (turns.length) {
      body += h(5, 'Discussion notes');
      body += turns.map(t =>
        `<p style="font-size:10.5pt;line-height:1.6;margin:0 0 6px;">${t.speaker ? `<b style="color:${PURPLE}">${esc(t.speaker)}:</b> ` : ''}${esc(t.text)}</p>`
      ).join('');
    }
    if ((m.decisions || []).length) { body += h(6, 'Decisions') + '<ol style="font-size:10.5pt;line-height:1.6;">' + m.decisions.map(d => `<li>${esc(d)}</li>`).join('') + '</ol>'; }
    if ((m.actions || []).length) {
      body += h(7, 'Action items');
      body += `<table style="width:100%;border-collapse:collapse;font-size:10pt;"><tr><th style="background:${PURPLE};color:#fff;text-align:left;padding:5px;">Action</th><th style="background:${PURPLE};color:#fff;text-align:left;padding:5px;">Owner</th><th style="background:${PURPLE};color:#fff;text-align:left;padding:5px;">Due</th></tr>`;
      m.actions.forEach(a => body += `<tr><td style="border:1px solid #ddd;padding:5px;">${esc(a.task)}</td><td style="border:1px solid #ddd;padding:5px;">${esc(a.owner || '—')}</td><td style="border:1px solid #ddd;padding:5px;">${a.due ? esc(prettyDate(a.due)) : '—'}</td></tr>`);
      body += '</table>';
    }
    body += `<table style="width:100%;margin-top:40px;font-size:10pt;"><tr><td style="width:50%;">_____________________________<br><b>${esc(m.chair || 'Prepared by')}</b><br><span style="color:#666;">Minutes prepared with Vritta</span></td><td style="width:50%;">_____________________________<br><b>${esc(m.approvedBy || '')}</b><br><span style="color:#666;">Approved by</span></td></tr></table>`;
    return body;
  }

  function exportWord(m) {
    const body = buildMinutesBody(m);
    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>Minutes</title></head><body style="font-family:Calibri,Arial,sans-serif;color:#241a2e;">${body}</body></html>`;
    const name = 'Minutes_' + (m.title || 'Meeting').replace(/[^a-z0-9]+/gi, '_').slice(0, 40) + '.doc';
    downloadBlob('﻿' + html, name, 'application/msword');
    toast('Word document downloaded', 'ok');
  }

  // Email HTML for the minutes (wrapped so it renders in an inbox).
  function minutesEmailHTML(m) {
    return `<div style="max-width:680px;margin:0 auto;font-family:Calibri,Arial,sans-serif;color:#241a2e;">${buildMinutesBody(m)}</div>`;
  }

  // Email HTML for a meeting invitation.
  function inviteEmailHTML(m) {
    const items = (m.agenda || '').split('\n').map(s => s.replace(/^[\s\-•*\d.)]+/, '').trim()).filter(Boolean);
    let b = `<div style="max-width:600px;margin:0 auto;font-family:Calibri,Arial,sans-serif;color:#241a2e;">`;
    b += `<div style="text-align:center;border-bottom:2px solid ${ORANGE};padding-bottom:8px;margin-bottom:14px;">`;
    b += `<div style="font-weight:bold;color:${PURPLE};font-size:12pt;">M. S. Ramaiah University of Applied Sciences</div>`;
    if (m.org) b += `<div style="color:#6f6577;font-size:10pt;">${esc(m.org)}</div>`;
    b += `<div style="font-family:Georgia,serif;font-size:18pt;font-weight:bold;color:${PURPLE};margin-top:4px;">Meeting Invitation</div></div>`;
    b += `<h2 style="color:${PURPLE};font-size:15pt;margin:0 0 10px;">${esc(m.title || 'Meeting')}</h2>`;
    b += '<table style="font-size:11pt;border-collapse:collapse;margin-bottom:12px;">';
    if (m.date) b += `<tr><td style="padding:3px 14px 3px 0;font-weight:bold;color:${PURPLE};">Date</td><td>${esc(prettyDate(m.date))}</td></tr>`;
    if (m.time) b += `<tr><td style="padding:3px 14px 3px 0;font-weight:bold;color:${PURPLE};">Time</td><td>${esc(m.time)}</td></tr>`;
    if (m.venue) b += `<tr><td style="padding:3px 14px 3px 0;font-weight:bold;color:${PURPLE};">Venue / platform</td><td>${esc(m.venue)}</td></tr>`;
    if (m.chair) b += `<tr><td style="padding:3px 14px 3px 0;font-weight:bold;color:${PURPLE};">Chaired by</td><td>${esc(m.chair)}</td></tr>`;
    b += '</table>';
    if (items.length) {
      b += `<h3 style="color:${PURPLE};font-size:12pt;margin:12px 0 4px;">Agenda</h3><ol style="font-size:11pt;line-height:1.6;">${items.map(i => `<li>${esc(i)}</li>`).join('')}</ol>`;
    }
    b += `<p style="font-size:10pt;color:#6f6577;margin-top:18px;border-top:1px solid #e6e1ec;padding-top:8px;">You’re invited to the above meeting. A calendar invite is attached — accept it to add it to your calendar.</p>`;
    b += `</div>`;
    return b;
  }

  function downloadBlob(content, filename, type) {
    const blob = new Blob([content], { type: type + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ==========================================================================
     Email invitations & minutes
     ========================================================================== */
  const emailModal = $('emailModal');
  let emailMode = 'invite';

  function attendeeEmails() {
    return state.attendees.map(a => a.email).filter(Boolean);
  }

  function openEmailModal(mode) {
    syncDetailsFromForm();
    if (mode === 'minutes' && $('minutesDoc').style.display === 'none') {
      toast('Build the minutes first', 'err'); return;
    }
    emailMode = mode;
    const title = state.title || 'Meeting';
    $('emailModalTitle').textContent = mode === 'invite' ? 'Email meeting invitation' : 'Email the minutes';
    $('emailModalSub').textContent = mode === 'invite'
      ? 'Sends an invitation (with a calendar file) from your account.'
      : 'Sends the full minutes from your account.';
    $('emailRecipients').value = attendeeEmails().join(', ');
    $('emailSubject').value = (mode === 'invite' ? 'Invitation: ' : 'Minutes: ') + title;
    $('emailMessage').value = mode === 'invite'
      ? `Dear all,\n\nYou are invited to "${title}"${state.date ? ' on ' + prettyDate(state.date) : ''}${state.time ? ' at ' + state.time : ''}. Details are below.\n\nRegards,\n${state.chair || ''}`.trim()
      : `Dear all,\n\nPlease find the minutes of "${title}" below.\n\nRegards,\n${state.chair || ''}`.trim();
    $('icsToggleRow').style.display = mode === 'invite' ? 'flex' : 'none';
    $('approvedByRow').style.display = mode === 'minutes' ? 'block' : 'none';
    if (mode === 'minutes') $('emailApprovedBy').value = state.approvedBy || '';

    const configured = session.emailConfigured;
    $('emailNotConfigured').style.display = configured ? 'none' : 'block';
    $('emailSendBtn').disabled = !configured;

    emailModal.classList.add('open');
  }
  function closeEmailModal() { emailModal.classList.remove('open'); }

  $('inviteBtn').addEventListener('click', () => openEmailModal('invite'));
  $('emailMinutesBtn').addEventListener('click', () => openEmailModal('minutes'));
  $('emailCancelBtn').addEventListener('click', closeEmailModal);
  emailModal.addEventListener('click', (e) => { if (e.target === emailModal) closeEmailModal(); });

  $('emailSendBtn').addEventListener('click', async () => {
    const recipients = $('emailRecipients').value.split(',').map(s => s.trim()).filter(Boolean);
    if (!recipients.length) { toast('Add at least one recipient', 'err'); return; }
    const subject = $('emailSubject').value.trim();
    const message = $('emailMessage').value.trim();
    // For the MOM, capture the "Approved by" name so it appears in the sent minutes.
    if (emailMode === 'minutes') {
      state.approvedBy = $('emailApprovedBy').value.trim();
      $('signApprovedName').textContent = state.approvedBy;
      scheduleDraftSave();
    }
    const intro = message ? `<p style="font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#241a2e;white-space:pre-wrap;">${esc(message)}</p>` : '';
    const html = intro + (emailMode === 'invite' ? inviteEmailHTML(state) : minutesEmailHTML(state));
    const withInvite = emailMode === 'invite' && $('emailAttachIcs').checked;

    const btn = $('emailSendBtn');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const out = await api('/api/vritta/invite', {
        method: 'POST',
        body: JSON.stringify({
          recipients, subject, html, withInvite,
          meeting: {
            title: state.title, date: state.date, time: state.time,
            venue: state.venue, chair: state.chair, summary: state.summary
          }
        })
      });
      const n = (out.accepted || recipients).length;
      const rej = (out.rejected || []).length;
      closeEmailModal();
      toast(`Email sent to ${n} recipient${n === 1 ? '' : 's'}${rej ? ` (${rej} rejected)` : ''}`, 'ok');
    } catch (err) {
      if (err.status === 401) { closeEmailModal(); showLogin(); return; }
      if (err.status === 503) { $('emailNotConfigured').style.display = 'block'; toast('Email is not set up yet', 'err'); }
      else { toast(err.message || 'Could not send email', 'err'); }
    } finally {
      btn.disabled = !session.emailConfigured; btn.textContent = 'Send email';
    }
  });

  /* ==========================================================================
     Authentication / session
     ========================================================================== */
  function showApp() {
    $('loginScreen').style.display = 'none';
    $('heroSection').style.display = '';
    $('appMain').style.display = '';
    $('mobileNav').style.display = '';
    $('navTabs').style.display = '';
    $('accountChip').style.display = 'flex';
    $('accountWho').textContent = session.email || '';
    // Now that the recorder is visible, give its canvas a real drawing surface.
    setTimeout(sizeCanvas, 0);
  }
  function showLogin() {
    $('loginScreen').style.display = 'flex';
    $('heroSection').style.display = 'none';
    $('appMain').style.display = 'none';
    $('mobileNav').style.display = 'none';
    $('navTabs').style.display = 'none';
    $('accountChip').style.display = 'none';
  }

  async function loadConfig() {
    try { const c = await api('/api/vritta/config'); session.emailConfigured = !!c.emailConfigured; }
    catch (e) { session.emailConfigured = false; }
  }

  async function bootstrap() {
    await loadConfig();
    try {
      const me = await api('/api/admin/me');
      session.email = me.email;
      showApp();
      await migrateLocalToServer();
      renderSaved();
    } catch (err) {
      showLogin();
    }
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('loginEmail').value.trim();
    const password = $('loginPassword').value;
    const errBox = $('loginErr');
    errBox.textContent = '';
    const btn = $('loginSubmit');
    btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const out = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      session.email = out.email || email;
      $('loginPassword').value = '';
      showApp();
      await loadConfig();
      await migrateLocalToServer();
      renderSaved();
    } catch (err) {
      errBox.textContent = err.status === 429
        ? 'Too many attempts. Please wait a few minutes and try again.'
        : 'Incorrect email or password.';
    } finally {
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  });

  $('logoutBtn').addEventListener('click', async () => {
    try { await api('/api/admin/logout', { method: 'POST' }); } catch (e) {}
    session.email = null;
    showLogin();
  });

  /* ==========================================================================
     Init
     ========================================================================== */
  renderAttendeeChips();
  renderSpeakerChips();
  renderTranscript();
  showMinutesEmpty(true);
  restoreDraft();
  bootstrap();
})();
