import { S, $, $$, api, esc, markdown, avatar, agentName, toast, view, openDialog, onSubmit, agentOptions, fileUrl, Recognition, ago } from '../core.js';

const SOURCE = (s) => (s.source === 'taught' ? '🎥 taught by demo' : s.source?.startsWith('task:') ? '💾 saved from a task' : '✍️ written');

export function renderSkills() {
  const skills = Object.values(S.skills).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  view().innerHTML = `<div class="page">
    <div class="page-head"><h2>Skills</h2><p>Reusable processes your bots follow: steps, decision rules, output requirements and approval boundaries.</p>
      <span class="spacer"></span><button class="btn-ghost" data-new>✍️ Write a skill</button><button class="btn" data-teach>🎥 Teach a task</button></div>
    ${
      skills.length
        ? `<div class="skill-grid">${skills.map(card).join('')}</div>`
        : `<div class="empty-hero"><div class="big">🎥</div><h3>Watch and learn</h3><p>Do a workflow once while a bot watches your screen. It drafts a skill you can review, test and reuse — on demand or on a schedule.</p><button class="btn" data-teach2>Teach your first task</button></div>`
    }
  </div>`;
  const v = view();
  $('[data-new]', v).addEventListener('click', () => editSkillDialog());
  $('[data-teach]', v).addEventListener('click', () => teachDialog());
  $('[data-teach2]', v)?.addEventListener('click', () => teachDialog());
  $$('[data-edit]', v).forEach((b) => b.addEventListener('click', () => editSkillDialog(S.skills[b.dataset.edit])));
  $$('[data-run]', v).forEach((b) => b.addEventListener('click', () => runSkillDialog(S.skills[b.dataset.run])));
  $$('[data-activate]', v).forEach((b) => b.addEventListener('click', () => api(`/api/skills/${b.dataset.activate}`, { method: 'PUT', body: { status: 'active' } }).then(() => toast('Skill activated — its bot now uses it.'))));
  $$('[data-del]', v).forEach((b) =>
    b.addEventListener('click', async () => {
      if (confirm('Delete this skill?')) await api(`/api/skills/${b.dataset.del}`, { method: 'DELETE' });
    }),
  );
}

function card(s) {
  const drafting = s.status === 'drafting';
  const frames = s.teach ? Array.from({ length: Math.min(4, s.teach.frames) }, (_, i) => Math.floor((i * (s.teach.frames - 1)) / 3) + 1) : [];
  return `<div class="skill-card">
    <div class="row">${s.agentId === 'any' ? '<div class="avatar sm" style="background:#555;color:#fff">∗</div>' : avatar(s.agentId, 'sm')}<span class="faint">${s.agentId === 'any' ? 'Any bot' : esc(agentName(s.agentId))}</span>
      <span class="spacer"></span><span class="status ${s.status === 'active' ? 'done' : s.status === 'failed' ? 'failed' : 'review'}">${drafting ? 'drafting…' : s.status}</span></div>
    <h3>${esc(s.name)}</h3>
    ${frames.length ? `<div class="frames">${frames.map((n) => `<img src="${fileUrl(`${s.teach.dir}/frame-${String(n).padStart(3, '0')}.jpg`)}" alt="" loading="lazy" />`).join('')}</div>` : ''}
    <p class="side-text">${drafting ? `<span class="shimmer">${esc(agentName(s.agentId === 'any' ? 'ceo' : s.agentId))} is ${s.source === 'taught' ? `watching your ${s.teach?.frames || ''}-frame recording` : 'studying the task'} and writing the steps…</span>` : esc(s.summary || s.error || '')}</p>
    <div class="faint small">${SOURCE(s)} · ${ago(s.createdAt)}${s.runs ? ` · run ${s.runs}×` : ''}</div>
    <div class="row-btns">
      ${s.status === 'draft' ? `<button class="btn" data-activate="${s.id}">Activate</button>` : ''}
      ${!drafting && s.status !== 'failed' ? `<button class="btn-ghost" data-run="${s.id}">▶ Test run</button><button class="btn-ghost" data-edit="${s.id}">Review & edit</button>` : ''}
      <button class="btn-ghost danger" data-del="${s.id}">Delete</button>
    </div>
  </div>`;
}

