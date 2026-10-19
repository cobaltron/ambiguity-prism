// §8 — interaction plumbing for the prism.
//
// Four disciplines, all of them load-bearing for the demo:
//   debounce    300–400ms after the last keystroke, plus blur, plus a ~2000ms
//               ceiling so a fast continuous typist still sees beams move.
//   sequencing  monotonic revision per request; in-flight requests are aborted on
//               new input, and any response older than the last applied is dropped.
//   hysteresis  a lit beam only extinguishes below the lower exit threshold. The
//               lit map is sent back to the server, which owns the asymmetry.
//   additive    the text the user typed is never reordered, rewritten or deleted.

const DEBOUNCE_MS = 350;
const CEILING_MS = 2000;

const el = {
  input: document.getElementById('clause'),
  shell: document.getElementById('inputShell'),
  space: document.getElementById('readingSpace'),
  empty: document.getElementById('empty'),
  regime: document.getElementById('regime'),
  sev: document.getElementById('sev'),
  latency: document.getElementById('latency'),
  banner: document.getElementById('banner'),
  chips: document.getElementById('chips'),
  vague: document.getElementById('vagueLane'),
  notes: document.getElementById('notes'),
  provenance: document.getElementById('provenance'),
};

const state = {
  revision: 0,        // monotonic; incremented per request
  applied: -1,        // highest revision rendered
  inflight: null,     // AbortController
  lit: {},            // readingId -> bool, the hysteresis carry
  meta: null,
  debounceTimer: null,
  ceilingTimer: null,
  dismissed: [],
};

const EXAMPLES = [
  {
    label: 'Worked example (forked)',
    text: 'The service should retry failed requests up to three times before returning an error.',
  },
  {
    label: 'Fix the boundary',
    fix: true,
    text: 'The service must retry a failed request up to three times in total, counting the first attempt.',
  },
  {
    label: 'Coordination',
    text: 'The gateway must compress or encrypt the response body.',
  },
  {
    label: 'Reference',
    text: 'The gateway shall forward the request to the primary server, and the worker must retry it after a timeout.',
  },
  {
    label: 'Underspecified',
    text: 'The system shall respond quickly to user actions.',
  },
];

init();

async function init() {
  buildChips();
  el.input.addEventListener('input', onInput);
  el.input.addEventListener('blur', () => schedule(0));
  window.addEventListener('beforeunload', () => state.inflight?.abort());

  try {
    state.meta = await (await fetch('/v1/meta')).json();
    renderMeta(state.meta);
  } catch {
    showBanner('Could not reach the local proxy. Start it with <code>npm run serve</code>.');
  }
  el.input.focus();
}

function renderMeta(meta) {
  el.provenance.textContent =
    'provider ' + meta.provider + ' · model ' + meta.model + ' · stance ' + meta.defaultStance;
  if (meta.synthetic) {
    showBanner(
      '<strong>Offline test double.</strong> The proxy was started with ' +
      '<code>PRISM_PROVIDER=heuristic</code>, so these values come from a small rule table, ' +
      'not from a model. The mechanism on screen is real; the numbers prove nothing.',
    );
  }
}

function showBanner(html) {
  el.banner.innerHTML = html;
  el.banner.hidden = false;
}

function buildChips() {
  for (const ex of EXAMPLES) {
    const b = document.createElement('button');
    b.className = 'chip' + (ex.fix ? ' chip-fix' : '');
    b.type = 'button';
    b.textContent = ex.label;
    b.addEventListener('click', () => {
      // Setting the field from a chip is an explicit user action, not the renderer
      // editing the author's text. The analyser itself never writes here.
      el.input.value = ex.text;
      el.input.focus();
      schedule(0);
    });
    el.chips.appendChild(b);
  }
}

function onInput() {
  schedule(DEBOUNCE_MS);
  // Ceiling: during continuous typing the debounce never expires, so fire anyway.
  if (!state.ceilingTimer) {
    state.ceilingTimer = setTimeout(() => {
      state.ceilingTimer = null;
      run();
    }, CEILING_MS);
  }
}

function schedule(delay) {
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(run, delay);
}

