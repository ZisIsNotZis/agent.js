// The screen. Two claims, each read from the thing it is about:
//   container  <- display-mode / navigator.standalone
//   persistence<- navigator.storage.persisted()
// plus the tree, which is whatever OPFS gave back on this load.

import { boot, NoOpfs } from './state.js';
import { replaySettled } from './run.js';
import { exportBundle, importBundle, bundleText, deliverBundle, exportFilename } from './transfer.js';

const $ = (id) => document.getElementById(id);

function isStandalone() {
  if (navigator.standalone === true) return true; // iOS < 17 has no display-mode query
  try {
    return matchMedia('(display-mode: standalone)').matches ||
           matchMedia('(display-mode: fullscreen)').matches;
  } catch {
    return false;
  }
}

function renderContainer() {
  const standalone = isStandalone();
  const el = $('container');
  el.dataset.standalone = String(standalone);
  el.textContent = standalone
    ? 'Running from the Home Screen: standalone storage is its own container. '
      + 'A browser tab is a different container and does not see these files — to move '
      + 'a workspace in, export it in the tab and import it here.'
    : 'Running in a browser tab: this tab\u2019s storage is its own container. '
      + 'The same site opened from the Home Screen icon is a different container and does '
      + 'not see these files. In Safari this tab is wiped after 7 days without interaction '
      + '(ITP) — export to keep the workspace, or add to Home Screen and import it there.';
}

// Whether this load is driven by the service worker, and which shell entries are
// not in its cache. The worker answers the second from Cache Storage; the first
// is navigator.serviceWorker.controller, the thing itself.
function controllerSettled(ms = 10000) {
  if (navigator.serviceWorker.controller) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(navigator.serviceWorker.controller !== null), ms);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      clearTimeout(timer);
      resolve(true);
    }, { once: true });
  });
}

function askShell(worker, ms = 15000) {
  return new Promise((resolve, reject) => {
    if (!worker) {
      reject(new Error('no active worker'));
      return;
    }
    const ch = new MessageChannel();
    const timer = setTimeout(() => {
      ch.port1.close();
      reject(new Error(`no answer in ${ms} ms`));
    }, ms);
    ch.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data);
    };
    worker.postMessage({ type: 'shell-status' }, [ch.port2]);
  });
}

async function renderShell() {
  const el = $('shell');
  const drivenWord = (driven) => (driven
    ? 'driven by the service worker'
    : 'not driven by a service worker on this load');
  const show = (driven, missing, note = '') => {
    el.dataset.driven = String(driven);
    if (missing === null) {
      el.dataset.missing = 'unknown';
      el.textContent = `shell      ${drivenWord(driven)} — the manifest could not be read${note}`;
      return;
    }
    el.dataset.missing = missing.join(',');
    const list = missing.length
      ? `missing ${missing.join(', ')} — retried on this load and on the next`
      : 'every shell entry is cached';
    el.textContent = `shell      ${drivenWord(driven)} — ${list}${note}`;
  };
  if (!('serviceWorker' in navigator)) {
    show(false, null, ' (no service worker in this browser)');
    return;
  }
  let reg;
  try {
    reg = await navigator.serviceWorker.ready;
  } catch (e) {
    show(false, null, ` (no active registration: ${e.name})`);
    return;
  }
  const driven = await controllerSettled();
  const worker = navigator.serviceWorker.controller || reg.active;
  let state;
  try {
    state = await askShell(worker);
  } catch (e) {
    show(driven, null, `: ${e.message}`);
    return;
  }
  show(driven, state && Array.isArray(state.missing) ? state.missing : null);
}

function setStatus(text, status = 'idle') {
  const el = $('transfer-status');
  el.dataset.status = status;
  el.textContent = text;
}

const bytesOf = (text) => new TextEncoder().encode(text).length;

async function renderTransferInfo() {
  const el = $('export-info');
  try {
    const bundle = await exportBundle();
    el.textContent = `${bundle.brief} — ${bytesOf(bundleText(bundle))} bytes as one readable JSON file`;
    return bundle;
  } catch (e) {
    el.textContent = `could not be read: ${e.name}: ${e.message}`;
    return null;
  }
}

async function renderPersistence() {
  const el = $('claim');
  const value = $('persisted-value');
  let persisted;
  try {
    persisted = await navigator.storage.persisted();
  } catch (e) {
    el.dataset.persisted = 'unknown';
    value.textContent = `could not be read (${e.name}: ${e.message}) — take this screen as making no promise`;
    return;
  }
  el.dataset.persisted = String(persisted);
  value.innerHTML = '';
  const strong = document.createElement('strong');
  strong.textContent = String(persisted);
  value.append(strong, ' — ' + (persisted
    ? 'the browser has marked this origin’s storage persistent: it will not evict it on its own timer.'
    : 'the browser has not marked this origin’s storage persistent: it may evict it — under disk '
      + 'pressure anywhere, and in Safari in a tab after 7 days without interaction. '
      + 'Add to Home Screen, reopen from the icon, and ask again.'));
}

