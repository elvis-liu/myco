// Detects Claude Code's TUI menus by scanning the headless terminal's bottom
// rows. Claude renders a numbered-option dialog whenever it pauses for a
// human decision (plan-mode finalization, tool-use permission prompts when
// the CLI isn't running with --dangerously-skip-permissions, occasional
// model-asked confirmations). Mycelium's web GUI can't navigate these
// dialogs, so we capture them and forward them to the discussion panel
// where the user can pick via `/decide <n>`.
//
// Detection is heuristic: look for ≥2 consecutive lines matching a numbered
// option pattern, plus a question-shaped line above them. We hash the
// (question + options) so the same dialog doesn't re-fire on every render
// tick — only on transitions (new dialog, replaced dialog, dialog cleared).

const NUMBERED_OPT_RE = /^\s*[❯>*•◦·]?\s*([0-9]+)[.)]\s+(.+?)\s*$/;

class MenuInterceptor {
  constructor() {
    // Hash of the last fired dialog, or null when there is no active dialog.
    this.currentHash = null;
  }

  // Returns one of:
  //   { kind: 'newMenu', menu: {hash, question, options, kind, rawText} }
  //   { kind: 'sameMenu' }    — the previously detected dialog is still on screen
  //   { kind: 'cleared' }     — there was a dialog, now there isn't
  //   null                    — never had one, still don't
  detectChange(headless) {
    const parsed = this._scan(headless);
    if (!parsed) {
      if (this.currentHash !== null) {
        this.currentHash = null;
        return { kind: 'cleared' };
      }
      return null;
    }
    if (parsed.hash === this.currentHash) return { kind: 'sameMenu' };
    this.currentHash = parsed.hash;
    return { kind: 'newMenu', menu: parsed };
  }

  reset() { this.currentHash = null; }

  // Scan the bottom ~16 rows of the headless terminal for a menu pattern.
  // Returns null if nothing menu-shaped is on screen, else
  // {hash, question, options: [{n, label}], kind, rawText}.
  _scan(headless) {
    if (!headless || !headless.buffer) return null;
    let lines;
    try {
      const buf = headless.buffer.active;
      const rows = headless.rows;
      lines = [];
      const startRow = Math.max(0, rows - 16);
      for (let i = startRow; i < rows; i++) {
        const line = buf.getLine(buf.viewportY + i);
        if (line) lines.push(line.translateToString(true).replace(/\s+$/, ''));
        else lines.push('');
      }
    } catch { return null; }

    // Collect candidate options. We require two adjacent (or near-adjacent)
    // numbered lines to count as a real menu — single "1." lines are common
    // in prose and would cause false positives.
    const options = [];
    let firstOptIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(NUMBERED_OPT_RE);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (!Number.isFinite(n) || n < 1 || n > 9) continue;
      const label = m[2].replace(/\s+/g, ' ').trim();
      if (!label) continue;
      // Skip stuff that looks like markdown headings or random numerics.
      if (label.length < 2) continue;
      options.push({ n, label, lineIdx: i });
      if (firstOptIdx === -1) firstOptIdx = i;
    }
    if (options.length < 2) return null;
    // Options must be roughly contiguous (allow up to 1 blank line gap).
    for (let i = 1; i < options.length; i++) {
      if (options[i].lineIdx - options[i - 1].lineIdx > 2) return null;
    }
    // Sanity: numbered 1..N in order.
    const ns = options.map((o) => o.n);
    let inOrder = true;
    for (let i = 0; i < ns.length; i++) {
      if (ns[i] !== i + 1) { inOrder = false; break; }
    }
    if (!inOrder) return null;

    // Find the question — look back up to 5 lines from firstOptIdx for a
    // non-empty line. Prefer one with a question mark or recognizable verb.
    let question = '';
    for (let i = firstOptIdx - 1; i >= Math.max(0, firstOptIdx - 5); i--) {
      const t = lines[i].trim();
      if (!t) continue;
      if (/\?\s*$/.test(t) || /what would you|allow|do you want|approve|confirm|proceed/i.test(t)) {
        question = t;
        break;
      }
      if (!question) question = t;   // fallback: nearest non-empty line
    }

    // Classify so the broadcast can use a friendlier label. Look at both
    // the question and the option labels, since Claude's plan-mode dialog
    // uses a generic "What would you like to do?" question whose options
    // are the "plan" signal. Permission signal is most reliably found on
    // option labels ("Always allow <tool>", "Don't allow", "Yes, run").
    const classBlob = (question + ' ' + options.map((o) => o.label).join(' ')).toLowerCase();
    let kind = 'generic';
    if (/allow.*\?|permission|approve.*tool|approve.*bash|bypass.*permission|always allow|don'?t allow|run this command|allow this command/i.test(classBlob)) kind = 'permission';
    else if (/plan|proceed|continue (with|the) plan|keep planning/i.test(classBlob)) kind = 'plan';

    const optsForHash = options.map((o) => ({ n: o.n, label: o.label }));
    const hash = hashMenu(question, optsForHash);
    const rawText = lines.slice(Math.max(0, firstOptIdx - 5)).join('\n');
    return { hash, kind, question, options: optsForHash, rawText };
  }
}

function hashMenu(question, options) {
  // Truncated so trivial re-renders (cursor blink, mouse hover state) don't
  // shift the hash.
  return question.slice(0, 100) + '|' + options.map((o) => `${o.n}:${o.label.slice(0, 60)}`).join('|');
}

module.exports = { MenuInterceptor, hashMenu };
