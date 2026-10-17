import { S, $, $$, api, esc, markdown, avatar, agentName, toast, view, openDialog, onSubmit, agentOptions, fileUrl, Recognition, ago } from '../core.js';

const SOURCE = (s) => (s.source === 'taught' ? '🎥 taught by demo' : s.source?.startsWith('task:') ? '💾 saved from a task' : s.source === 'role' ? '✨ written from the bot\'s role' : '✍️ written');

const PACK_STATUS = { installed: '✓ installed', installing: 'installing…', failed: 'failed', 'not installed': 'not installed' };

export function renderSkills() {
  const all = Object.values(S.skills).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const own = all.filter((s) => !s.path);
  const library = all.filter((s) => s.path);
  const groupOf = (s) => s.pack || '__custom';
  const packs = [{ id: '__custom', label: 'Your own skills (uploaded or from Claude Code)', status: 'installed' }, ...(S.packs || [])];
  const busyPacks = packs.some((p) => p.status === 'installing');
  const openGroups = new Set($$('details.lib-group[open]', view()).map((d) => d.dataset.pack));
  view().innerHTML = `<div class="page">
    <div class="page-head"><h2>Skills</h2><p>Reusable processes your bots follow: steps, decision rules, output requirements and approval boundaries.</p>
      <span class="spacer"></span><button class="btn-ghost" data-gen-all title="Each bot turns its role, responsibilities and specialties into step-by-step skills">✨ Write skills for every bot from its role</button><button class="btn-ghost" data-new>✍️ Write a skill</button><button class="btn" data-teach>🎥 Teach a task</button></div>

    <section class="settings packs">
      <div class="row"><h3>Skill packs</h3><span class="spacer"></span><button class="btn-ghost" data-install-all ${busyPacks ? 'disabled' : ''}>${busyPacks ? 'Installing…' : '⬇ Install / update all'}</button></div>
      <p class="side-text">Community skill libraries (the same ones <code>npx skills add</code> installs), downloaded into your workspace with git and given to the right bots. Bots open a skill's SKILL.md when a task matches it.</p>
      <div class="pack-grid">${packs
        .filter((p) => p.id !== '__custom')
        .map(
          (p) => `<div class="pack ${p.status === 'installed' ? 'ok' : p.status === 'failed' ? 'bad' : ''}">
            <b>${esc(p.label)}</b><small>${esc(p.repo)}${p.commit ? ` @ ${esc(p.commit)}` : ''}</small>
            <span class="pack-status">${PACK_STATUS[p.status] || esc(p.status)}${p.count ? ` · ${p.count} skills` : ''}${p.error ? ` — ${esc(p.error)}` : ''}</span>
            <button class="btn-ghost small-btn" data-install="${p.id}" ${p.status === 'installing' ? 'disabled' : ''}>${p.status === 'installed' ? 'Update' : 'Install'}</button>
          </div>`,
        )
        .join('')}</div>
    </section>

    <section class="settings packs">
      <div class="row"><h3>Your skill files</h3><span class="spacer"></span><button class="btn-ghost" data-import-claude title="Copy the skills Claude Code keeps on this PC (your claude.ai skills)">⟳ Import from Claude Code</button><label class="btn">⬆ Upload .skill / .zip<input type="file" accept=".skill,.zip" multiple hidden data-upload-skill /></label></div>
      <p class="side-text">Add your own skills, such as higgsfield-motion or rapha-motion-video: upload the <code>.skill</code> file you downloaded from Claude, or import the skills Claude Code keeps on this PC (<code>%USERPROFILE%\\.claude\\skills</code>, checked every start). They stay on this PC. Known skills go to the right bots automatically; the CEO assigns any skill per task.</p>
    </section>

    <h3 class="section-title">Your skills <span class="count">${own.length}</span></h3>
    ${
      own.length
        ? `<div class="skill-grid">${own.map(card).join('')}</div>`
        : `<div class="empty-hero"><div class="big">🎥</div><h3>Watch and learn</h3><p>Do a workflow once while a bot watches your screen — or click “Write skills for every bot from its role”. Skills you can review, test and reuse appear here.</p><button class="btn" data-teach2>Teach your first task</button></div>`
    }

    ${
      library.length
        ? `<h3 class="section-title">Skill library <span class="count">${library.length}</span></h3>
      <div class="library">${packs
        .filter((p) => library.some((s) => groupOf(s) === p.id))
        .map(
          (p) => `<details class="lib-group" data-pack="${p.id}" ${openGroups.has(p.id) || library.filter((s) => groupOf(s) === p.id).length <= 3 ? 'open' : ''}><summary><b>${esc(p.label)}</b> <span class="count">${library.filter((s) => groupOf(s) === p.id).length}</span></summary>
          ${library
            .filter((s) => groupOf(s) === p.id)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(
              (s) => `<div class="lib-row">
                <div class="grow"><b>${esc(s.name)}</b><small>${esc(String(s.summary).slice(0, 160))}</small></div>
                <div class="avatars">${(s.agentIds || []).includes('*') ? '<span class="tag-s">all bots</span>' : (s.agentIds || []).map((id) => avatar(id, 'sm')).join('')}</div>
                <a class="btn-ghost small-btn" href="#/files?f=${encodeURIComponent(s.path)}">View</a>
                <button class="btn-ghost small-btn" data-owners="${s.id}">Bots</button>
                <label class="switch" title="On/off"><input type="checkbox" data-toggle-skill="${s.id}" ${s.status === 'active' ? 'checked' : ''}/><span></span></label>
              </div>`,
            )
            .join('')}</details>`,
        )
        .join('')}</div>`
        : ''
    }
  </div>`;
  const v = view();
  $('[data-new]', v).addEventListener('click', () => editSkillDialog());
  $('[data-import-claude]', v).addEventListener('click', () =>
    api('/api/skills/import-claude', { method: 'POST' })
      .then((r) => toast(r.found ? `Found ${r.found} Claude Code skills — ${r.imported.length ? `added or updated: ${r.imported.join(', ')}` : 'all already up to date'}.` : 'No Claude Code skills found on this PC (%USERPROFILE%\\.claude\\skills). Upload .skill files instead.'))
      .catch((e) => toast(e.message)),
  );
  $('[data-upload-skill]', v).addEventListener('change', async (e) => {
    for (const f of e.target.files) {
      try {
        const res = await fetch(`/api/skills/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        toast(`Installed: ${data.map((s) => s.name).join(', ')}`);
      } catch (err) {
        toast(`${f.name}: ${err.message}`);
      }
    }
  });
  $('[data-teach]', v).addEventListener('click', () => teachDialog());
  $('[data-teach2]', v)?.addEventListener('click', () => teachDialog());
  $('[data-gen-all]', v).addEventListener('click', () =>
    api('/api/skills/generate-all', { method: 'POST' })
      .then(() => toast('Every bot is writing skills from its role, one after another — watch them appear here.'))
      .catch((e) => toast(e.message)),
  );
  $('[data-install-all]', v).addEventListener('click', () => api('/api/skill-packs/install', { method: 'POST', body: {} }).catch((e) => toast(e.message)));
  $$('[data-install]', v).forEach((b) => b.addEventListener('click', () => api('/api/skill-packs/install', { method: 'POST', body: { id: b.dataset.install } }).catch((e) => toast(e.message))));
  $$('[data-toggle-skill]', v).forEach((el) =>
    el.addEventListener('change', () => api(`/api/skills/${el.dataset.toggleSkill}`, { method: 'PUT', body: { status: el.checked ? 'active' : 'draft' } }).catch((e) => toast(e.message))),
  );
  $$('[data-owners]', v).forEach((b) => b.addEventListener('click', () => ownersDialog(S.skills[b.dataset.owners])));
  $$('[data-edit]', v).forEach((b) => b.addEventListener('click', () => editSkillDialog(S.skills[b.dataset.edit])));
  $$('[data-run]', v).forEach((b) => b.addEventListener('click', () => runSkillDialog(S.skills[b.dataset.run])));
  $$('[data-activate]', v).forEach((b) => b.addEventListener('click', () => api(`/api/skills/${b.dataset.activate}`, { method: 'PUT', body: { status: 'active' } }).then(() => toast('Skill activated — its bot now uses it.'))));
  $$('[data-del]', v).forEach((b) =>
    b.addEventListener('click', async () => {
      if (confirm('Delete this skill?')) await api(`/api/skills/${b.dataset.del}`, { method: 'DELETE' });
    }),
  );
}

/** Choose which bots use a library skill. */
function ownersDialog(s) {
  const owners = new Set(s.agentIds || []);
  openDialog(
    `Who uses “${s.name}”?`,
    `<form class="form" data-form>
      <p class="side-text">${esc(s.summary)}</p>
      <label class="check"><input type="checkbox" data-all ${owners.has('*') ? 'checked' : ''}/> All bots</label>
      <div class="pick">${S.agents
        .map((a) => `<label class="pick-item"><input type="checkbox" name="agentIds" data-group value="${a.id}" ${owners.has(a.id) || owners.has('*') ? 'checked' : ''}/>${avatar(a.id, 'sm')}<span>${esc(a.name)}<small>${esc(a.role)}</small></span></label>`)
        .join('')}</div>
      <div class="row-btns end"><button class="btn" type="submit">Save</button></div>
    </form>`,
    (dlg, close) => {
      const form = $('[data-form]', dlg);
      const all = $('[data-all]', dlg);
      all.addEventListener('change', () => $$('[name=agentIds]', dlg).forEach((c) => (c.checked = all.checked)));
      onSubmit(form, async (d) => {
        const ids = all.checked ? ['*'] : d.agentIds || [];
        await api(`/api/skills/${s.id}`, { method: 'PUT', body: { agentIds: ids } });
        close();
        toast('Saved.');
      });
    },
  );
}

function card(s) {
  const drafting = s.status === 'drafting';
  const frames = s.teach ? Array.from({ length: Math.min(4, s.teach.frames) }, (_, i) => Math.floor((i * (s.teach.frames - 1)) / 3) + 1) : [];
  return `<div class="skill-card">
    <div class="row">${
      !s.agentId && s.agentIds?.length
        ? `<div class="avatars">${s.agentIds.map((id) => avatar(id, 'sm')).join('')}</div><span class="faint">${s.house ? 'House standard · ' : ''}${s.agentIds.map((id) => esc(agentName(id))).join(', ')}</span>`
        : `${s.agentId === 'any' ? '<div class="avatar sm" style="background:#555;color:#fff">∗</div>' : avatar(s.agentId, 'sm')}<span class="faint">${s.agentId === 'any' ? 'Any bot' : esc(agentName(s.agentId))}${s.source === 'role' ? ' · from its role' : ''}</span>`
    }
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
