// ==========================
//  Cloudflare Worker 后端
//  版本提取 + 删除（含日志） + 详情弹窗
//  依赖 D1 绑定 (binding = "DB")
//  环境变量：PWD（删除密码）
// ==========================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
  'Access-Control-Allow-Headers': 'Content-Type, User-Agent',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ---------- 1. 提交 Bug ----------
    if (path === '/submit' && method === 'POST') {
      try {
        const bugData = await request.json();
        const { source, time, type, content, traceback } = bugData;

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
          source || '未知线程',
          time || new Date().toLocaleString(),
          type,
          content,
          traceback || '',
          version
        ).run();

        return Response.json(
          {
            success: true,
            id: result.meta?.last_row_id || result.results?.[0]?.id,
            message: '🐞 Bug 报告已接收！',
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
      return Response.json(
        { success: true, data: results, page, limit },
        { headers: CORS_HEADERS }
      );
    }

    // ---------- 4. 删除 Bug（含详细日志） ----------
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
          console.warn('[删除] 密码错误: 输入密码长度=' + password.length + ', 正确密码长度=' + correctPassword.length);
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

// ========== HTML 渲染函数（内容列显示“📄 详情”按钮） ==========
function renderDashboard(bugs, pagination) {
  const { page, totalPages, totalItems, type, typeOptions } = pagination;

  const bugsJson = JSON.stringify(bugs);

  // 表格行：内容列改为“📄 详情”按钮，移除操作列
  const rows = bugs
    .map(
      (b) => `
    <tr>
      <td style="text-align:center;"><input type="checkbox" class="bug-checkbox" value="${b.id}"></td>
      <td><strong>#${b.id}</strong></td>
      <td style="font-size:13px; max-width:150px; word-break:break-all;">${b.source}</td>
      <td style="font-size:13px;">${b.time}</td>
      <td><span class="badge">${b.type}</span></td>
      <td><button class="detail-btn" data-id="${b.id}">📄 详情</button></td>
      <td style="font-size:12px; color:#666;">${b.version || '未知'}</td>
      <td style="font-size:12px; color:#666;">${new Date(b.created_at).toLocaleString('zh-CN')}</td>
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
  <title>🐞 游戏 Bug 实时监控面板</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', -apple-system, sans-serif; background: #f4f6f9; padding: 30px; color: #1e293b; }
    .container { max-width: 1400px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; flex-wrap: wrap; gap: 15px; }
    h1 { font-size: 28px; font-weight: 700; background: linear-gradient(135deg, #e11d48, #f43f5e); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
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
    .badge { background: #fee2e2; color: #b91c1c; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; display: inline-block; }
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
      background: #e11d48;
      color: white;
      border: none;
      padding: 8px 24px;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
      font-size: 14px;
    }
    .delete-area .btn-delete:hover { background: #be123c; }
    .delete-area .btn-delete:disabled { opacity: 0.6; cursor: not-allowed; }
    .delete-area .status-msg { font-size: 14px; color: #16a34a; }
    .delete-area .status-msg.error { color: #dc2626; }
    .select-all { margin-right: 5px; }

    /* 详情按钮（表格内） */
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

    /* 模态框 */
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
    <h1>🐞 Bug 追踪仪表盘</h1>
    <div class="stats">📊 当前显示 <span>${bugs.length}</span> 条 · 数据库总计 <span>${totalItems}</span> 条</div>
  </div>

  <div class="filters">
    <form method="GET" style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
      <label>筛选错误类型：</label>
      <select name="type">
        <option value="">全部类型</option>
        ${optionsHtml}
      </select>
      <button type="submit">应用筛选</button>
      <a href="/" style="color:#e11d48; text-decoration:none; font-size:14px;">🔄 重置</a>
    </form>
  </div>

  <div class="table-wrap">
    ${bugs.length === 0 ? `
      <div class="empty">
        <span class="emoji">🎉</span>
        <p>暂无 Bug 记录，你的游戏运行得很稳定！</p>
      </div>
    ` : `
      <table>
        <thead>
          <tr>
            <th style="text-align:center; width:40px;"><input type="checkbox" id="select-all" class="select-all"></th>
            <th>ID</th>
            <th>来源线程</th>
            <th>游戏时间</th>
            <th>类型</th>
            <th>详情</th>   <!-- 内容列改为“详情” -->
            <th>客户端版本</th>
            <th>接收时间</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `}
    ${bugs.length > 0 ? paginationHtml : ''}
  </div>

  ${bugs.length > 0 ? `
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
    <div class="modal-title">📄 Bug 详细信息</div>
    <div id="modalContent"></div>
  </div>
</div>

<script>
  const bugsData = ${bugsJson};

  function openDetail(id) {
    const bug = bugsData.find(b => b.id === id);
    if (!bug) return;

    const content = document.getElementById('modalContent');
    content.innerHTML = \`
      <div class="modal-field"><strong>ID：</strong><span class="value">\${bug.id}</span></div>
      <div class="modal-field"><strong>来源：</strong><span class="value">\${bug.source || '未知'}</span></div>
      <div class="modal-field"><strong>游戏时间：</strong><span class="value">\${bug.time}</span></div>
      <div class="modal-field"><strong>类型：</strong><span class="value">\${bug.type}</span></div>
      <div class="modal-field"><strong>版本：</strong><span class="value">\${bug.version || '未知'}</span></div>
      <div class="modal-field"><strong>接收时间：</strong><span class="value">\${new Date(bug.created_at).toLocaleString('zh-CN')}</span></div>
      <div class="modal-field"><strong>错误内容：</strong><div class="value" style="background:#f8fafc;padding:8px;border-radius:6px;white-space:pre-wrap;word-break:break-all;">\${bug.content}</div></div>
      <div class="modal-field"><strong>完整堆栈：</strong><div class="traceback">\${bug.traceback || '无堆栈信息'}</div></div>
    \`;
    document.getElementById('detailModal').classList.add('active');
  }

  document.getElementById('modalClose').addEventListener('click', function() {
    document.getElementById('detailModal').classList.remove('active');
  });
  document.getElementById('detailModal').addEventListener('click', function(e) {
    if (e.target === this) this.classList.remove('active');
  });

  // 绑定所有详情按钮（包括内容列和可能保留的详情按钮，但这里只有内容列有）
  document.querySelectorAll('.detail-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      const id = parseInt(this.dataset.id);
      openDetail(id);
    });
  });

  const selectAll = document.getElementById('select-all');
  if (selectAll) {
    selectAll.addEventListener('change', function() {
      document.querySelectorAll('.bug-checkbox').forEach(cb => cb.checked = this.checked);
    });
  }

  const deleteBtn = document.getElementById('delete-btn');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async function() {
      const passwordInput = document.getElementById('delete-password');
      const statusMsg = document.getElementById('delete-status');
      const checkedBoxes = document.querySelectorAll('.bug-checkbox:checked');
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
