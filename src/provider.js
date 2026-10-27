// The provider client: plain `fetch` to the base URL a person typed, with a
// model name they typed and a key they pasted. Nothing vendor-specific, no SDK,
// no relay of ours.
//
// The key is a parameter here and nowhere else. This module never stores it,
// never logs it, and never puts it in a URL: it goes in the Authorization
// header of exactly the requests the person asked for. `src/loop.js` owns the
// in-memory copy; `forget()` clears it.
//
// The wire shape is OpenAI's chat completions: `choices[0].message` carries
// either content or `tool_calls`, and `usage` is returned *verbatim* from the
// response object rather than normalised — a provider's cache fields are its
// own words, and the screen shows them as received.
//
// No retry lives here. A retry that doubles a paid turn is the loop's decision,
// recorded as its own model_call, not a silent fetch-level loop.

export class ProviderError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.body = body;
  }
}

// A person pastes either the API root (`https://host/v1`) or the full endpoint;
// both land on one URL and there is one home for that rule.
export function endpointOf(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) throw new ProviderError('no base URL was entered — nothing was sent', null, null);
  return /\/chat\/completions$/.test(b) ? b : `${b}/chat/completions`;
}

// `node` is the tree node whose loop is asking. It travels as a header, not in
// the body, for two reasons: the body is the provider's wire shape and must stay
// byte-identical for prefix stability, and a header is what a local mock can
// route per-node scripts on. No provider is expected to know the header.
export async function chatCompletion({ baseUrl, key, body, signal, node }) {
  if (!key) throw new ProviderError('no key — nothing was sent', null, null);
  const url = endpointOf(baseUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      'x-agent-node': String(node ?? 'root'),
    },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProviderError(`provider ${res.status}: response was not JSON (${text.slice(0, 200)})`, res.status, text);
  }
  if (!res.ok) {
    const why = json?.error?.message || text.slice(0, 200);
    throw new ProviderError(`provider ${res.status}: ${why}`, res.status, json);
  }
  return json;
}
