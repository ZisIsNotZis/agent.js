// The execution worker's own body. It is fetched as a URL (`new Worker(new
// URL('./worker.js', import.meta.url))` in src/exec.js), never inlined into the
// page, so nothing of the page's memory is passed to it: the only things that
// cross are a string of source, a filename, a language and a JSON `args` value.
//
// What that limit is, said honestly: the worker shares the page's origin, so
// code it runs can `fetch` the same origin and read what that origin serves. It
// cannot read the token because the token is never sent to it. There is no
// sandbox claimed beyond that; this is a Worker, not a security boundary.
//
// JS runs natively as an ES module created from a Blob. TS is erased first,
// and only *erasable* TS: `enum`, `namespace`/`module`, decorators and
// constructor parameter properties are refused by walking the compiler's own
// AST, naming the construct and its line. The check is not a regex over text;
// and because the refusal happens before `transpileModule`, the transpiler is
// never allowed to silently emit an enum. A file that imports another module is
// refused too, with that reason, since there is no module resolution here.
//
// The TypeScript compiler is imported lazily on the first `.ts`/`.tsx` run and
// not before. `tsBytes`/`tsImports` in the reply are what the worker itself read
// from its resource timing, so the tap's price is measured where it is paid.

let tsP = null;
let tsImports = 0;

const nativeConsole = self.console;

function fmt(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

// console.log/info/debug are the program's stdout; warn/error are its stderr.
// They are lines, not a terminal: one message per call, arguments joined by a
// space, objects as JSON.
function capture(run) {
  const send = (stream) => (...parts) => {
    self.postMessage({ run, type: 'line', stream, text: parts.map(fmt).join(' ') });
  };
  self.console = {
    log: send('stdout'),
    info: send('stdout'),
    debug: send('stdout'),
    warn: send('stderr'),
    error: send('stderr'),
  };
}

function restoreConsole() {
  self.console = nativeConsole;
}

async function loadTs() {
  if (tsP) return tsP;
  tsP = (async () => {
    const mod = await import('../vendor/typescript.min.js');
    tsImports += 1;
    const entry = performance
      .getEntriesByType('resource')
      .filter((e) => e.name.includes('typescript.min.js'))
      .at(-1);
    // decodedBodySize is what the compiler's bytes are, cache or network;
    // transferSize is what the tap actually cost over the wire.
    const tsBytes = entry ? (entry.decodedBodySize || entry.transferSize || 0) : 0;
    return { ts: mod.ts ?? mod.default ?? mod, tsBytes };
  })();
  return tsP;
}

// The erasable boundary, checked on the compiler's AST rather than on source
// text. Returns null when the file is erasable, or the first offending construct
// with the file, line and what it is.
function refuseReason(ts, source, file, lang) {
  const kind = lang === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const mk = (construct, node) => ({ file, line: lineOf(node), construct });
  let found = null;

  const visit = (node) => {
    if (found) return;
    if (ts.isEnumDeclaration(node)) {
      found = mk('enum', node);
      return;
    }
    if (ts.isModuleDeclaration(node)) {
      found = mk('namespace/module', node);
      return;
    }
    if (ts.isImportEqualsDeclaration(node)
      || ts.isImportDeclaration(node)
      || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
      found = mk('import/export-from (no module resolution)', node);
      return;
    }
    const modifiers = node.modifiers;
    if (modifiers && modifiers.some((m) => m.kind === ts.SyntaxKind.Decorator)) {
      found = mk('decorator', node);
      return;
    }
    if (ts.isParameter(node)) {
      const property = modifiers && modifiers.some((m) => m.kind === ts.SyntaxKind.PublicKeyword
        || m.kind === ts.SyntaxKind.PrivateKeyword
        || m.kind === ts.SyntaxKind.ProtectedKeyword
        || m.kind === ts.SyntaxKind.ReadonlyKeyword);
      if (property) {
        found = mk('constructor parameter property', node);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

// Strip types only after the boundary has said yes. ESNext keeps the module
// syntax of the input intact; the Blob import below is what executes it.
function stripTypes(ts, source, file) {
  return ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: false,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  }).outputText;
}

function done(run, payload, started) {
  self.postMessage({ run, type: 'done', wallMs: performance.now() - started, ...payload });
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'run') return;
  const { run, source, lang = 'js', file = '<source>', args = null } = msg;
  const started = performance.now();
  capture(run);
  try {
    let js = String(source ?? '');
    let refusal = null;
    let tsBytes = 0;
    let imports = 0;

    if (lang === 'ts' || lang === 'tsx') {
      const { ts, tsBytes: bytes } = await loadTs();
      tsBytes = bytes;
      imports = tsImports;
      refusal = refuseReason(ts, js, file, lang);
      if (!refusal) js = stripTypes(ts, js, file);
    }

    if (refusal) {
      done(run, { exit: 'refused', refusal, tsBytes, tsImports: imports }, started);
      return;
    }

    globalThis.args = args;
    const url = URL.createObjectURL(new Blob([js], { type: 'text/javascript' }));
    try {
      await import(url);
    } finally {
      URL.revokeObjectURL(url);
      delete globalThis.args;
    }
    done(run, { exit: 'ok', tsBytes, tsImports: imports }, started);
  } catch (err) {
    done(run, {
      exit: 'threw',
      error: {
        name: err?.name || 'Error',
        message: err?.message ?? String(err),
        stack: err?.stack ?? '',
      },
    }, started);
  } finally {
    restoreConsole();
  }
};
