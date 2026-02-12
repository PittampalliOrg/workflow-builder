/**
 * Interactive KPI/metric dashboard widget HTML.
 * Shows metric cards with sparkline charts, animated counters, and trend indicators.
 * Uses the MCP Apps JSON-RPC protocol for host communication.
 */
export const METRIC_DASHBOARD_HTML = `<!DOCTYPE html>
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
    body.dark {
      background: #0f172a;
      color: #e2e8f0;
    }
    .title {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 16px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
    }
    .card {
      background: #f8fafc;
      border-radius: 12px;
      padding: 20px;
      border: 1px solid #e2e8f0;
      transition: background 0.3s, border-color 0.3s, transform 0.2s;
    }
    body.dark .card {
      background: #1e293b;
      border-color: #334155;
    }
    .card:hover { transform: translateY(-2px); }
    .metric-name {
      font-size: 13px;
      color: #64748b;
      font-weight: 500;
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    body.dark .metric-name { color: #94a3b8; }
    .metric-value {
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 4px;
      display: flex;
      align-items: baseline;
      gap: 6px;
    }
    .metric-unit {
      font-size: 14px;
      color: #94a3b8;
      font-weight: 400;
    }
    .metric-change {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 13px;
      font-weight: 600;
    }
    .metric-change.up { color: #22c55e; }
    .metric-change.down { color: #ef4444; }
    .sparkline { margin-top: 12px; width: 100%; }
    .sparkline svg { width: 100%; height: 40px; }
    .sparkline path { fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .sparkline .area { stroke: none; }
    .sparkline.up path:not(.area) { stroke: #22c55e; }
    .sparkline.up .area { fill: #22c55e; fill-opacity: 0.1; }
    .sparkline.down path:not(.area) { stroke: #ef4444; }
    .sparkline.down .area { fill: #ef4444; fill-opacity: 0.1; }
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .card { animation: fadeUp 0.4s ease-out backwards; }
    .card:nth-child(2) { animation-delay: 0.08s; }
    .card:nth-child(3) { animation-delay: 0.16s; }
    .card:nth-child(4) { animation-delay: 0.24s; }
    .card:nth-child(5) { animation-delay: 0.32s; }
    .card:nth-child(6) { animation-delay: 0.40s; }
    .empty {
      text-align: center;
      padding: 40px;
      color: #94a3b8;
    }
  </style>
</head>
<body>
  <div class="title" id="title">Dashboard</div>
  <div class="grid" id="grid">
    <div class="empty">Waiting for data...</div>
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
        },
        openLink: function(url) {
          _post({ jsonrpc: '2.0', id: _rid++, method: 'ui/open-link', params: { url: url } });
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
        if (d.method === 'ui/notifications/tool-result' && typeof window.onMcpToolResult === 'function') {
          window.onMcpToolResult(d.params);
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
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'metric-dashboard', version: '1.0.0' }
      }});
    })();

    // Widget Logic
    function generateSparklineData(change) {
      var points = [];
      var val = 50;
      for (var i = 0; i < 12; i++) {
        val += (Math.random() - 0.5 + (change > 0 ? 0.15 : -0.15)) * 12;
        val = Math.max(10, Math.min(90, val));
        points.push(val);
      }
      if (change > 0) points[11] = Math.max(points[11], points[0] + 5);
      else points[11] = Math.min(points[11], points[0] - 5);
      return points;
    }

    function createSparklineSvg(data, isUp) {
      var w = 160, h = 40;
      var min = Math.min.apply(null, data);
      var max = Math.max.apply(null, data);
      var range = max - min || 1;
      var points = data.map(function(v, i) {
        return [i * (w / (data.length - 1)), h - ((v - min) / range) * (h - 4) - 2];
      });
      var pathD = points.map(function(p, i) {
        return (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1);
      }).join(' ');
      var areaD = pathD + ' L' + w + ',' + h + ' L0,' + h + ' Z';
      return '<div class="sparkline ' + (isUp ? 'up' : 'down') + '">' +
        '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
        '<path class="area" d="' + areaD + '"/>' +
        '<path d="' + pathD + '"/>' +
        '</svg></div>';
    }

    function formatValue(v) {
      if (typeof v !== 'number') return String(v);
      if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
      if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
      return v % 1 === 0 ? String(v) : v.toFixed(1);
    }

    function escapeHtml(s) {
      var d = document.createElement('div');
      d.textContent = String(s);
      return d.innerHTML;
    }

    function renderMetrics(metrics, title) {
      document.getElementById('title').textContent = title || 'Dashboard';
      var grid = document.getElementById('grid');
      grid.innerHTML = '';

      if (!metrics || !metrics.length) {
        grid.innerHTML = '<div class="empty">No metrics to display</div>';
        return;
      }

      metrics.forEach(function(m) {
        var isUp = (m.change || 0) >= 0;
        var sparkData = generateSparklineData(m.change || 0);
        var card = document.createElement('div');
        card.className = 'card';
        card.innerHTML =
          '<div class="metric-name">' + escapeHtml(m.name) + '</div>' +
          '<div class="metric-value">' + formatValue(m.value) +
            (m.unit ? ' <span class="metric-unit">' + escapeHtml(m.unit) + '</span>' : '') +
          '</div>' +
          '<div class="metric-change ' + (isUp ? 'up' : 'down') + '">' +
            '<span>' + (isUp ? '\\u25B2' : '\\u25BC') + '</span>' +
            '<span>' + Math.abs(m.change || 0).toFixed(1) + '%</span>' +
          '</div>' +
          createSparklineSvg(sparkData, isUp);
        grid.appendChild(card);
      });

      setTimeout(function() {
        window._mcp.reportSize(null, document.body.scrollHeight + 20);
      }, 100);
    }

    window.onMcpInit = function(ctx) {
      if (ctx && ctx.theme === 'dark') document.body.classList.add('dark');
    };

    window.onMcpToolInput = function(args) {
      if (args) renderMetrics(args.metrics || [], args.title);
    };

    window.onMcpContextChange = function(changes) {
      if (changes && changes.theme !== undefined) {
        document.body.classList.toggle('dark', changes.theme === 'dark');
      }
    };
  </script>
</body>
</html>`;
