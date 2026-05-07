// Chat-assistant helper. Claude is a participant in the discussion pane —
// any message that looks like it wants a reply (ends with ?, mentions
// @claude, or starts with /btw) is forwarded to a fresh `claude -p` run
// in the session's cwd. The subprocess inherits `process.env`, which
// systemd populates from /home/kkrazy/myco/.env, plus the user's
// ~/.claude/ config — so whatever auth (API key or claude.ai subscription)
// is set up for the main interactive session works here too.

const { spawn } = require('child_process');

const TIMEOUT_MS = 60000;
const ASSISTANT_USER = 'claude';

const ASSISTANT_INSTRUCTIONS = [
  'You are participating in a group chat alongside collaborators viewing a live Claude Code session in a tool called myco.',
  'You see the recent chat messages and the last few dozen lines of the running session\'s terminal scrollback.',
  '',
  'Rules:',
  '- Reply to the most recent chat message ONLY.',
  '- Be concise: 1-3 sentences for casual replies, longer only when the question genuinely needs it.',
  '- If the message references something visible in the scrollback (an error, a file, a command), ground your answer there.',
  '- Do not ask follow-up questions; give the best short answer with what you have.',
  '- Plain text only, no markdown formatting.',
].join('\n');

function shouldAskAssistant(text) {
  if (typeof text !== 'string') return false;
  if (/^\/btw\b/i.test(text)) return true;
  if (/@claude\b/i.test(text)) return true;
  if (/\?\s*$/.test(text)) return true;
  return false;
}

function stripAnsi(text) {
  return String(text || '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')      // CSI: cursor, colors, erase
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC: window titles
    .replace(/\x1b[@-_]/g, '')                       // single-char ESC
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');       // misc control chars
}

function tailLines(text, n) {
  const lines = String(text || '').split('\n');
  return lines.slice(-n).join('\n');
}

function formatChat(messages) {
  if (!messages || !messages.length) return '(empty)';
  return messages.map((m) => `${m.user}: ${m.text}`).join('\n');
}

function buildPrompt({ chatHistory, scrollback, lastMessage }) {
  return [
    ASSISTANT_INSTRUCTIONS,
    '',
    '== Recent chat ==',
    formatChat(chatHistory),
    '',
    '== Terminal scrollback (most recent at bottom) ==',
    scrollback || '(empty)',
    '',
    '== Most recent message to respond to ==',
    `${lastMessage.user}: ${lastMessage.text}`,
  ].join('\n');
}

function askAssistant({ cwd, chatHistory, scrollback, lastMessage }) {
  const promptBody = buildPrompt({ chatHistory, scrollback, lastMessage });

  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('claude', ['-p'], {
        cwd: cwd || process.cwd(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve(`(claude failed to start: ${err.message})`);
      return;
    }

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => resolve(`(claude error: ${err.message})`));

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
    }, TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const text = stdout.trim();
      if (text) { resolve(text); return; }
      const err = stderr.trim().slice(0, 300);
      resolve(`(claude exited ${code}${err ? `: ${err}` : ''})`);
    });

    try {
      proc.stdin.write(promptBody);
      proc.stdin.end();
    } catch (err) {
      resolve(`(claude stdin write failed: ${err.message})`);
    }
  });
}

module.exports = {
  askAssistant,
  shouldAskAssistant,
  stripAnsi,
  tailLines,
  ASSISTANT_USER,
};