function editSkillDialog(s) {
  openDialog(
    s ? `Skill: ${s.name}` : 'Write a skill',
    `<form class="form" data-form>
      <div class="grid2"><label>Name<input name="name" required value="${esc(s?.name || '')}" /></label>
      <label>Owner<select name="agentId">${agentOptions(s?.agentId || 'any', { includeAny: true })}</select></label></div>
      <label>Summary<input name="summary" value="${esc(s?.summary || '')}" placeholder="What it does and when to use it" /></label>
      <label>Procedure <small>(Markdown — steps, decision rules, output requirements, approval boundaries)</small>
        <textarea name="body" rows="14" class="mono">${esc(s?.body || '**When to use**\n\n**Steps**\n1. \n\n**Decision rules**\n- \n\n**Output requirements**\n- \n\n**Approval boundaries**\n- Ask the founder before sending, publishing, buying or deleting anything.')}</textarea></label>
      <label>Status<select name="status"><option value="active" ${s?.status !== 'draft' ? 'selected' : ''}>Active — bots use it</option><option value="draft" ${s?.status === 'draft' ? 'selected' : ''}>Draft</option></select></label>
      ${s?.body ? `<details class="preview"><summary>Preview</summary><div class="md">${markdown(s.body)}</div></details>` : ''}
      <div class="row-btns end"><button class="btn" type="submit">Save skill</button></div>
    </form>`,
    (dlg, close) =>
      onSubmit($('[data-form]', dlg), async (d) => {
        await api(s ? `/api/skills/${s.id}` : '/api/skills', { method: s ? 'PUT' : 'POST', body: d });
        close();
        toast('Skill saved.');
      }),
  );
}

function runSkillDialog(s) {
  openDialog(
    `Test run: ${s.name}`,
    `<form class="form" data-form>
      <label>Bot<select name="agentId">${agentOptions(s.agentId === 'any' ? '' : s.agentId)}</select></label>
      <label>Input for this run <small>(optional)</small><textarea name="input" rows="3" placeholder="e.g. Do it for the habit-tracker product"></textarea></label>
      <label>Deadline<select name="deadlineHours"><option value="1">1 hour</option><option value="4" selected>4 hours</option><option value="24">1 day</option></select></label>
      <div class="row-btns end"><button class="btn" type="submit">Run skill</button></div>
    </form>`,
    (dlg, close) =>
      onSubmit($('[data-form]', dlg), async (d) => {
        const m = await api(`/api/skills/${s.id}/run`, { method: 'POST', body: { ...d, deadlineHours: Number(d.deadlineHours) } });
        close();
        location.hash = `#/m/${m.id}`;
      }),
  );
}

// ---------------------------------------------------------------- watch and learn

const CAPTURE_EVERY_MS = 1500;
const MAX_FRAMES = 90;
const MAX_WIDTH = 1280;