function renderInflight(replayed) {
  const el = $('inflight');
  const f = replayed.inFlight;
  if (!f) {
    el.dataset.inflight = 'none';
    el.textContent = 'in flight   nothing was in flight — the log\u2019s tail is settled';
    return;
  }
  el.dataset.inflight = `seq:${f.seq}`;
  const what = f.action === 'already settled'
    ? 'found it already settled; its result was appended exactly once'
    : 're-ran it (pure, idempotent); its result was appended exactly once';
  el.textContent = `in flight   seq ${f.seq} · ${f.tool}(${JSON.stringify(f.args)}) — ${what}`;
}

function renderTree(result, replayed) {
  const el = $('tree');
  if (!result) return;
  const s = result.verified;
  const agree = String(s.boots) === String(result.state.boots) &&
                result.bytesReadBack === result.bytesWritten;
  el.textContent = [
    `file       .agentjs/tree.json  (${result.bytesReadBack} bytes read back)`,
    `created    ${s.created}`,
    `boots      ${s.boots}${result.fresh ? '  (this load created the file)' : ''}`,
    `lastSeen   ${s.lastSeen}`,
    `log        ${replayed.records} records, last seq ${replayed.lastSeq}`,
    `nodes      ${s.nodes.map((n) => `${n.id}(${n.status})`).join(', ')}`,
    `read-back  ${agree ? 'agrees with what was written' : 'DISAGREES — do not trust the numbers above'}`,
  ].join('\n');
}

async function main() {
  renderContainer();
  await renderPersistence();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
    renderShell().catch((e) => {
      const el = $('shell');
      el.dataset.driven = 'unknown';
      el.textContent = `shell      could not be read: ${e.name}: ${e.message}`;
    });
  } else {
    renderShell();
  }

  $('persist').addEventListener('click', async () => {
    $('persist').disabled = true;
    try {
      await navigator.storage.persist();
    } catch {
      // the button's hope is not the claim; the re-read below is.
    }
    await renderPersistence();
    $('persist').disabled = false;
  });

  $('install-hint').textContent = isStandalone()
    ? 'Already opened from the Home Screen.'
    : 'iOS: Share → Add to Home Screen. Android/Chrome: menu → Install app. '
      + 'iOS 26+ opens any Home Screen site as a web app; the manifest is for older iOS and for Chrome.';

  async function doImport(text) {
    const out = await importBundle(text);
    if (!out.ok) {
      setStatus(`import refused — ${out.reason}`, 'error');
      return out;
    }
    setStatus(`imported — ${out.bundle.brief}`, 'ok');
    renderInflight(out.replayed);
    renderTree(out.result, out.replayed);
    await renderTransferInfo();
    return out;
  }

  $('export').addEventListener('click', async () => {
    $('export').disabled = true;
    try {
      const bundle = await exportBundle();
      const sent = await deliverBundle(bundle);
      if (sent.via === 'cancelled') {
        setStatus(`export cancelled — nothing left the page (${bundle.brief})`, 'error');
      } else {
        setStatus(`exported ${sent.filename} — ${sent.bytes} bytes, via ${sent.via}`, 'ok');
        $('export-info').textContent = `${bundle.brief} — ${sent.bytes} bytes as one readable JSON file`;
      }
    } catch (e) {
      setStatus(`export failed: ${e.name}: ${e.message}`, 'error');
    }
    $('export').disabled = false;
  });

  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus(`reading ${file.name} (${file.size} bytes)…`);
    try {
      await doImport(await file.text());
    } catch (err) {
      setStatus(`import failed: ${err.name}: ${err.message}`, 'error');
    }
    e.target.value = '';
  });

  $('import-paste').addEventListener('click', async () => {
    const text = $('import-text').value;
    if (!text.trim()) {
      setStatus('nothing to import — choose a file or paste a bundle into the box', 'error');
      return;
    }
    try {
      await doImport(text);
    } catch (err) {
      setStatus(`import failed: ${err.name}: ${err.message}`, 'error');
    }
  });

  try {
    const replayed = await replaySettled();
    renderInflight(replayed);
    renderTree(await boot(replayed.state), replayed);
    await renderTransferInfo();
  } catch (e) {
    $('tree').textContent = e instanceof NoOpfs
      ? `no OPFS here (${e.message}) — nothing is stored, so nothing survives a kill`
      : `the workspace could not be opened: ${e.name}: ${e.message}`;
  }
}

window.agent = { ...(window.agent || {}), exportBundle, importBundle, bundleText, deliverBundle, exportFilename };

main();
