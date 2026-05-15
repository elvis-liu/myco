// SDK-driven session — parallel to PtySession (server/src/pty.js).
//
// Spawned when sessions.spawnSession() is called with opts.mode='agent'.
// Wraps @anthropic-ai/claude-agent-sdk's query() and exposes a session
// interface compatible with the WS attach plumbing:
//
//   .alive, .pendingMenu, .sessionId, .mode='agent', .buffer (event ring)
//   .emit('agent-event' | 'chat' | 'state-update' | 'exit' | 'idle')
//   .write(text) — enqueue + run next turn (resumes SDK session by id)
//   .kill() — abort the in-flight iteration
//
// Phase 1 scope (this commit): minimal. canUseTool auto-denies anything
// that needs interactive approval — the chat-pane menu routing arrives
// in phase 2. Streaming-input (true multi-turn) arrives in phase 4;
// for now each .write() spawns a fresh query() with resume=sdkSessionId,
// which is one extra RTT per turn but keeps the implementation small.
//
// See agent-sdk-migration-plan.md on this branch for the full phasing.

const { EventEmitter } = require('events');
const crypto = require('crypto');
const { query } = require('@anthropic-ai/claude-agent-sdk');

const MAX_EVENTS = 500;

// Truncate Claude's tool inputs to a chat-card-sized blurb.
function _summariseToolInput(name, input) {
  try {
    if (name === 'Bash') return String((input && input.command) || '').slice(0, 200);
    if (name === 'Read' || name === 'Edit' || name === 'Write') return String((input && input.file_path) || '').slice(0, 200);
    if (name === 'Glob' || name === 'Grep') {
      const q = (input && (input.pattern || input.query)) || '';
      const p = (input && input.path) ? ` in ${input.path}` : '';
      return (q + p).slice(0, 200);
    }
    if (name === 'WebFetch') return String((input && input.url) || '').slice(0, 200);
    return JSON.stringify(input || {}).slice(0, 200);
  } catch { return ''; }
}

class AgentSession extends EventEmitter {
  constructor(sessionId, opts = {}) {
    super();
    this.sessionId = sessionId;                  // myco's session id
    this.mode = 'agent';
    this.alive = true;
    this.cwd = opts.cwd || process.cwd();
    this.cols = opts.cols || 120;                // for resize compat (no-op semantically)
    this.rows = opts.rows || 30;

    // SDK session id captured from the first system/init event — used
    // to resume on subsequent turns so cache stays warm and context
    // persists across user messages.
    this.sdkSessionId = null;
    // Latest model + tool list reported by system/init; useful for the
    // attach-snapshot a freshly-connecting client should see.
    this._initSnapshot = null;
    // pendingMenu mirrors PtySession's field — set when a menu was
    // emitted, cleared when answered. Phase 2 wires it up; for now
    // stays null because canUseTool auto-denies.
    this.pendingMenu = null;
    // Status / mode hooks for compatibility with attach-snapshot
    // plumbing. We populate _lastStatus minimally from result events.
    this._lastStatus = null;
    this._lastMode = 'default';
    // Tool-progress tracker mirrors PtySession.openToolCalls so the
    // chat pane's existing "waiting on Tool · 47s" indicator works
    // for agent sessions too.
    this.openToolCalls = new Map();

    // Per-session event ring buffer for reattach replay (phase 5
    // expands this with capped size + resume semantics).
    this.buffer = [];

    // Turn-queue + in-flight tracker so .write() during a running
    // iteration enqueues instead of overlapping queries.
    this._queue = [];
    this._inFlight = null;
    this._abortController = null;

    // Phase 2: chat-pane menu integration. Each canUseTool fire stores
    // its resolve fn + the structured request here keyed by a hash; the
    // chat-pane menu pick (handleMenuPick in pty.js) reaches in via
    // resolveMenuPick(hash, n) to settle the pending promise so the
    // SDK iteration can continue with the user's choice.
    this._pendingPermissions = new Map();

    // If an initial prompt was passed, auto-kick the first turn.
    if (opts.initialPrompt) {
      // Defer one tick so listeners attached after construction still
      // see the first events. PtySession has the same pattern via the
      // PTY's own onData scheduling.
      setImmediate(() => this._runTurn(opts.initialPrompt));
    }
  }

