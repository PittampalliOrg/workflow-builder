/**
 * Dashboard HTML for the MCP Apps weather demo.
 * Extracted from the mcp-apps-demo example for use in the Next.js embedded server.
 */
export const WEATHER_DASHBOARD_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MCP Apps Adapter Demo</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding: 16px;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      color: #333;
    }
    .container {
      max-width: 500px;
      margin: 0 auto;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 24px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
      margin-bottom: 16px;
    }
    h1 {
      margin: 0 0 8px 0;
      color: #667eea;
      font-size: 24px;
    }
    h2 {
      margin: 0 0 16px 0;
      color: #333;
      font-size: 18px;
      font-weight: 600;
    }
    .subtitle {
      color: #64748b;
      font-size: 14px;
      margin-bottom: 20px;
    }
    .data-display {
      background: #f8fafc;
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 20px;
    }
    .data-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #e2e8f0;
    }
    .data-row:last-child { border-bottom: none; }
    .data-label { color: #64748b; font-size: 14px; }
    .data-value { color: #1e293b; font-weight: 600; }
    .actions-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    button {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      padding: 12px 16px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
    }
    button:active { transform: translateY(0); }
    button.secondary {
      background: #f1f5f9;
      color: #475569;
    }
    button.secondary:hover {
      background: #e2e8f0;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    }
    .full-width { grid-column: 1 / -1; }
    .log-area {
      background: #1e293b;
      border-radius: 8px;
      padding: 12px;
      font-family: 'SF Mono', Monaco, 'Courier New', monospace;
      font-size: 12px;
      color: #94a3b8;
      max-height: 150px;
      overflow-y: auto;
    }
    .log-entry { margin-bottom: 4px; }
    .log-entry.success { color: #4ade80; }
    .log-entry.info { color: #60a5fa; }
    .log-entry.warn { color: #fbbf24; }
    .status-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
    }
    .status-badge.connected {
      background: #dcfce7;
      color: #166534;
    }
    .status-badge.disconnected {
      background: #fee2e2;
      color: #991b1b;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>MCP Apps Adapter Demo</h1>
      <p class="subtitle">Testing MCP-UI actions through the MCP Apps adapter</p>

      <div class="data-display">
        <div class="data-row">
          <span class="data-label">Status</span>
          <span id="status" class="status-badge disconnected">Waiting...</span>
        </div>
        <div class="data-row">
          <span class="data-label">Tool Input</span>
          <span id="toolInput" class="data-value">--</span>
        </div>
        <div class="data-row">
          <span class="data-label">Tool Output</span>
          <span id="toolOutput" class="data-value">--</span>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>MCP-UI Actions</h2>
      <div class="actions-grid">
        <button onclick="sendNotify()">
          Send Notify
        </button>
        <button onclick="sendLink()">
          Open Link
        </button>
        <button onclick="sendPrompt()">
          Send Prompt
        </button>
        <button onclick="sendIntent()">
          Send Intent
        </button>
        <button onclick="sendSizeChange()" class="secondary">
          Resize Widget
        </button>
        <button onclick="callTool()" class="secondary">
          Call Tool
        </button>
        <button onclick="refreshData()" class="full-width">
          Request Render Data
        </button>
      </div>
    </div>

    <div class="card">
      <h2>Event Log</h2>
      <div id="log" class="log-area">
        <div class="log-entry info">Waiting for adapter initialization...</div>
      </div>
    </div>
  </div>

  <script>
    function log(message, type) {
      type = type || 'info';
      var logEl = document.getElementById('log');
      var entry = document.createElement('div');
      entry.className = 'log-entry ' + type;
      entry.textContent = new Date().toLocaleTimeString() + ' - ' + message;
      logEl.appendChild(entry);
      logEl.scrollTop = logEl.scrollHeight;
    }

    function setStatus(connected) {
      var el = document.getElementById('status');
      el.textContent = connected ? 'Connected' : 'Disconnected';
      el.className = 'status-badge ' + (connected ? 'connected' : 'disconnected');
    }

    window.addEventListener('message', function(event) {
      var data = event.data;
      if (!data || !data.type) return;
      log('Received: ' + data.type, 'info');

      switch (data.type) {
        case 'ui-lifecycle-iframe-render-data':
          setStatus(true);
          var renderData = (data.payload && data.payload.renderData) || {};
          if (renderData.toolInput) {
            document.getElementById('toolInput').textContent =
              JSON.stringify(renderData.toolInput).substring(0, 30) + '...';
            log('Tool input received: ' + JSON.stringify(renderData.toolInput), 'success');
          }
          if (renderData.toolOutput) {
            document.getElementById('toolOutput').textContent =
              JSON.stringify(renderData.toolOutput).substring(0, 30) + '...';
            log('Tool output received', 'success');
          }
          break;

        case 'ui-message-received':
          log('Message acknowledged: ' + (data.payload && data.payload.messageId), 'info');
          break;

        case 'ui-message-response':
          if (data.payload && data.payload.error) {
            log('Response error: ' + JSON.stringify(data.payload.error), 'warn');
          } else {
            log('Response received: ' + JSON.stringify((data.payload && data.payload.response) || {}), 'success');
          }
          break;
      }
    });

    function sendMessage(type, payload) {
      var messageId = 'msg-' + Date.now();
      log('Sending: ' + type, 'info');
      window.parent.postMessage({ type: type, messageId: messageId, payload: payload }, '*');
      return messageId;
    }

    function sendNotify() {
      sendMessage('notify', {
        message: 'Hello from MCP-UI widget! Time: ' + new Date().toLocaleTimeString()
      });
    }

    function sendLink() {
      sendMessage('link', {
        url: 'https://github.com/modelcontextprotocol/ext-apps'
      });
    }

    function sendPrompt() {
      sendMessage('prompt', {
        prompt: 'What is the weather like today?'
      });
    }

    function sendIntent() {
      sendMessage('intent', {
        intent: 'get_forecast',
        params: { days: 7, location: 'San Francisco' }
      });
    }

    function sendSizeChange() {
      var height = 300 + Math.floor(Math.random() * 200);
      sendMessage('ui-size-change', {
        width: 500,
        height: height
      });
      log('Requested size: 500x' + height, 'info');
    }

    function callTool() {
      sendMessage('tool', {
        toolName: 'weather_dashboard',
        params: { location: 'New York' }
      });
    }

    function refreshData() {
      sendMessage('ui-request-render-data', {});
    }

    log('Sending ready signal...', 'info');
    window.parent.postMessage({ type: 'ui-lifecycle-iframe-ready' }, '*');
  </script>
</body>
</html>`;