async function run() {
  clearTimeout(state.ceilingTimer);
  state.ceilingTimer = null;

  const text = el.input.value;
  const revision = ++state.revision;

  // Abort the in-flight request: its answer is for text that no longer exists.
  state.inflight?.abort(new DOMException('superseded', 'AbortError'));
  const controller = new AbortController();
  state.inflight = controller;

  if (!text.trim()) {
    state.lit = {};
    return reset();
  }

  const started = performance.now();
  try {
    const res = await fetch('/v1/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        single: true,
        revision,
        previous: { lit: state.lit },
        dismissed: state.dismissed.length ? { '*': state.dismissed } : null,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('proxy ' + res.status);
    const payload = await res.json();

    // Out-of-order guard: a slower earlier request must never overwrite a newer
    // render. This is what kills the flicker (§8).
    if (payload.revision < state.applied) return;
    state.applied = payload.revision;

    render(payload, Math.round(performance.now() - started));
  } catch (err) {
    if (err.name === 'AbortError') return;
    showBanner('Analysis failed: ' + err.message);
  } finally {
    if (state.inflight === controller) state.inflight = null;
  }
}

// The empty state's authored copy, kept so an error or a no-axis message cannot
// linger as the resting text once the field is cleared.
const EMPTY_HTML = el.empty.innerHTML;

function reset() {
  nodes.clear();
  el.space.replaceChildren(el.empty);
  el.empty.innerHTML = EMPTY_HTML;
  el.empty.hidden = false;
  el.regime.textContent = 'waiting';
  el.regime.dataset.regime = '';
  el.sev.textContent = '';
  el.latency.textContent = '';
  el.vague.hidden = true;
  el.notes.hidden = true;
  el.shell.style.setProperty('--sev', 0);
}

function render(payload, roundTripMs) {
  const clause = payload.clauses?.[0];
  if (!clause) return reset();

  // A failed request clears the beam space rather than leaving the last clause's
  // beams lit under new text, which would read as a verdict on what is on screen.
  if (clause.regime === 'error') {
    nodes.clear();
    el.space.replaceChildren(el.empty);
    el.empty.hidden = false;
    el.empty.textContent = 'Request failed — nothing was measured.';
    el.regime.textContent = 'request failed';
    el.regime.dataset.regime = 'error';
    el.sev.textContent = '';
    el.shell.style.setProperty('--sev', 0);
    el.vague.hidden = true;
    showBanner('<strong>Request failed.</strong> ' + escapeHtml(clause.error ?? 'unknown error') +
      ' — no reading was evaluated, so nothing on screen is a judgement about your text.');
    return;
  }
  el.banner.hidden = state.meta?.synthetic ? el.banner.hidden : true;

  // Carry the lit map forward: the next request's hysteresis is evaluated against
  // exactly what the viewer is looking at now.
  state.lit = {};
  for (const r of clause.readings ?? []) state.lit[r.id] = r.lit ?? false;

  el.regime.textContent = regimeLabel(clause);
  el.regime.dataset.regime = clause.regime;

  const sev = clause.severity ?? 0;
  el.sev.textContent = clause.regime === 'ambiguous' ? 'severity ' + sev.toFixed(2) : '';
  el.shell.style.setProperty('--sev', clause.regime === 'ambiguous' ? sev.toFixed(3) : 0);
  el.shell.style.setProperty('--accent', clause.regime === 'underspecified' ? 'var(--vague-rgb)' : 'var(--fork-rgb)');
  if (clause.regime === 'underspecified') el.shell.style.setProperty('--sev', 0.55);

  el.latency.textContent = payload.cost?.cached
    ? 'cached · ' + roundTripMs + 'ms'
    : roundTripMs + 'ms round trip';

  const interpretation = (clause.axes ?? []).filter((a) => a.lane !== 'vagueness');
  const vagueness = (clause.axes ?? []).filter((a) => a.lane === 'vagueness');

  if (interpretation.length) {
    reconcile(interpretation);
  } else {
    nodes.clear();
    el.space.replaceChildren(el.empty);
    el.empty.hidden = false;
    el.empty.innerHTML = clause.noAxisFired
      ? 'No axis fired on this clause.<br><span class="empty-rule">No reading was asked, so nothing is claimed — this is not a clean bill of health.</span>'
      : 'Waiting for a clause.';
  }

  renderVagueness(vagueness);
  renderNotes(clause, payload);
}

// Live DOM, keyed so nodes survive a re-render: axisId -> {block, beams, byId}.
// Rebuilding these nodes on every keystroke would reset every CSS transition and
// the collapse would snap instead of animating — which is the one thing the demo
// is for. So beams are updated in place and only genuinely new ones are created.
const nodes = new Map();

function reconcile(axes) {
  const seen = new Set();

  axes.forEach((axis, order) => {
    seen.add(axis.id);
    const readings = axis.top ?? axis.readings ?? [];
    let entry = nodes.get(axis.id);

    if (!entry) {
      const block = document.createElement('div');
      block.className = 'axis';
      block.dataset.axis = axis.id;
      block.innerHTML =
        '<div class="axis-head">' +
          '<span class="axis-name"></span>' +
          '<span class="axis-trigger"></span>' +
          '<span class="axis-state"></span>' +
        '</div>' +
        '<div class="beams"></div>';
      entry = {
        block,
        name: block.querySelector('.axis-name'),
        trigger: block.querySelector('.axis-trigger'),
        state: block.querySelector('.axis-state'),
        beams: block.querySelector('.beams'),
        byId: new Map(),
      };
      nodes.set(axis.id, entry);
      el.space.appendChild(block);
    }

    const stateName = axisState(axis);
    entry.block.dataset.lane = axis.lane;
    entry.block.dataset.state = stateName;
    entry.block.style.order = String(order);
    entry.name.textContent = axis.label;
    entry.trigger.textContent = axis.trigger ? '"' + axis.trigger + '"' : '';
    entry.trigger.hidden = !axis.trigger;
    entry.state.textContent = stateLabel(stateName);
    entry.beams.style.setProperty('--count', Math.max(1, readings.length));

    const converged = stateName === 'converged';
    const n = readings.length;
    const keep = new Set();

    readings.forEach((r, i) => {
      keep.add(r.id);
      let beam = entry.byId.get(r.id);
      if (!beam) {
        beam = document.createElement('div');
        beam.className = 'beam';
        beam.innerHTML =
          '<div class="beam-body">' +
            '<span class="beam-label"></span>' +
            '<span class="beam-line"></span>' +
          '</div>' +
          '<span class="beam-value"></span>';
        entry.byId.set(r.id, beam);
        entry.beams.appendChild(beam);
      }
      beam.dataset.verdict = r.verdict;
      beam.dataset.lit = String(Boolean(r.lit));
      // The only binding that matters: brightness is the raw Noul.
      beam.style.setProperty('--noul', r.noul.toFixed(3));
      // Converged beams all travel to the centre line and merge; forked ones hold
      // their separation and pulse.
      beam.style.setProperty('--offset', (converged ? 0 : (i - (n - 1) / 2) * 26).toFixed(2));
      beam.style.order = String(i);

      const label = beam.querySelector('.beam-label');
      if (label.textContent !== r.label) label.textContent = r.label;
      label.title = r.instructions ?? r.label;
      beam.querySelector('.beam-value').textContent = r.noul.toFixed(2);
    });

    for (const [id, beam] of entry.byId) {
      if (keep.has(id)) continue;
      beam.remove();
      entry.byId.delete(id);
    }
  });

  for (const [id, entry] of nodes) {
    if (seen.has(id)) continue;
    entry.block.remove();
    nodes.delete(id);
  }

  if (el.empty.parentNode) el.empty.remove();
}

function axisState(axis) {
  if (axis.lane === 'vagueness') return 'vague';
  if (axis.forked) return 'forked';
  if (axis.resolved) return 'converged';
  return 'deadzone';
}

function stateLabel(s) {
  return { forked: 'forked', converged: 'converged', deadzone: 'needs review', vague: 'underspecified' }[s] ?? s;
}

function regimeLabel(clause) {
  if (clause.regime === 'error') return 'request failed';
  if (clause.regime === 'ambiguous') return 'ambiguous';
  if (clause.regime === 'underspecified') return 'underspecified';
  if (clause.regime === 'uncertain') return 'needs review';
  if (clause.noAxisFired) return 'no axis fired';
  return 'unambiguous';
}

function renderVagueness(axes) {
  if (!axes.length) {
    el.vague.hidden = true;
    return;
  }
  const rows = axes.flatMap((a) => a.top ?? a.readings ?? []);
  el.vague.innerHTML =
    '<div class="lane-head">Vagueness — separate lane</div>' +
    rows.map((r) => '<div>' + escapeHtml(r.label) + ' · <span style="font-family:var(--mono)">' + r.noul.toFixed(2) + '</span></div>').join('') +
    '<div class="lane-why">Underspecification, not ambiguity: the fix is a number, not a disambiguation.</div>';
  el.vague.hidden = false;
}

function renderNotes(clause, payload) {
  const notes = [];
  if (clause.regime === 'uncertain') {
    notes.push('Readings sit in the dead zone (' + clause.thresholds.LOW + '–' + clause.thresholds.HIGH +
      '). Sent to review rather than silently passed.');
  }
  for (const l of clause.lint ?? []) {
    notes.push('Lint dropped a reading (' + escapeHtml(l.label) + '): ' + escapeHtml(l.problems.join('; ')) + '.');
  }
  if (clause.truncated) notes.push('Reading set truncated to keep the battery small.');
  if (payload.cost?.readings) {
    notes.push('<code>' + payload.cost.readings + '</code> readings in one batched request · ~<code>' +
      (payload.cost.estTokens || 0) + '</code> tokens.');
  }
  if (!notes.length) {
    el.notes.hidden = true;
    return;
  }
  el.notes.innerHTML = notes.join('<br>');
  el.notes.hidden = false;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
