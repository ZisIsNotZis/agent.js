// The screen. Two claims, each read from the thing it is about:
//   container  <- display-mode / navigator.standalone
//   persistence<- navigator.storage.persisted()
// plus the tree, which is whatever OPFS gave back on this load.

import { boot, NoOpfs } from './state.js';

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
    ? 'Running from the Home Screen: its own storage container, separate from the browser tabs. '
      + 'Open the icon, not the tab — a tab and the icon do not see the same files.'
    : 'Running in a browser tab. In Safari this container is wiped after 7 days without '
      + 'interaction (ITP); the same site added to the Home Screen is exempt. '
      + 'Tap Share → Add to Home Screen, then open the icon.';
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

function renderTree(result) {
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
    `nodes      ${s.nodes.map((n) => `${n.id}(${n.status})`).join(', ')}`,
    `read-back  ${agree ? 'agrees with what was written' : 'DISAGREES — do not trust the numbers above'}`,
  ].join('\n');
}

async function main() {
  renderContainer();
  await renderPersistence();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
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

  try {
    renderTree(await boot());
  } catch (e) {
    $('tree').textContent = e instanceof NoOpfs
      ? `no OPFS here (${e.message}) — nothing is stored, so nothing survives a kill`
      : `the workspace could not be opened: ${e.name}: ${e.message}`;
  }
}

main();
