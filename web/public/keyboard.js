/* Custom keyboard for Claude Code sessions.
   Instantiate with: new Keyboard(containerEl, sendFn)
   sendFn(str) — called with raw byte strings on each tap. */

class Keyboard {
  constructor(container, sendFn) {
    this.container = container;
    this.send = sendFn;
    this.nativeMode = false;
    this.render();
  }

  // Byte mappings — kept compact so the bar fits one row on mobile.
  // Esc supports double-tap: tap twice within ~300ms to send Esc×2 as one frame.
  static KEYS = [
    { label: 'Esc',   bytes: '\x1b', doubleTap: '\x1b\x1b' },
    { label: '1',     bytes: '1' },
    { label: '2',     bytes: '2' },
    { label: '3',     bytes: '3' },
    { label: 'Enter', bytes: '\r' },
  ];

  static DOUBLE_TAP_MS = 280;

  render() {
    this.container.innerHTML = '';
    this.container.className = 'keyboard-bar';

    // toggle button
    const toggle = document.createElement('button');
    toggle.className = 'kbd-toggle';
    toggle.textContent = this.nativeMode ? '⌨ Custom' : '⌨ ABC';
    toggle.addEventListener('click', () => {
      this.nativeMode = !this.nativeMode;
      this.render();
    });
    this.container.appendChild(toggle);

    if (this.nativeMode) {
      // Local input buffer — typing stays in the input box, only flushes
      // to the backend on Enter or Send. Feels responsive on mobile.
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'kbd-native-input';
      input.placeholder = 'Type, then tap Send or press Enter';
      input.autocomplete = 'off';
      input.autocapitalize = 'off';
      input.autocorrect = 'off';
      input.spellcheck = false;
      input.enterKeyHint = 'send';

      const sendBtn = document.createElement('button');
      sendBtn.className = 'kbd-send';
      sendBtn.textContent = 'Send';

      const flush = (appendNewline) => {
        const text = input.value;
        if (text) this.send(text);
        if (appendNewline) this.send('\r');
        input.value = '';
        input.focus();
      };

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          flush(true);
        }
      });

      sendBtn.addEventListener('click', () => flush(true));

      this.container.appendChild(input);
      this.container.appendChild(sendBtn);
      input.focus();
      return;
    }

    // custom key grid
    const grid = document.createElement('div');
    grid.className = 'kbd-grid';

    for (const key of Keyboard.KEYS) {
      const btn = document.createElement('button');
      btn.className = 'kbd-key';
      btn.textContent = key.label;
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault(); // keep focus on terminal
        this.handleKeyTap(key);
      });
      grid.appendChild(btn);
    }

    this.container.appendChild(grid);
  }

  handleKeyTap(key) {
    if (navigator.vibrate) navigator.vibrate(10);

    // Keys without a double-tap variant: send immediately.
    if (!key.doubleTap) { this.send(key.bytes); return; }

    // Double-tap: if we're already pending a single, cancel it and send the doubled bytes.
    if (this._pendingTimer) {
      clearTimeout(this._pendingTimer);
      this._pendingTimer = null;
      this.send(key.doubleTap);
      return;
    }

    // First tap: hold for the double-tap window before committing to single.
    this._pendingTimer = setTimeout(() => {
      this._pendingTimer = null;
      this.send(key.bytes);
    }, Keyboard.DOUBLE_TAP_MS);
  }
}