  // Single source of truth for sending a user message to the SDK.
  // Each call to .write() ends up here (directly if idle, or via the
  // queue drain when the prior turn finishes).
  async _runTurn(promptText) {
    if (!this.alive) return;
    if (this._inFlight) {
      this._queue.push(promptText);
      return;
    }
    this._abortController = new AbortController();

    const sdkOpts = {
      cwd: this.cwd,
      permissionMode: 'default',
      abortSignal: this._abortController.signal,
      canUseTool: (toolName, input, ctx) => this._canUseTool(toolName, input, ctx),
    };
    if (this.sdkSessionId) sdkOpts.resume = this.sdkSessionId;

    let stream;
    try {
      stream = query({ prompt: promptText, options: sdkOpts });
    } catch (err) {
      this._emit({ type: 'fatal', error: String((err && err.message) || err) });
      this._afterTurn();
      return;
    }
    this._inFlight = stream;
    this._emit({ type: 'turn_start', prompt: String(promptText).slice(0, 200) });

    try {
      for await (const m of stream) {
        if (!this.alive) break;
        this._handleEvent(m);
      }
    } catch (err) {
      this._emit({ type: 'fatal', error: String((err && err.message) || err) });
    }
    this._afterTurn();
  }

  _afterTurn() {
    this._inFlight = null;
    this._abortController = null;
    if (!this.alive) return;
    if (this._queue.length) {
      const next = this._queue.shift();
      this._runTurn(next);
      return;
    }
    this.emit('idle');
  }

