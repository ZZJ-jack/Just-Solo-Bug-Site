// ==========================
//  Cloudflare Worker 后端
//  Just Solo 音乐播放器 - 日志收集与查看
//  固定单线程（source = '主线程'）
//  依赖 D1 绑定 (binding = "DB")
//  环境变量：PWD（删除密码）
//  时间统一：所有时间戳按 TIMEZONE 格式化，避免时区错位
// ==========================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
  'Access-Control-Allow-Headers': 'Content-Type, User-Agent',
};

// ==========================
//  统一时区格式化
//  SQLite CURRENT_TIMESTAMP 存的是 UTC、且无时区后缀，
//  这里统一解析为 Date 并按固定时区格式化为字符串。
//  想换时区只改这一行即可。
// ==========================
const TIMEZONE = 'Asia/Shanghai';

function parseSqliteUtc(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  const s = String(value).trim();
  // SQLite 默认格式：'YYYY-MM-DD HH:MM:SS'（UTC，无后缀）
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?$/);
  if (m) {
    const ms = m[7] ? Math.round(parseFloat(m[7]) * 1000) : 0;
    const d = new Date(Date.UTC(
      +m[1], +m[2] - 1, +m[3],
      +m[4], +m[5], +m[6], ms
    ));
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function formatInTz(value, tz = TIMEZONE) {
  const d = parseSqliteUtc(value);
  if (!d) return value == null ? '未知' : String(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ---------- 1. 提交日志 ----------
    if (path === '/submit' && method === 'POST') {
      try {
        const logData = await request.json();
        const { time, type, content, traceback } = logData;

        // 固定为单线程
        const source = '主线程';

        const userAgent = request.headers.get('User-Agent') || '';
        let version = '未知版本';
        const match = userAgent.match(/Pvz-Game\/(\S+)/);
        if (match) version = match[1];

        if (!type || !content) {
          return Response.json(
            { success: false, error: '缺少必要字段: type 和 content' },
            { status: 400, headers: CORS_HEADERS }
          );
        }

        const result = await env.DB.prepare(
          `INSERT INTO bugs (source, time, type, content, traceback, version)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
        ).bind(
          source,
          time || formatInTz(new Date()),
          type,
          content,
          traceback || '',
          version
        ).run();

        return Response.json(
          {
            success: true,
            id: result.meta?.last_row_id || result.results?.[0]?.id,
            message: '🎵 播放日志已接收！',
            version,
          },
          { headers: CORS_HEADERS }
        );
      } catch (e) {
        console.error('[提交] 异常:', e.stack);
        return Response.json(
          { success: false, error: e.message },
          { status: 500, headers: CORS_HEADERS }
        );
      }
    }

    // ---------- 2. 查看面板 ----------
    if (path === '/' && method === 'GET') {
      const params = new URLSearchParams(url.search);
      const page = parseInt(params.get('page')) || 1;
      const limit = Math.min(parseInt(params.get('limit')) || 20, 100);
      const typeFilter = params.get('type') || '';
      const offset = (page - 1) * limit;

      let whereClause = '';
      let bindParams = [];
      if (typeFilter) {
        whereClause = 'WHERE type = ?';
        bindParams.push(typeFilter);
      }

      const countResult = await env.DB.prepare(
        `SELECT COUNT(*) as total FROM bugs ${whereClause}`
      ).bind(...bindParams).first();
      const totalItems = countResult?.total || 0;
      const totalPages = Math.ceil(totalItems / limit);

      const dataSql = `
        SELECT id, source, time, type, content, traceback, version, created_at
        FROM bugs ${whereClause}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `;
      const { results } = await env.DB.prepare(dataSql)
        .bind(...bindParams, limit, offset)
        .all();

      const typeList = await env.DB.prepare(
        'SELECT DISTINCT type FROM bugs ORDER BY type'
      ).all();
      const typeOptions = typeList.results || [];

      const html = renderDashboard(results, {
        page,
        limit,
        totalPages,
        totalItems,
        type: typeFilter,
        typeOptions,
      });

      return new Response(html, {
        headers: { ...CORS_HEADERS, 'Content-Type': 'text/html' },
      });
    }

    // ---------- 3. JSON API ----------
    if (path === '/api/bugs' && method === 'GET') {
      const params = new URLSearchParams(url.search);
      const page = parseInt(params.get('page')) || 1;
      const limit = Math.min(parseInt(params.get('limit')) || 20, 100);
      const typeFilter = params.get('type') || '';
      const offset = (page - 1) * limit;

      let whereClause = '';
      let bindParams = [];
      if (typeFilter) {
        whereClause = 'WHERE type = ?';
        bindParams.push(typeFilter);
      }
      const sql = `SELECT * FROM bugs ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
      const { results } = await env.DB.prepare(sql)
        .bind(...bindParams, limit, offset)
        .all();

      // API 也补一个统一格式化的字段，方便前端直接使用
      const data = (results || []).map((r) => ({
        ...r,
        created_at_fmt: formatInTz(r.created_at),
      }));

      return Response.json(
        { success: true, data, page, limit },
        { headers: CORS_HEADERS }
      );
    }

    // ---------- 4. 删除日志 ----------
    if (path === '/delete' && method === 'POST') {
      try {
        console.log('[删除] 读取 PWD 环境变量:', env.PWD ? '已设置 (长度=' + env.PWD.length + ')' : '未定义');

        const body = await request.json();
        const { password, ids, id } = body;

        const correctPassword = env.PWD;
        if (!correctPassword) {
          console.error('[删除] 错误: 环境变量 PWD 未配置');
          return Response.json(
            {
              success: false,
              error: '❌ 服务器未配置删除密码（PWD 环境变量），请联系管理员',
              debug: 'env.PWD is undefined'
            },
            { status: 500, headers: CORS_HEADERS }
          );
        }

        if (password !== correctPassword) {
          console.warn('[删除] 密码错误: 输入密码长度=' + (password ? password.length : 0) + ', 正确密码长度=' + correctPassword.length);
          return Response.json(
            { success: false, error: '密码错误' },
            { status: 401, headers: CORS_HEADERS }
          );
        }

        let deleteIds = [];
        if (ids && Array.isArray(ids)) {
          deleteIds = ids;
        } else if (id !== undefined) {
          deleteIds = [id];
        } else {
          return Response.json(
            { success: false, error: '请提供 id 或 ids 数组' },
            { status: 400, headers: CORS_HEADERS }
          );
        }

        if (deleteIds.length === 0) {
          return Response.json(
            { success: false, error: '删除 ID 列表不能为空' },
            { status: 400, headers: CORS_HEADERS }
          );
        }

        console.log('[删除] 准备删除 IDs:', deleteIds);

        const placeholders = deleteIds.map(() => '?').join(',');
        const sql = `DELETE FROM bugs WHERE id IN (${placeholders})`;
        const result = await env.DB.prepare(sql)
          .bind(...deleteIds)
          .run();

        const deletedCount = result.meta?.rows_written || result.results?.length || 0;
        console.log('[删除] 成功删除记录数:', deletedCount);

        return Response.json(
          {
            success: true,
            deletedCount,
            message: `成功删除 ${deletedCount} 条记录`,
          },
          { headers: CORS_HEADERS }
        );
      } catch (e) {
        console.error('[删除] 异常堆栈:', e.stack);
        return Response.json(
          { success: false, error: e.message, stack: e.stack },
          { status: 500, headers: CORS_HEADERS }
        );
      }
    }

    return new Response('❌ 404 - 接口不存在。请访问 / 查看面板，或 POST 到 /submit', {
      status: 404,
      headers: CORS_HEADERS,
    });
  },
};

// ========== HTML 渲染函数（含 Logo） ==========
function renderDashboard(logs, pagination) {
  const { page, totalPages, totalItems, type, typeOptions } = pagination;

  // 服务端一次性按统一时区格式化，客户端直接显示字符串，避免再解析
  const enrichedLogs = logs.map((b) => ({
    ...b,
    created_at_fmt: formatInTz(b.created_at),
  }));

  const logsJson = JSON.stringify(enrichedLogs);

  const rows = enrichedLogs
    .map(
      (b) => `
    <tr>
      <td style="text-align:center;"><input type="checkbox" class="log-checkbox" value="${b.id}"></td>
      <td><strong>#${b.id}</strong></td>
      <td style="font-size:13px; max-width:150px; word-break:break-all;">${b.source}</td>
      <td style="font-size:13px;">${b.time}</td>
      <td><span class="badge">${b.type}</span></td>
      <td><button class="detail-btn" data-id="${b.id}">📄 详情</button></td>
      <td style="font-size:12px; color:#666;">${b.version || '未知'}</td>
      <td style="font-size:12px; color:#666;">${b.created_at_fmt}</td>
    </tr>
  `
    )
    .join('');

  const optionsHtml = typeOptions
    .map(
      (t) =>
        `<option value="${t.type}" ${t.type === type ? 'selected' : ''}>${t.type}</option>`
    )
    .join('');

  const paginationHtml = `
    <div class="pagination">
      <span>共 ${totalItems} 条记录，第 ${page}/${totalPages} 页</span>
      <div>
        <a href="?page=${page - 1}&type=${type}" class="${page <= 1 ? 'disabled' : ''}">⬅ 上一页</a>
        <a href="?page=${page + 1}&type=${type}" class="${page >= totalPages ? 'disabled' : ''}">下一页 ➡</a>
      </div>
    </div>
  `;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🎵 Just Solo 音乐播放器 - 日志监控</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', -apple-system, sans-serif; background: #f4f6f9; padding: 30px; color: #1e293b; }
    .container { max-width: 1400px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; flex-wrap: wrap; gap: 15px; }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand img { height: 40px; width: auto; }
    .brand h1 { font-size: 28px; font-weight: 700; color: #7c3aed; margin: 0; background: none; -webkit-text-fill-color: #7c3aed; }
    .stats { background: white; padding: 15px 25px; border-radius: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); border: 1px solid #e2e8f0; }
    .stats span { font-weight: 700; color: #0f172a; }
    .filters { background: white; padding: 15px 25px; border-radius: 16px; margin-bottom: 25px; display: flex; gap: 20px; align-items: center; flex-wrap: wrap; border: 1px solid #e2e8f0; }
    .filters select, .filters input { padding: 8px 14px; border-radius: 8px; border: 1px solid #cbd5e1; background: white; font-size: 14px; }
    .filters button { background: #0f172a; color: white; border: none; padding: 8px 20px; border-radius: 8px; cursor: pointer; font-weight: 500; }
    .filters button:hover { background: #1e293b; }
    .table-wrap { background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.04); border: 1px solid #e2e8f0; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { background: #f8fafc; text-align: left; padding: 14px 16px; font-weight: 600; color: #475569; border-bottom: 2px solid #e2e8f0; }
    td { padding: 14px 16px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
    tr:hover td { background: #f8fafc; }
    .badge { background: #e0e7ff; color: #4338ca; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; display: inline-block; }
    .empty { text-align: center; padding: 60px 20px; color: #94a3b8; }
    .empty .emoji { font-size: 48px; display: block; margin-bottom: 10px; }
    .pagination { display: flex; justify-content: space-between; align-items: center; padding: 18px 24px; background: white; border-top: 1px solid #e2e8f0; flex-wrap: wrap; gap: 10px; }
    .pagination a { padding: 6px 16px; background: #f1f5f9; border-radius: 6px; text-decoration: none; color: #0f172a; margin: 0 4px; font-size: 14px; }
    .pagination a.disabled { opacity: 0.4; pointer-events: none; }
    .pagination a:hover:not(.disabled) { background: #e2e8f0; }
    .footer-tip { margin-top: 15px; font-size: 13px; color: #94a3b8; text-align: center; }
    code { background: #e2e8f0; padding: 2px 8px; border-radius: 4px; font-size: 13px; }

    .delete-area {
      background: white;
      padding: 18px 24px;
      border-radius: 16px;
      margin-top: 20px;
      display: flex;
      align-items: center;
      gap: 15px;
      flex-wrap: wrap;
      border: 1px solid #e2e8f0;
    }
    .delete-area input[type="password"] {
      padding: 8px 14px;
      border-radius: 8px;
      border: 1px solid #cbd5e1;
      font-size: 14px;
      width: 200px;
    }
    .delete-area .btn-delete {
      background: #dc2626;
      color: white;
      border: none;
      padding: 8px 24px;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
      font-size: 14px;
    }
    .delete-area .btn-delete:hover { background: #b91c1c; }
    .delete-area .btn-delete:disabled { opacity: 0.6; cursor: not-allowed; }
    .delete-area .status-msg { font-size: 14px; color: #16a34a; }
    .delete-area .status-msg.error { color: #dc2626; }
    .select-all { margin-right: 5px; }

    .detail-btn {
      background: #0f172a;
      color: white;
      border: none;
      padding: 4px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
    }
    .detail-btn:hover { background: #1e293b; }

    .modal-overlay {
      display: none;
      position: fixed;
      top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.5);
      z-index: 1000;
      justify-content: center;
      align-items: center;
    }
    .modal-overlay.active { display: flex; }
    .modal-box {
      background: white;
      max-width: 800px;
      width: 90%;
      max-height: 80vh;
      padding: 30px;
      border-radius: 16px;
      overflow-y: auto;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      position: relative;
    }
    .modal-close {
      position: sticky;
      top: 0;
      float: right;
      background: none;
      border: none;
      font-size: 28px;
      cursor: pointer;
      color: #94a3b8;
    }
    .modal-close:hover { color: #0f172a; }
    .modal-title { font-size: 22px; font-weight: 700; margin-bottom: 20px; }
    .modal-field { margin-bottom: 15px; }
    .modal-field strong { display: inline-block; min-width: 80px; color: #475569; }
    .modal-field .value { word-break: break-all; }
    .modal-field .traceback {
      background: #f1f5f9;
      padding: 12px;
      border-radius: 8px;
      font-family: 'Courier New', monospace;
      font-size: 13px;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 300px;
      overflow-y: auto;
      margin-top: 4px;
    }
  </style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="brand">
      <img src="https://zzjjack.us.kg/img/Just-Solo.png" alt="Just Solo">
      <h1>Just Solo 音乐播放器 – 日志监控</h1>
    </div>
    <div class="stats">📊 当前显示 <span>${logs.length}</span> 条 · 总计 <span>${totalItems}</span> 条</div>
  </div>

  <div class="filters">
    <form method="GET" style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
      <label>筛选事件类型：</label>
      <select name="type">
        <option value="">全部类型</option>
        ${optionsHtml}
      </select>
      <button type="submit">应用筛选</button>
      <a href="/" style="color:#7c3aed; text-decoration:none; font-size:14px;">🔄 重置</a>
    </form>
  </div>

  <div class="table-wrap">
    ${logs.length === 0 ? `
      <div class="empty">
        <span class="emoji">🎧</span>
        <p>暂无播放器日志，一切正常！</p>
      </div>
    ` : `
      <table>
        <thead>
          <tr>
            <th style="text-align:center; width:40px;"><input type="checkbox" id="select-all" class="select-all"></th>
            <th>ID</th>
            <th>来源线程</th>
            <th>播放时间</th>
            <th>事件类型</th>
            <th>详情</th>
            <th>客户端版本</th>
            <th>接收时间</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `}
    ${logs.length > 0 ? paginationHtml : ''}
  </div>

  ${logs.length > 0 ? `
  <div class="delete-area">
    <span style="font-weight:500;">🗑️ 删除选中：</span>
    <input type="password" id="delete-password" placeholder="请输入删除密码" />
    <button class="btn-delete" id="delete-btn">删除选中</button>
    <span id="delete-status" class="status-msg"></span>
  </div>
  ` : ''}
</div>

<!-- 详情模态框 -->
<div class="modal-overlay" id="detailModal">
  <div class="modal-box">
    <button class="modal-close" id="modalClose">&times;</button>
    <div class="modal-title">📄 日志详细信息</div>
    <div id="modalContent"></div>
  </div>
</div>

<script>
  const logsData = ${logsJson};

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function openDetail(id) {
    const log = logsData.find(b => b.id === id);
    if (!log) return;

    const content = document.getElementById('modalContent');
    content.innerHTML = \`
      <div class="modal-field"><strong>ID：</strong><span class="value">\${escapeHtml(log.id)}</span></div>
      <div class="modal-field"><strong>来源：</strong><span class="value">\${escapeHtml(log.source || '未知')}</span></div>
      <div class="modal-field"><strong>播放时间：</strong><span class="value">\${escapeHtml(log.time)}</span></div>
      <div class="modal-field"><strong>事件类型：</strong><span class="value">\${escapeHtml(log.type)}</span></div>
      <div class="modal-field"><strong>版本：</strong><span class="value">\${escapeHtml(log.version || '未知')}</span></div>
      <div class="modal-field"><strong>接收时间：</strong><span class="value">\${escapeHtml(log.created_at_fmt)}</span></div>
      <div class="modal-field"><strong>事件内容：</strong><div class="value" style="background:#f8fafc;padding:8px;border-radius:6px;white-space:pre-wrap;word-break:break-all;">\${escapeHtml(log.content)}</div></div>
      <div class="modal-field"><strong>完整堆栈：</strong><div class="traceback">\${escapeHtml(log.traceback || '无堆栈信息')}</div></div>
    \`;
    document.getElementById('detailModal').classList.add('active');
  }

  document.getElementById('modalClose').addEventListener('click', function() {
    document.getElementById('detailModal').classList.remove('active');
  });
  document.getElementById('detailModal').addEventListener('click', function(e) {
    if (e.target === this) this.classList.remove('active');
  });

  document.querySelectorAll('.detail-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      const id = parseInt(this.dataset.id);
      openDetail(id);
    });
  });

  const selectAll = document.getElementById('select-all');
  if (selectAll) {
    selectAll.addEventListener('change', function() {
      document.querySelectorAll('.log-checkbox').forEach(cb => cb.checked = this.checked);
    });
  }

  const deleteBtn = document.getElementById('delete-btn');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async function() {
      const passwordInput = document.getElementById('delete-password');
      const statusMsg = document.getElementById('delete-status');
      const checkedBoxes = document.querySelectorAll('.log-checkbox:checked');
      const ids = Array.from(checkedBoxes).map(cb => parseInt(cb.value));

      if (ids.length === 0) {
        statusMsg.textContent = '⚠️ 请至少勾选一条记录';
        statusMsg.className = 'status-msg error';
        return;
      }

      const password = passwordInput.value.trim();
      if (!password) {
        statusMsg.textContent = '⚠️ 请输入删除密码';
        statusMsg.className = 'status-msg error';
        return;
      }

      deleteBtn.disabled = true;
      deleteBtn.textContent = '删除中...';
      statusMsg.textContent = '';
      statusMsg.className = 'status-msg';

      try {
        const response = await fetch('/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password, ids })
        });
        const result = await response.json();

        if (result.success) {
          statusMsg.textContent = '✅ ' + result.message;
          statusMsg.className = 'status-msg';
          setTimeout(() => location.reload(), 800);
        } else {
          statusMsg.textContent = '❌ ' + (result.error || '删除失败');
          statusMsg.className = 'status-msg error';
          deleteBtn.disabled = false;
          deleteBtn.textContent = '删除选中';
        }
      } catch (err) {
        statusMsg.textContent = '❌ 网络错误：' + err.message;
        statusMsg.className = 'status-msg error';
        deleteBtn.disabled = false;
        deleteBtn.textContent = '删除选中';
      }
    });
  }
</script>
</body>
</html>`;
}
