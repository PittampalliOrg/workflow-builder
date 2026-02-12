/**
 * Code snippet viewer widget HTML.
 * Displays code with basic syntax highlighting, line numbers, and copy button.
 * Supports light/dark theme from host context.
 */
export const CODE_VIEWER_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 0;
      background: #ffffff;
      color: #1a1a2e;
      transition: background 0.3s, color 0.3s;
    }
    body.dark { background: #0f172a; color: #e2e8f0; }
    .container {
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      overflow: hidden;
      margin: 12px;
      transition: border-color 0.3s;
    }
    body.dark .container { border-color: #334155; }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 14px;
      background: #f8fafc;
      border-bottom: 1px solid #e2e8f0;
      transition: background 0.3s, border-color 0.3s;
    }
    body.dark .header { background: #1e293b; border-bottom-color: #334155; }
    .header-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .title-text {
      font-size: 13px;
      font-weight: 600;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .lang-badge {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      background: #e0e7ff;
      color: #3730a3;
    }
    body.dark .lang-badge { background: #312e81; color: #a5b4fc; }
    .copy-btn {
      padding: 4px 12px;
      border-radius: 6px;
      border: 1px solid #e2e8f0;
      background: transparent;
      color: #64748b;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    body.dark .copy-btn { border-color: #475569; color: #94a3b8; }
    .copy-btn:hover { background: #f1f5f9; color: #1e293b; }
    body.dark .copy-btn:hover { background: #334155; color: #e2e8f0; }
    .copy-btn.copied { color: #22c55e; border-color: #22c55e; }
    .code-area {
      display: flex;
      overflow-x: auto;
      background: #fafbfc;
      transition: background 0.3s;
    }
    body.dark .code-area { background: #0c1222; }
    .line-numbers {
      padding: 14px 0;
      text-align: right;
      user-select: none;
      border-right: 1px solid #e2e8f0;
      background: #f8fafc;
      transition: background 0.3s, border-color 0.3s;
      flex-shrink: 0;
    }
    body.dark .line-numbers { background: #0f172a; border-right-color: #1e293b; }
    .line-num {
      display: block;
      padding: 0 12px;
      font-family: 'SF Mono', Monaco, 'Courier New', monospace;
      font-size: 13px;
      line-height: 1.6;
      color: #94a3b8;
    }
    body.dark .line-num { color: #475569; }
    .code-content {
      padding: 14px 16px;
      flex: 1;
      overflow-x: auto;
    }
    .code-content pre {
      font-family: 'SF Mono', Monaco, 'Courier New', monospace;
      font-size: 13px;
      line-height: 1.6;
      white-space: pre;
      margin: 0;
    }
    /* Syntax colors */
    .tok-kw { color: #8b5cf6; font-weight: 500; }
    .tok-str { color: #22c55e; }
    .tok-num { color: #f59e0b; }
    .tok-cm { color: #94a3b8; font-style: italic; }
    .tok-fn { color: #3b82f6; }
    .tok-op { color: #64748b; }
    .tok-type { color: #06b6d4; }
    body.dark .tok-kw { color: #a78bfa; }
    body.dark .tok-str { color: #4ade80; }
    body.dark .tok-num { color: #fbbf24; }
    body.dark .tok-cm { color: #64748b; }
    body.dark .tok-fn { color: #60a5fa; }
    body.dark .tok-op { color: #94a3b8; }
    body.dark .tok-type { color: #22d3ee; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    .container { animation: fadeIn 0.3s ease; }
  </style>
</head>
<body>
  <div class="container" id="container">
    <div class="header">
      <div class="header-left">
        <span class="title-text" id="titleText"></span>
        <span class="lang-badge" id="langBadge">code</span>
      </div>
      <button class="copy-btn" id="copyBtn" onclick="copyCode()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        <span id="copyText">Copy</span>
      </button>
    </div>
    <div class="code-area">
      <div class="line-numbers" id="lineNums"></div>
      <div class="code-content"><pre id="codeContent"></pre></div>
    </div>
  </div>

  <script>
    // MCP Apps Guest Protocol
    (function() {
      var _rid = 100;
      function _post(msg) { window.parent.postMessage(msg, '*'); }
      window._mcp = {
        reportSize: function(w, h) {
          _post({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { width: w, height: h } });
        },
        notify: function(msg) {
          _post({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: msg } });
        }
      };
      window.addEventListener('message', function(e) {
        var d = e.data;
        if (!d || d.jsonrpc !== '2.0') return;
        if (d.id === 1 && d.result) {
          window._hostCtx = d.result.hostContext || {};
          if (typeof window.onMcpInit === 'function') window.onMcpInit(window._hostCtx);
          _post({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
        }
        if (d.method === 'ui/notifications/tool-input' && typeof window.onMcpToolInput === 'function') {
          window.onMcpToolInput(d.params && d.params.arguments);
        }
        if (d.method === 'ui/notifications/host-context-changed' && typeof window.onMcpContextChange === 'function') {
          Object.assign(window._hostCtx || {}, d.params);
          window.onMcpContextChange(d.params);
        }
        if (d.method === 'ui/resource-teardown' && d.id) {
          _post({ jsonrpc: '2.0', id: d.id, result: {} });
        }
      });
      _post({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'code-viewer', version: '1.0.0' }
      }});
    })();

    var rawCode = '';

    // Simple syntax highlighting
    var RULES = {
      javascript: [
        { re: /(\\/{2}.*$)/gm, cls: 'tok-cm' },
        { re: /(\\/\\*[\\s\\S]*?\\*\\/)/g, cls: 'tok-cm' },
        { re: /("(?:[^"\\\\\\\\]|\\\\\\\\.)*"|'(?:[^'\\\\\\\\]|\\\\\\\\.)*'|\`(?:[^\`\\\\\\\\]|\\\\\\\\.)*\`)/g, cls: 'tok-str' },
        { re: /\\b(\\d+\\.?\\d*)\\b/g, cls: 'tok-num' },
        { re: /\\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|this|class|extends|import|export|from|default|async|await|try|catch|throw|typeof|instanceof|in|of|yield|null|undefined|true|false)\\b/g, cls: 'tok-kw' },
        { re: /\\b(string|number|boolean|void|any|never|object|interface|type|enum)\\b/g, cls: 'tok-type' },
        { re: /\\b([a-zA-Z_$][a-zA-Z0-9_$]*)\\s*(?=\\()/g, cls: 'tok-fn' },
      ],
      python: [
        { re: /(#.*$)/gm, cls: 'tok-cm' },
        { re: /("""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\')/g, cls: 'tok-str' },
        { re: /("(?:[^"\\\\\\\\]|\\\\\\\\.)*"|'(?:[^'\\\\\\\\]|\\\\\\\\.)*')/g, cls: 'tok-str' },
        { re: /\\b(\\d+\\.?\\d*)\\b/g, cls: 'tok-num' },
        { re: /\\b(def|class|return|if|elif|else|for|while|import|from|as|try|except|finally|raise|with|yield|lambda|pass|break|continue|and|or|not|is|in|True|False|None|self|async|await)\\b/g, cls: 'tok-kw' },
        { re: /\\b(int|str|float|bool|list|dict|tuple|set|bytes|type)\\b/g, cls: 'tok-type' },
        { re: /\\b([a-zA-Z_][a-zA-Z0-9_]*)\\s*(?=\\()/g, cls: 'tok-fn' },
      ],
      typescript: null, // alias for javascript
      html: [
        { re: /(&lt;!--[\\s\\S]*?--&gt;)/g, cls: 'tok-cm' },
        { re: /("(?:[^"]*)")/g, cls: 'tok-str' },
        { re: /(&lt;\\/?[a-zA-Z][a-zA-Z0-9]*)/g, cls: 'tok-kw' },
        { re: /(\\/?&gt;)/g, cls: 'tok-kw' },
      ],
      css: [
        { re: /(\\/\\*[\\s\\S]*?\\*\\/)/g, cls: 'tok-cm' },
        { re: /("(?:[^"]*)")/g, cls: 'tok-str' },
        { re: /\\b(\\d+\\.?\\d*)(px|em|rem|%|vh|vw|s|ms)?\\b/g, cls: 'tok-num' },
        { re: /([.#][a-zA-Z_-][a-zA-Z0-9_-]*)/g, cls: 'tok-fn' },
        { re: /\\b(color|background|margin|padding|border|font|display|position|width|height|flex|grid)\\b/g, cls: 'tok-kw' },
      ]
    };
    RULES.typescript = RULES.javascript;
    RULES.ts = RULES.javascript;
    RULES.js = RULES.javascript;
    RULES.py = RULES.python;
    RULES.jsx = RULES.javascript;
    RULES.tsx = RULES.javascript;

    function escapeHtml(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function highlight(code, lang) {
      var escaped = escapeHtml(code);
      var rules = RULES[lang] || RULES[(lang || '').toLowerCase()];
      if (!rules) return escaped;

      // Apply rules in order with placeholder replacement to avoid double-matching
      var placeholders = [];
      rules.forEach(function(rule) {
        escaped = escaped.replace(rule.re, function(match) {
          var idx = placeholders.length;
          placeholders.push('<span class="' + rule.cls + '">' + match + '</span>');
          return '\\x00PH' + idx + '\\x00';
        });
      });
      // Restore placeholders
      placeholders.forEach(function(ph, i) {
        escaped = escaped.replace('\\x00PH' + i + '\\x00', ph);
      });
      return escaped;
    }

    function renderCode(code, language, title) {
      rawCode = code || '';
      var lang = (language || 'text').toLowerCase();
      var titleEl = document.getElementById('titleText');
      titleEl.textContent = title || '';
      titleEl.style.display = title ? '' : 'none';
      document.getElementById('langBadge').textContent = lang;

      var lines = rawCode.split('\\n');
      var lineNums = document.getElementById('lineNums');
      lineNums.innerHTML = lines.map(function(_, i) {
        return '<span class="line-num">' + (i + 1) + '</span>';
      }).join('');

      document.getElementById('codeContent').innerHTML = highlight(rawCode, lang);

      setTimeout(function() {
        window._mcp.reportSize(null, document.body.scrollHeight);
      }, 50);
    }

    var copyTimer = null;
    function copyCode() {
      if (navigator.clipboard && rawCode) {
        navigator.clipboard.writeText(rawCode).then(function() {
          var btn = document.getElementById('copyBtn');
          var text = document.getElementById('copyText');
          btn.classList.add('copied');
          text.textContent = 'Copied!';
          window._mcp.notify('Code copied to clipboard');
          clearTimeout(copyTimer);
          copyTimer = setTimeout(function() {
            btn.classList.remove('copied');
            text.textContent = 'Copy';
          }, 2000);
        });
      }
    }

    window.onMcpInit = function(ctx) {
      if (ctx && ctx.theme === 'dark') document.body.classList.add('dark');
    };

    window.onMcpToolInput = function(args) {
      if (args) renderCode(args.code, args.language, args.title);
    };

    window.onMcpContextChange = function(changes) {
      if (changes && changes.theme !== undefined) {
        document.body.classList.toggle('dark', changes.theme === 'dark');
      }
    };
  </script>
</body>
</html>`;