export function teachDialog() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('Screen recording needs a desktop browser (Chrome, Edge or Firefox).');
    return;
  }
  openDialog(
    'Teach a task — watch and learn',
    `<div data-step1>
      <p class="side-text">Do the workflow once while a bot watches your screen. Narrate as you go (type or speak) — it helps the bot understand <i>why</i>. When you stop, the bot studies the recording and drafts a skill for you to review.</p>
      <form class="form" data-form>
        <div class="grid2"><label>Who should learn it?<select name="agentId">${agentOptions('research')}</select></label>
        <label>Skill name<input name="name" placeholder="e.g. Weekly sales report from Stripe" /></label></div>
        <label>Notes for the bot <small>(optional)</small><textarea name="notes" rows="2" placeholder="Goal of the workflow, where the data comes from, what the result should look like"></textarea></label>
        <div class="row-btns end"><button class="btn" type="submit">🎥 Start watching</button></div>
      </form>
    </div>
    <div data-step2 hidden>
      <div class="rec-bar"><span class="rec-dot"></span><b data-timer>0:00</b><span class="faint" data-count>0 frames</span><span class="spacer"></span><button class="btn" data-stop>⏹ Stop & learn</button></div>
      <video data-preview muted playsinline></video>
      <form class="inline-form" data-note><input name="note" placeholder="Narrate: what are you doing and why? (Enter)" />${Recognition ? '<button type="button" class="btn-ghost" data-voice>🎙 Speak</button>' : ''}</form>
      <div class="frames strip" data-strip></div>
      <p class="faint small">Tip: avoid showing passwords or private data — screenshots are saved in your workspace and sent to Claude.</p>
    </div>`,
    (dlg, close) => {
      let stream, timer, video, rec;
      let frames = [];
      let pendingNote = '';
      let last = null;
      let lastKeptAt = 0;
      let started = 0;
      let meta = {};
      const canvas = document.createElement('canvas');
      const thumb = document.createElement('canvas');
      thumb.width = 32;
      thumb.height = 18;

      const stopAll = () => {
        clearInterval(timer);
        stream?.getTracks().forEach((t) => t.stop());
        rec?.stop();
      };
      dlg.addEventListener('close', stopAll);

      const capture = () => {
        if (!video.videoWidth) return;
        const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        // Skip frames where nothing changed (unless there's narration or it's been a while).
        const tc = thumb.getContext('2d', { willReadFrequently: true });
        tc.drawImage(canvas, 0, 0, 32, 18);
        const px = tc.getImageData(0, 0, 32, 18).data;
        let diff = last ? 0 : Infinity;
        if (last) for (let i = 0; i < px.length; i += 4) diff += Math.abs(px[i] - last[i]) + Math.abs(px[i + 1] - last[i + 1]) + Math.abs(px[i + 2] - last[i + 2]);
        const t = Date.now() - started;
        if (diff < 1500 && !pendingNote && t - lastKeptAt < 10000) return;
        last = px;
        lastKeptAt = t;
        frames.push({ data: canvas.toDataURL('image/jpeg', 0.6), t, note: pendingNote });
        pendingNote = '';
        if (frames.length > MAX_FRAMES) frames = frames.filter((f, i) => i % 2 === 0 || f.note); // thin evenly, keep narrated ones
        $('[data-count]', dlg).textContent = `${frames.length} frames`;
        const strip = $('[data-strip]', dlg);
        strip.insertAdjacentHTML('beforeend', `<img src="${frames.at(-1).data}" alt="" />`);
        while (strip.children.length > 8) strip.firstElementChild.remove();
      };

      const finish = async () => {
        if (!stream) return;
        capture();
        stopAll();
        stream = null;
        if (!frames.length) return toast('Nothing was recorded.');
        $('[data-stop]', dlg).disabled = true;
        $('[data-stop]', dlg).textContent = 'Uploading…';
        try {
          await api('/api/teach', { method: 'POST', body: { ...meta, frames } });
          close();
          toast('Recording received — the bot is studying it and drafting the skill.');
          location.hash = '#/skills';
        } catch (e) {
          toast(e.message);
          $('[data-stop]', dlg).disabled = false;
        }
      };

      onSubmit($('[data-form]', dlg), async (d) => {
        meta = d;
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
        video = $('[data-preview]', dlg);
        video.srcObject = stream;
        await video.play();
        stream.getVideoTracks()[0].addEventListener('ended', finish); // "Stop sharing" in the browser bar
        $('[data-step1]', dlg).hidden = true;
        $('[data-step2]', dlg).hidden = false;
        started = Date.now();
        timer = setInterval(() => {
          capture();
          const s = Math.floor((Date.now() - started) / 1000);
          $('[data-timer]', dlg).textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        }, CAPTURE_EVERY_MS);
      });

      $('[data-stop]', dlg).addEventListener('click', finish);
      $('[data-note]', dlg).addEventListener('submit', (e) => {
        e.preventDefault();
        const input = e.target.elements.note;
        if (!input.value.trim()) return;
        pendingNote = [pendingNote, input.value.trim()].filter(Boolean).join(' ');
        input.value = '';
        capture();
      });
      $('[data-voice]', dlg)?.addEventListener('click', (e) => {
        if (rec) return rec.stop();
        rec = new Recognition();
        rec.continuous = true;
        rec.lang = navigator.language || 'en-US';
        rec.onresult = (ev) => {
          const r = ev.results[ev.results.length - 1];
          if (r.isFinal) {
            pendingNote = [pendingNote, r[0].transcript.trim()].filter(Boolean).join(' ');
            capture();
          }
        };
        rec.onend = () => {
          rec = null;
          e.target.classList.remove('rec');
          e.target.textContent = '🎙 Speak';
        };
        rec.start();
        e.target.classList.add('rec');
        e.target.textContent = '🎙 Listening…';
      });
    },
  );
}
