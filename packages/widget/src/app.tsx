// Basic chat + booking UI for the SMB widget.
// Renders a minimal chat interface with buttons for
// availability checks and booking actions. When the
// URL contains `?agent=1`, additional data attributes
// are exposed to simplify agent DOM interactions.

export function App() {
  const params = new URLSearchParams(window.location.search);
  const agentMode = params.get('agent') === '1';

  const root = document.createElement('div');
  root.id = 'smb-widget';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Booking widget');
  if (agentMode) root.dataset.agent = '1';

  root.innerHTML = `
    <div id="chat-log" style="height:300px;overflow:auto;border-bottom:1px solid #ccc;padding:8px" aria-live="polite"${
      agentMode ? ' data-agent-id="chat-log"' : ''
    }></div>
    <form id="chat-form" style="display:flex;padding:8px;gap:4px">
      <input id="chat-input" type="text" placeholder="Type message" style="flex:1" aria-label="Message"${
        agentMode ? ' data-agent-id="chat-input"' : ''
      } />
      <button id="send-btn" type="submit"${
        agentMode ? ' data-agent-id="send-btn"' : ''
      }>Send</button>
    </form>
    <div id="actions" style="padding:8px">
      <button id="check-availability"${
        agentMode ? ' data-agent-id="check-availability"' : ''
      }>Check availability</button>
      <button id="book-appointment"${
        agentMode ? ' data-agent-id="book-appointment"' : ''
      }>Book appointment</button>
    </div>
  `;

  document.body.appendChild(root);

  const chatLog = root.querySelector('#chat-log') as HTMLDivElement;
  const form = root.querySelector('#chat-form') as HTMLFormElement;
  const input = root.querySelector('#chat-input') as HTMLInputElement;

  function addMessage(msg: string) {
    const div = document.createElement('div');
    div.textContent = msg;
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = input.value.trim();
    if (msg) {
      addMessage(`You: ${msg}`);
      input.value = '';
    }
  });

  root
    .querySelector('#check-availability')!
    .addEventListener('click', () => addMessage('Checking availability...'));

  root
    .querySelector('#book-appointment')!
    .addEventListener('click', () => addMessage('Booking appointment...'));
}

