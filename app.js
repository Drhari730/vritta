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
    decisions: [],            // strings
    actions: [],              // { task, owner, due }
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
        <span>${esc(a.name)}${a.role ? ` <span class="chip-role">(${esc(a.role)})</span>` : ''}</span>
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
    if (!name) { toast('Enter a name', 'err'); return; }
    state.attendees.push({ name, role });
    $('attName').value = ''; $('attRole').value = '';
    $('attName').focus();
    renderAttendeeChips(); renderSpeakerChips(); scheduleDraftSave();
  }
  $('addAttBtn').addEventListener('click', addAttendee);
  $('attRole').addEventListener('keydown', e => { if (e.key === 'Enter') addAttendee(); });
  $('attName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('attRole').focus(); } });

  $('resetMeetingBtn').addEventListener('click', () => {
    if (state.segments.length || state.title) {
      if (!confirm('Start a fresh meeting? Any unsaved changes to the current one will be cleared.')) return;
    }
    resetMeeting();
    toast('New meeting started');
  });

  function resetMeeting() {
    stopRecording(true);
    Object.assign(state, {
      id: null, title: '', date: new Date().toISOString().split('T')[0], time: '',
      chair: '', venue: '', org: '', attendees: [], agenda: '',
      segments: [], summary: '', decisions: [], actions: [], savedAt: null
    });
    currentSpeaker = '';
    $('mDate').value = state.date;
    loadDetailsToForm();
    renderAttendeeChips();
    renderSpeakerChips();
    renderTranscript();
    showMinutesEmpty(true);
    localStorage.removeItem(DRAFT_KEY);
  }

  /* ==========================================================================
     Waveform visualiser
     ========================================================================== */
  const canvas = $('waveCanvas');
  const cctx = canvas.getContext('2d');
  let analyser = null, freqData = null, wavePhase = 0;

  function sizeCanvas() {
    const r = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = r.width * dpr; canvas.height = r.height * dpr;
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', sizeCanvas);
  sizeCanvas();

  function drawWave() {
    const w = canvas.clientWidth, h = canvas.clientHeight, mid = h / 2;
    cctx.clearRect(0, 0, w, h);
    wavePhase += 0.04;
    let amp = 0.14;
    if (rec.active && analyser && freqData) {
      analyser.getByteFrequencyData(freqData);
      let sum = 0; for (let i = 0; i < freqData.length; i++) sum += freqData[i];
      amp = Math.max(0.14, (sum / freqData.length / 120) * 1.7);
    }
    const layers = [
      { c: 'rgba(143,208,208,0.85)', a: 20, f: 0.018, sp: 1.0, lw: 2.5 },
      { c: 'rgba(192,90,46,0.7)',    a: 26, f: 0.024, sp: 1.4, lw: 1.8 },
      { c: 'rgba(255,255,255,0.35)', a: 32, f: 0.013, sp: 0.7, lw: 1.6 }
    ];
    layers.forEach(L => {
      cctx.strokeStyle = L.c; cctx.lineWidth = L.lw; cctx.beginPath();
      for (let x = 0; x <= w; x += 4) {
        const y = mid + Math.sin(x * L.f + wavePhase * L.sp) * L.a * amp
                      + Math.cos(x * 0.009 + wavePhase * 0.4) * L.a * amp * 0.35;
        x === 0 ? cctx.moveTo(x, y) : cctx.lineTo(x, y);
      }
      cctx.stroke();
    });
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

  const recordBtn = $('recordBtn');
  const recordLabel = $('recordLabel');
  const recStatus = $('recStatus');
  const liveBadge = $('liveBadge');
  const interimLine = $('interimLine');

  recordBtn.addEventListener('click', () => rec.active ? stopRecording() : startRecording());

  async function startRecording() {
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
      analyser.fftSize = 128;
      src.connect(analyser);
      freqData = new Uint8Array(analyser.frequencyBinCount);
    } catch (err) {
      toast('Microphone blocked', 'err');
      recStatus.textContent = 'Microphone access was denied. Allow it in your browser’s address bar, or type the transcript below.';
      return;
    }

    rec.active = true;
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
    analyser = null; freqData = null;
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
    toast('Minutes built — edit, save or export');
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

    // 5. Discussion / transcript (grouped by speaker when labelled)
    $('docTranscript').innerHTML = discussionHTML(state.segments);

    // 6. Decisions
    renderDecisions();

    // 7. Actions
    renderActions();

    // Sign-off
    $('signPreparedName').textContent = state.chair ? state.chair : 'Prepared by';
    $('signChairName').textContent = state.chair || 'Chair';

    $('tbSavedState').textContent = state.savedAt ? 'Saved · ' + new Date(state.savedAt).toLocaleString() : 'Unsaved draft';
  }

  // summary edits
  $('docSummary').addEventListener('input', e => { state.summary = e.target.value; scheduleDraftSave(); });
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
     Persistence — localStorage
     ========================================================================== */
  function loadAll() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
    catch (e) { return []; }
  }
  function saveAll(list) { localStorage.setItem(STORE_KEY, JSON.stringify(list)); }

  function snapshot() {
    syncDetailsFromForm();
    return {
      id: state.id, title: state.title, date: state.date, time: state.time,
      chair: state.chair, venue: state.venue, org: state.org,
      attendees: state.attendees.slice(), agenda: state.agenda,
      segments: state.segments.slice(), summary: state.summary,
      decisions: state.decisions.slice(), actions: state.actions.slice(),
      savedAt: state.savedAt
    };
  }

  $('saveMeetingBtn').addEventListener('click', saveMeeting);
  function saveMeeting() {
    syncDetailsFromForm();
    if (!state.title.trim()) { toast('Add a meeting title first', 'err'); return; }
    const list = loadAll();
    state.savedAt = Date.now();
    if (!state.id) state.id = uid();
    const rec = snapshot();
    const idx = list.findIndex(m => m.id === state.id);
    if (idx >= 0) list[idx] = rec; else list.unshift(rec);
    saveAll(list);
    localStorage.removeItem(DRAFT_KEY);
    $('tbSavedState').textContent = 'Saved · ' + new Date(state.savedAt).toLocaleString();
    toast('Meeting saved', 'ok');
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
     Saved meetings tab
     ========================================================================== */
  function renderSaved() {
    const list = loadAll();
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
      box.innerHTML = `<div class="minutes-empty" style="padding:2.5rem 1rem;"><p>No saved meetings yet. When you save a meeting it will appear here — stored privately in this browser.</p></div>`;
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
      const words = (m.segments || []).reduce((n, s) => n + s.text.split(/\s+/).length, 0);
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
            </div>
          </div>
          <div class="saved-actions">
            <button class="btn btn-primary btn-sm open-m" data-id="${m.id}">Open</button>
            <button class="btn btn-outline btn-sm word-m" data-id="${m.id}">Word</button>
            <button class="btn btn-ghost btn-sm del-m" data-id="${m.id}">Delete</button>
          </div>
        </div>`;
    }).join('');

    box.querySelectorAll('.open-m').forEach(b => b.addEventListener('click', () => openSaved(b.dataset.id)));
    box.querySelectorAll('.word-m').forEach(b => b.addEventListener('click', () => {
      const m = loadAll().find(x => x.id === b.dataset.id); if (m) exportWord(m);
    }));
    box.querySelectorAll('.del-m').forEach(b => b.addEventListener('click', () => deleteSaved(b.dataset.id)));
  }

  function openSaved(id) {
    const m = loadAll().find(x => x.id === id);
    if (!m) return;
    Object.assign(state, JSON.parse(JSON.stringify(m)));
    currentSpeaker = '';
    $('mDate').value = state.date || '';
    loadDetailsToForm();
    renderAttendeeChips();
    renderSpeakerChips();
    renderTranscript();
    renderMinutes();
    switchTab('tab-minutes');
  }

  function deleteSaved(id) {
    const m = loadAll().find(x => x.id === id);
    if (!m) return;
    if (!confirm(`Delete “${m.title || 'this meeting'}” permanently? This cannot be undone.`)) return;
    saveAll(loadAll().filter(x => x.id !== id));
    if (state.id === id) { state.id = null; state.savedAt = null; $('tbSavedState').textContent = 'Unsaved draft'; }
    renderSaved();
    toast('Meeting deleted');
  }

  $('savedSearch').addEventListener('input', renderSaved);

  /* ---------- backup export / import ---------- */
  $('exportAllBtn').addEventListener('click', () => {
    const list = loadAll();
    if (!list.length) { toast('Nothing to export yet', 'err'); return; }
    downloadBlob(JSON.stringify(list, null, 2),
      `vritta-backup-${new Date().toISOString().split('T')[0]}.json`, 'application/json');
    toast('Backup downloaded', 'ok');
  });
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const incoming = JSON.parse(reader.result);
        if (!Array.isArray(incoming)) throw new Error('bad');
        const list = loadAll();
        const byId = new Map(list.map(m => [m.id, m]));
        incoming.forEach(m => { if (m && m.id) byId.set(m.id, m); });
        saveAll(Array.from(byId.values()).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)));
        renderSaved();
        toast('Backup imported', 'ok');
      } catch (err) { toast('That file could not be read', 'err'); }
      $('importFile').value = '';
    };
    reader.readAsText(file);
  });

  /* ==========================================================================
     Exports — Print, Word (.doc HTML), Copy
     ========================================================================== */
  $('printBtn').addEventListener('click', () => {
    // Push editable field values into the printable DOM first.
    $('docTranscript').innerHTML = discussionHTML(state.segments);
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
    const tt = discussionPlain(m.segments);
    if (tt) { L.push('DISCUSSION NOTES'); L.push(tt); L.push(''); }
    if ((m.decisions || []).length) { L.push('DECISIONS'); m.decisions.forEach((d, i) => L.push(` ${i + 1}. ${d}`)); L.push(''); }
    if ((m.actions || []).length) {
      L.push('ACTION ITEMS');
      m.actions.forEach(a => L.push(` - ${a.task} — ${a.owner || 'unassigned'}${a.due ? ', due ' + prettyDate(a.due) : ''}`));
      L.push('');
    }
    return L.join('\n');
  }

  function exportWord(m) {
    const items = (m.agenda || '').split('\n').map(s => s.replace(/^[\s\-•*\d.)]+/, '').trim()).filter(Boolean);
    const turns = (m.segments || []).length ? groupTurns(m.segments) : [];
    const NAVY = '#6d1f2a', TEAL = '#9a7b1e', ACCENT = '#c8992a';
    const h = (n, t) => `<h2 style="font-family:Georgia,serif;font-size:13pt;color:${NAVY};border-bottom:1px solid #ccc;padding-bottom:3px;margin:16px 0 8px;"><span style="color:${ACCENT}">${n}.</span> ${esc(t)}</h2>`;

    let body = '';
    body += `<div style="text-align:center;border-bottom:2px solid ${ACCENT};padding-bottom:8px;margin-bottom:14px;">`;
    body += `<div style="font-weight:bold;color:${NAVY};font-size:13pt;">M. S. Ramaiah University of Applied Sciences</div>`;
    body += `<div style="color:#7c6f6a;font-size:9pt;">Bengaluru</div>`;
    if (m.org) body += `<div style="font-weight:bold;color:${NAVY};font-size:11pt;margin-top:2px;">${esc(m.org)}</div>`;
    body += `<div style="font-family:Georgia,serif;font-size:20pt;font-weight:bold;color:${NAVY};margin-top:4px;">Minutes of Meeting</div>`;
    body += `<div style="letter-spacing:2px;color:${ACCENT};font-size:8pt;">कार्यवृत्त · KARYAVRITTA</div></div>`;
    body += `<div style="text-align:center;background:#f2f5f9;padding:8px;margin-bottom:14px;"><div style="font-family:Georgia,serif;font-size:14pt;font-weight:bold;color:${NAVY};">${esc(m.title || 'Untitled meeting')}</div></div>`;

    body += h(1, 'Meeting information');
    body += '<table style="font-size:10.5pt;border-collapse:collapse;">';
    const meta = [];
    if (m.date) meta.push(['Date', prettyDate(m.date)]);
    if (m.time) meta.push(['Time', m.time]);
    if (m.venue) meta.push(['Venue / platform', m.venue]);
    if (m.chair) meta.push(['Chaired / led by', m.chair]);
    meta.forEach(([k, v]) => body += `<tr><td style="padding:2px 12px 2px 0;font-weight:bold;color:${NAVY};">${esc(k)}</td><td style="padding:2px 0;">${esc(v)}</td></tr>`);
    body += '</table>';

    if ((m.attendees || []).length) {
      body += h(2, 'Attendees');
      body += `<table style="width:100%;border-collapse:collapse;font-size:10pt;"><tr><th style="background:${NAVY};color:#fff;text-align:left;padding:5px;">Name</th><th style="background:${NAVY};color:#fff;text-align:left;padding:5px;">Role</th></tr>`;
      m.attendees.forEach(a => body += `<tr><td style="border:1px solid #ccc;padding:5px;">${esc(a.name)}</td><td style="border:1px solid #ccc;padding:5px;">${esc(a.role || '—')}</td></tr>`);
      body += '</table>';
    }
    if (items.length) { body += h(3, 'Agenda') + '<ol style="font-size:10.5pt;">' + items.map(i => `<li>${esc(i)}</li>`).join('') + '</ol>'; }
    if (m.summary) { body += h(4, 'Summary') + `<p style="font-size:10.5pt;line-height:1.6;">${esc(m.summary).replace(/\n/g, '<br>')}</p>`; }
    if (turns.length) {
      body += h(5, 'Discussion notes');
      body += turns.map(t =>
        `<p style="font-size:10.5pt;line-height:1.6;margin:0 0 6px;">${t.speaker ? `<b style="color:${NAVY}">${esc(t.speaker)}:</b> ` : ''}${esc(t.text)}</p>`
      ).join('');
    }
    if ((m.decisions || []).length) { body += h(6, 'Decisions') + '<ol style="font-size:10.5pt;line-height:1.6;">' + m.decisions.map(d => `<li>${esc(d)}</li>`).join('') + '</ol>'; }
    if ((m.actions || []).length) {
      body += h(7, 'Action items');
      body += `<table style="width:100%;border-collapse:collapse;font-size:10pt;"><tr><th style="background:${NAVY};color:#fff;text-align:left;padding:5px;">Action</th><th style="background:${NAVY};color:#fff;text-align:left;padding:5px;">Owner</th><th style="background:${NAVY};color:#fff;text-align:left;padding:5px;">Due</th></tr>`;
      m.actions.forEach(a => body += `<tr><td style="border:1px solid #ccc;padding:5px;">${esc(a.task)}</td><td style="border:1px solid #ccc;padding:5px;">${esc(a.owner || '—')}</td><td style="border:1px solid #ccc;padding:5px;">${a.due ? esc(prettyDate(a.due)) : '—'}</td></tr>`);
      body += '</table>';
    }
    body += `<table style="width:100%;margin-top:40px;font-size:10pt;"><tr><td style="width:50%;">_____________________________<br><b>${esc(m.chair || 'Prepared by')}</b><br><span style="color:#666;">Minutes prepared with Vritta</span></td><td style="width:50%;">_____________________________<br><b>${esc(m.chair || 'Chair')}</b><br><span style="color:#666;">Approved</span></td></tr></table>`;

    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>Minutes</title></head><body style="font-family:Calibri,Arial,sans-serif;color:#1f2937;">${body}</body></html>`;
    const name = 'Minutes_' + (m.title || 'Meeting').replace(/[^a-z0-9]+/gi, '_').slice(0, 40) + '.doc';
    downloadBlob('﻿' + html, name, 'application/msword');
    toast('Word document downloaded', 'ok');
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
     Init
     ========================================================================== */
  renderAttendeeChips();
  renderSpeakerChips();
  renderTranscript();
  showMinutesEmpty(true);
  restoreDraft();
})();
