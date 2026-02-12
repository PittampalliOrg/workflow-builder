/**
 * Color palette generator widget HTML.
 * Generates harmonious palettes from a base color (complementary, analogous, triadic).
 * Interactive: click to copy hex values, sends notify actions via MCP protocol.
 */
export const COLOR_PALETTE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 20px;
      background: #ffffff;
      color: #1a1a2e;
      transition: background 0.3s, color 0.3s;
    }
    body.dark { background: #0f172a; color: #e2e8f0; }
    .header { margin-bottom: 16px; }
    .title { font-size: 18px; font-weight: 700; margin-bottom: 4px; }
    .subtitle { font-size: 13px; color: #64748b; }
    body.dark .subtitle { color: #94a3b8; }
    .tabs {
      display: flex;
      gap: 6px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .tab {
      padding: 6px 14px;
      border-radius: 20px;
      border: 1px solid #e2e8f0;
      background: transparent;
      color: #64748b;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }
    body.dark .tab { border-color: #334155; color: #94a3b8; }
    .tab:hover { background: #f1f5f9; }
    body.dark .tab:hover { background: #1e293b; }
    .tab.active {
      background: #3b82f6;
      color: white;
      border-color: #3b82f6;
    }
    .palette {
      display: flex;
      gap: 12px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .swatch {
      flex: 1;
      min-width: 80px;
      border-radius: 12px;
      overflow: hidden;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
      border: 1px solid rgba(0,0,0,0.08);
    }
    body.dark .swatch { border-color: rgba(255,255,255,0.08); }
    .swatch:hover {
      transform: translateY(-4px);
      box-shadow: 0 8px 24px rgba(0,0,0,0.15);
    }
    .swatch-color { height: 100px; transition: background 0.3s; }
    .swatch-info {
      padding: 10px 12px;
      background: #f8fafc;
      transition: background 0.3s;
    }
    body.dark .swatch-info { background: #1e293b; }
    .swatch-hex {
      font-family: 'SF Mono', Monaco, 'Courier New', monospace;
      font-size: 13px;
      font-weight: 600;
    }
    .swatch-label {
      font-size: 11px;
      color: #94a3b8;
      margin-top: 2px;
    }
    .base-preview {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
      padding: 12px;
      border-radius: 10px;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
    }
    body.dark .base-preview { background: #1e293b; border-color: #334155; }
    .base-dot {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      flex-shrink: 0;
      border: 2px solid rgba(0,0,0,0.1);
    }
    .base-info { font-size: 13px; }
    .base-info strong { font-size: 15px; }
    .toast {
      position: fixed;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%) translateY(60px);
      background: #1e293b;
      color: white;
      padding: 8px 20px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      transition: transform 0.3s ease;
      z-index: 100;
    }
    body.dark .toast { background: #e2e8f0; color: #0f172a; }
    .toast.show { transform: translateX(-50%) translateY(0); }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    .palette { animation: fadeIn 0.3s ease; }
  </style>
</head>
<body>
  <div class="header">
    <div class="title" id="title">Color Palette</div>
    <div class="subtitle" id="subtitle">Click a color to copy its hex value</div>
  </div>
  <div class="base-preview" id="basePreview" style="display:none">
    <div class="base-dot" id="baseDot"></div>
    <div class="base-info">
      <strong id="baseHex">#3B82F6</strong>
      <div style="color:#94a3b8;font-size:12px">Base color</div>
    </div>
  </div>
  <div class="tabs" id="tabs"></div>
  <div class="palette" id="palette"></div>
  <div class="toast" id="toast">Copied!</div>

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
        },
        sendMessage: function(text) {
          _post({ jsonrpc: '2.0', id: _rid++, method: 'ui/message', params: { role: 'user', content: [{ type: 'text', text: text }] } });
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
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'color-palette', version: '1.0.0' }
      }});
    })();

    // Color math
    function hexToHsl(hex) {
      hex = hex.replace('#', '');
      var r = parseInt(hex.substring(0, 2), 16) / 255;
      var g = parseInt(hex.substring(2, 4), 16) / 255;
      var b = parseInt(hex.substring(4, 6), 16) / 255;
      var max = Math.max(r, g, b), min = Math.min(r, g, b);
      var h = 0, s = 0, l = (max + min) / 2;
      if (max !== min) {
        var d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
      }
      return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
    }

    function hslToHex(h, s, l) {
      h = ((h % 360) + 360) % 360;
      s = Math.max(0, Math.min(100, s)) / 100;
      l = Math.max(0, Math.min(100, l)) / 100;
      var c = (1 - Math.abs(2 * l - 1)) * s;
      var x = c * (1 - Math.abs((h / 60) % 2 - 1));
      var m = l - c / 2;
      var r = 0, g = 0, b = 0;
      if (h < 60) { r = c; g = x; }
      else if (h < 120) { r = x; g = c; }
      else if (h < 180) { g = c; b = x; }
      else if (h < 240) { g = x; b = c; }
      else if (h < 300) { r = x; b = c; }
      else { r = c; b = x; }
      r = Math.round((r + m) * 255);
      g = Math.round((g + m) * 255);
      b = Math.round((b + m) * 255);
      return '#' + [r, g, b].map(function(v) { return v.toString(16).padStart(2, '0'); }).join('').toUpperCase();
    }

    var paletteTypes = {
      complementary: function(h, s, l) {
        return [
          { h: h, s: s, l: Math.min(l + 15, 90), label: 'Light' },
          { h: h, s: s, l: l, label: 'Base' },
          { h: h, s: s, l: Math.max(l - 15, 10), label: 'Dark' },
          { h: (h + 180) % 360, s: s, l: l, label: 'Complement' },
          { h: (h + 180) % 360, s: s, l: Math.max(l - 15, 10), label: 'Comp Dark' },
        ];
      },
      analogous: function(h, s, l) {
        return [
          { h: (h - 30 + 360) % 360, s: s, l: l, label: '-30\\u00B0' },
          { h: (h - 15 + 360) % 360, s: s, l: l, label: '-15\\u00B0' },
          { h: h, s: s, l: l, label: 'Base' },
          { h: (h + 15) % 360, s: s, l: l, label: '+15\\u00B0' },
          { h: (h + 30) % 360, s: s, l: l, label: '+30\\u00B0' },
        ];
      },
      triadic: function(h, s, l) {
        return [
          { h: h, s: s, l: l, label: 'Primary' },
          { h: h, s: s, l: Math.min(l + 20, 90), label: 'Primary Light' },
          { h: (h + 120) % 360, s: s, l: l, label: 'Secondary' },
          { h: (h + 240) % 360, s: s, l: l, label: 'Tertiary' },
          { h: (h + 240) % 360, s: s, l: Math.min(l + 20, 90), label: 'Tertiary Light' },
        ];
      },
      'split-complementary': function(h, s, l) {
        return [
          { h: h, s: s, l: l, label: 'Base' },
          { h: h, s: s, l: Math.min(l + 15, 90), label: 'Base Light' },
          { h: (h + 150) % 360, s: s, l: l, label: 'Split A' },
          { h: (h + 210) % 360, s: s, l: l, label: 'Split B' },
          { h: (h + 180) % 360, s: Math.max(s - 20, 10), l: Math.min(l + 25, 90), label: 'Muted Comp' },
        ];
      }
    };

    var currentBase = '#3B82F6';
    var currentType = 'complementary';
    var toastTimer = null;

    function showToast(text) {
      var toast = document.getElementById('toast');
      toast.textContent = text;
      toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function() { toast.classList.remove('show'); }, 1500);
    }

    function copyHex(hex) {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(hex).then(function() {
          showToast('Copied ' + hex);
          window._mcp.notify('Copied color: ' + hex);
        });
      } else {
        showToast(hex);
      }
    }

    function renderTabs() {
      var tabs = document.getElementById('tabs');
      tabs.innerHTML = '';
      Object.keys(paletteTypes).forEach(function(type) {
        var btn = document.createElement('button');
        btn.className = 'tab' + (type === currentType ? ' active' : '');
        btn.textContent = type.split('-').map(function(w) { return w[0].toUpperCase() + w.slice(1); }).join(' ');
        btn.onclick = function() {
          currentType = type;
          renderTabs();
          renderPalette();
        };
        tabs.appendChild(btn);
      });
    }

    function renderPalette() {
      var hsl = hexToHsl(currentBase);
      var colors = paletteTypes[currentType](hsl[0], hsl[1], hsl[2]);
      var container = document.getElementById('palette');
      container.innerHTML = '';
      colors.forEach(function(c) {
        var hex = hslToHex(c.h, c.s, c.l);
        var swatch = document.createElement('div');
        swatch.className = 'swatch';
        swatch.onclick = function() { copyHex(hex); };
        swatch.innerHTML =
          '<div class="swatch-color" style="background:' + hex + '"></div>' +
          '<div class="swatch-info">' +
            '<div class="swatch-hex">' + hex + '</div>' +
            '<div class="swatch-label">' + c.label + '</div>' +
          '</div>';
        container.appendChild(swatch);
      });

      // Show base preview
      var bp = document.getElementById('basePreview');
      bp.style.display = 'flex';
      document.getElementById('baseDot').style.background = currentBase;
      document.getElementById('baseHex').textContent = currentBase.toUpperCase();

      setTimeout(function() {
        window._mcp.reportSize(null, document.body.scrollHeight + 20);
      }, 100);
    }

    window.onMcpInit = function(ctx) {
      if (ctx && ctx.theme === 'dark') document.body.classList.add('dark');
    };

    window.onMcpToolInput = function(args) {
      if (!args) return;
      if (args.baseColor) currentBase = args.baseColor;
      if (args.paletteType && paletteTypes[args.paletteType]) currentType = args.paletteType;
      document.getElementById('title').textContent = 'Color Palette';
      document.getElementById('subtitle').textContent = 'Based on ' + currentBase.toUpperCase() + ' \\u2022 Click to copy';
      renderTabs();
      renderPalette();
    };

    window.onMcpContextChange = function(changes) {
      if (changes && changes.theme !== undefined) {
        document.body.classList.toggle('dark', changes.theme === 'dark');
      }
    };
  </script>
</body>
</html>`;
