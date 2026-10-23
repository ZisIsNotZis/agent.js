# inbox/ — the door between this project and the layer above it

This directory is the door, not a shelf. A message *to* `agent.js` lands here; a message *from* `agent.js` is written into the receiver's own `inbox/`, never kept here. The directory is tracked by git.

The shape of a message is the law's (`inbox`, `**file shape.**` and `**delete on read.**` in the workspace `AGENTS.md`): four header lines — `kind`, `from`, `spend`, `id` — then the body, then the effort at the end of the same file. One file per message, named `<YYYY-MM-DD>-<topic>.md`, dated the day it was written.

A message is read when this project next wakes. Reading it lands it — the fact into the document that owns it, the order carried out — and then the file is deleted and committed.