  // Normalise SDK events into the flatter shape the WS frame ships.
  // Two reasons: (1) the SDK's events are large structured objects with
  // nested content arrays — flattening here keeps every consumer simple;
  // (2) the field names become OUR contract instead of the SDK's, so
  // future SDK upgrades that rename fields are absorbed in one place.
  _handleEvent(m) {
    if (m.type === 'system' && m.subtype === 'init') {
      this.sdkSessionId = m.session_id || (m.data && m.data.session_id) || this.sdkSessionId;
      this._initSnapshot = {
        sdkSessionId: this.sdkSessionId,
        model: m.model || (m.data && m.data.model) || null,
        tools: m.tools || (m.data && m.data.tools) || [],
        cwd: this.cwd,
      };
      this._emit({ type: 'system_init', ...this._initSnapshot });
      return;
    }
    if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
      for (const block of m.message.content) {
        if (block.type === 'text') {
          this._emit({ type: 'assistant_text', text: block.text || '' });
        } else if (block.type === 'tool_use') {
          this.openToolCalls.set(block.id, {
            name: block.name,
            summary: _summariseToolInput(block.name, block.input),
            ts: new Date().toISOString(),
          });
          this._emit({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          });
          this._broadcastToolProgress();
        }
      }
      return;
    }
    if (m.type === 'user' && m.message && Array.isArray(m.message.content)) {
      for (const block of m.message.content) {
        if (block.type === 'tool_result') {
          this.openToolCalls.delete(block.tool_use_id);
          const content = typeof block.content === 'string'
            ? block.content
            : (Array.isArray(block.content)
              ? block.content.map((c) => c.text || '').join('')
              : '');
          this._emit({
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content,
            isError: !!block.is_error,
          });
          this._broadcastToolProgress();
        }
      }
      return;
    }
    if (m.type === 'result') {
      this._lastStatus = null;  // SDK signals completion; no spinner equivalent
      this._emit({
        type: 'turn_result',
        subtype: m.subtype,
        result: m.result,
        usage: m.usage,
        totalCostUsd: m.total_cost_usd,
      });
      return;
    }
    if (m.type === 'rate_limit_event') {
      this._emit({ type: 'rate_limit', raw: m });
      return;
    }
    // Unknown event types — passthrough so phase 2+ can decide what to do.
    this._emit({ type: 'unknown_event', raw_type: m.type, raw: m });
  }

  // Synthesize a chat-pane menu from a canUseTool fire, broadcast it via
  // the existing 'menu' event pipeline (so menuMod.handleSessionMenu →
  // broadcastMenuToChat fires unchanged), and return a Promise that
  // resolves when the user clicks an option in the chat pane (the click
  // arrives via WS as menu-pick → pty.handleMenuPick → this session's
  // resolveMenuPick(hash, n)).
  //
  // Two flavours:
  //
  //   1. AskUserQuestion — Claude has clarifying questions for the user.
  //      input.questions[0] becomes the menu; multi-question packs are
  //      collapsed to question[0] for now (phase 3 wizard support TBD).
  //
  //   2. Any other tool — Claude wants permission to run it. We render
  //      a 3-option permission menu: [Allow once] [Allow always] [Deny].
  //      Option 2 echoes ctx.suggestions back as updatedPermissions so a
  //      .claude/settings.local.json rule lands.
  _canUseTool(toolName, input, ctx) {
    const toolUseID = (ctx && ctx.toolUseID) || ('synth-' + crypto.randomBytes(6).toString('hex'));
    const hash = 'agent-' + toolUseID;

    if (toolName === 'AskUserQuestion') {
      return this._handleAskUserQuestion(input, hash, toolUseID);
    }
    return this._handlePermissionRequest(toolName, input, ctx, hash, toolUseID);
  }

  _handleAskUserQuestion(input, hash, toolUseID) {
    const questions = Array.isArray(input && input.questions) ? input.questions : [];
    if (!questions.length) {
      // No questions to display — auto-allow with empty answers so the
      // SDK doesn't hang.
      return Promise.resolve({ behavior: 'allow', updatedInput: { questions, answers: {} } });
    }
    const q0 = questions[0];
    const opts = Array.isArray(q0 && q0.options) ? q0.options : [];
    if (questions.length > 1) {
      console.log(`[agent-menu] ${this.sessionId} AskUserQuestion with ${questions.length} questions — phase 2 only handles the first one`);
    }

    return new Promise((resolve) => {
      const menu = {
        kind: 'plan',                     // matches today's plan-mode dialog rendering
        question: q0.question || '',
        options: opts.map((o, i) => ({
          n: i + 1,
          label: String(o.label || ''),
          description: o.description || '',
        })),
        hash,
        multi: !!q0.multiSelect,
      };
      this._pendingPermissions.set(hash, {
        kind: 'ask',
        toolUseID,
        rawQuestions: questions,
        resolve,
      });
      this._emit({
        type: 'permission_request',
        toolName: 'AskUserQuestion',
        hash,
        toolUseID,
        question: menu.question,
        optionCount: menu.options.length,
      });
      this.emit('menu', menu);             // → menuMod.handleSessionMenu wired in agent registration path
    });
  }

  _handlePermissionRequest(toolName, input, ctx, hash, toolUseID) {
    const summary = _summariseToolInput(toolName, input);
    return new Promise((resolve) => {
      const menu = {
        kind: 'permission',
        question: `Allow ${toolName}${summary ? ': ' + summary : ''}?`,
        options: [
          { n: 1, label: 'Allow once', description: 'Run this single call.' },
          { n: 2, label: 'Allow always', description: 'Auto-approve matching calls in this project.' },
          { n: 3, label: 'Deny',         description: 'Block this call; Claude will choose a different approach.' },
        ],
        hash,
        rawText: `${toolName}(${summary})`,  // shape menuMod.handleSessionMenu's permissions.extractPermissionTarget consumes
      };
      this._pendingPermissions.set(hash, {
        kind: 'permission',
        toolUseID,
        toolName,
        input,
        suggestions: (ctx && Array.isArray(ctx.suggestions)) ? ctx.suggestions : [],
        resolve,
      });
      this._emit({
        type: 'permission_request',
        toolName,
        hash,
        toolUseID,
        summary,
      });
      this.emit('menu', menu);
    });
  }

  // Called by pty.handleMenuPick when the user clicks an option in the
  // chat pane (or via /decide N). Resolves the corresponding canUseTool
  // promise with the SDK-shaped response.
  resolveMenuPick(hash, n) {
    const pending = this._pendingPermissions.get(hash);
    if (!pending) {
      console.log(`[agent-menu] ${this.sessionId} pick for unknown hash ${hash.slice(-12)} — ignoring`);
      return false;
    }
    this._pendingPermissions.delete(hash);
    this.pendingMenu = null;

    if (pending.kind === 'ask') {
      const q0 = pending.rawQuestions[0];
      const opts = (q0 && q0.options) || [];
      const picked = opts[n - 1];
      if (!picked) {
        pending.resolve({ behavior: 'deny', message: 'User picked an invalid option' });
        return true;
      }
      // SDK expects { questions, answers: { <questionText>: <label> } }
      // For multi-question packs we only have answers for q[0]; the SDK
      // currently tolerates missing answers but we log for visibility.
      const answers = {};
      answers[q0.question] = picked.label;
      this._emit({
        type: 'permission_resolved',
        toolName: 'AskUserQuestion',
        hash,
        pickedN: n,
        pickedLabel: picked.label,
      });
      pending.resolve({
        behavior: 'allow',
        updatedInput: { questions: pending.rawQuestions, answers },
      });
      return true;
    }

    // Permission flavour: 1=allow once, 2=allow always, 3=deny.
    if (n === 3) {
      this._emit({ type: 'permission_resolved', toolName: pending.toolName, hash, pickedN: n, decision: 'deny' });
      pending.resolve({
        behavior: 'deny',
        message: 'User declined this action via myco chat pane',
      });
      return true;
    }
    const reply = { behavior: 'allow', updatedInput: pending.input };
    if (n === 2 && pending.suggestions.length) {
      // Echo SDK-provided suggestions back so the rule lands in
      // .claude/settings.local.json and future matching calls skip the
      // prompt entirely.
      const persist = pending.suggestions.filter((s) => s && s.destination === 'localSettings');
      if (persist.length) reply.updatedPermissions = persist;
    }
    this._emit({
      type: 'permission_resolved',
      toolName: pending.toolName,
      hash,
      pickedN: n,
      decision: n === 2 ? 'allow-always' : 'allow-once',
      persistedRules: (reply.updatedPermissions || []).length,
    });
    pending.resolve(reply);
    return true;
  }

  _broadcastToolProgress() {
    const now = Date.now();
    const open = [];
    for (const [id, info] of this.openToolCalls) {
      open.push({
        id,
        name: info.name,
        summary: info.summary,
        sinceMs: Math.max(0, now - new Date(info.ts).getTime()),
      });
    }
    this.emit('state-update', { kind: 'tool-progress', open });
  }

  _emit(event) {
    const stamped = { ts: new Date().toISOString(), ...event };
    this.buffer.push(stamped);
    if (this.buffer.length > MAX_EVENTS) {
      this.buffer = this.buffer.slice(-MAX_EVENTS);
    }
    this.emit('agent-event', stamped);
  }

  // --- session-interface methods (mirror PtySession) -------------------

  // Semantically the next user turn. The string is the prompt body —
  // whatever routing logic (chat → PTY before, chat → SDK now) chose
  // to send. For phase 1 we kick a fresh query() with resume=sdkSessionId;
  // phase 4 will switch to true streaming input via async iterable.
  write(text) {
    if (!this.alive) return;
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    this._runTurn(trimmed);
  }

  // No-op for agent sessions — the SDK doesn't care about terminal size.
  // Kept for compat with attach-time resize frames sent by the existing
  // browser code.
  resize(cols, rows) {
    if (Number.isFinite(cols)) this.cols = cols;
    if (Number.isFinite(rows)) this.rows = rows;
  }

  kill() {
    if (!this.alive) return;
    this.alive = false;
    if (this._abortController) {
      try { this._abortController.abort(); } catch {}
    }
    this.emit('exit', 0);
  }
}

// Convenience factory mirroring pty.spawnClaude. Returns the live
// AgentSession (alive=true, possibly mid-iteration if initialPrompt set).
function spawnAgent(sessionId, opts = {}) {
  return new AgentSession(sessionId, opts);
}

module.exports = { AgentSession, spawnAgent };
