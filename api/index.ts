import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase } from '../lib/supabase';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // If JSON requested via query or Accept header, delegate or return JSON status
  if (req.query.format === 'json' || req.headers.accept?.includes('application/json')) {
    try {
      const supabase = getSupabase();
      const { data: items } = await supabase
        .from('youtube_pipeline')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20);

      return res.status(200).json({
        success: true,
        items: items || [],
      });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Fetch current database state from Supabase to render SSR Dashboard
  let pending = 0;
  let processing = 0;
  let pausedQuota = 0;
  let readyForPc = 0;
  let completed = 0;
  let recentItems: any[] = [];
  let dbConnected = true;
  let dbError = '';
  let activePauseMinutes = 0;

  try {
    const supabase = getSupabase();
    const { data: items, error } = await supabase
      .from('youtube_pipeline')
      .select('id, topic, title, status, quota_paused_at, error_message, created_at, updated_at')
      .order('created_at', { ascending: false })
      .limit(30);

    if (error) {
      dbConnected = false;
      dbError = error.message;
    } else if (items) {
      recentItems = items;
      items.forEach((item) => {
        if (item.status === 'pending') pending++;
        else if (item.status === 'processing') processing++;
        else if (item.status === 'paused_quota') {
          pausedQuota++;
          if (item.quota_paused_at) {
            const elapsed = (Date.now() - new Date(item.quota_paused_at).getTime()) / (1000 * 60 * 60);
            activePauseMinutes = Math.max(0, Math.ceil((4 - elapsed) * 60));
          }
        }
        else if (item.status === 'ready_for_pc') readyForPc++;
        else if (item.status === 'completed') completed++;
      });
    }
  } catch (err: any) {
    dbConnected = false;
    dbError = err.message || String(err);
  }

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>YouTube AI Orchestrator | Dashboard Vercel</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Inter', sans-serif; }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen">
  <div class="max-w-6xl mx-auto px-4 py-8">
    
    <!-- Header -->
    <header class="flex flex-col md:flex-row md:items-center md:justify-between border-b border-slate-800 pb-6 mb-8 gap-4">
      <div>
        <div class="flex items-center gap-3">
          <div class="h-10 w-10 rounded-xl bg-gradient-to-tr from-rose-500 to-indigo-600 flex items-center justify-center text-xl font-bold shadow-lg shadow-rose-500/20">
            🎬
          </div>
          <div>
            <h1 class="text-2xl font-bold tracking-tight">YouTube AI Orchestrator</h1>
            <p class="text-slate-400 text-xs mt-0.5">Vercel Serverless + Google Gemini 1.5 Pro + Supabase Pipeline</p>
          </div>
        </div>
      </div>

      <div class="flex items-center gap-2">
        <button id="btnTrigger" onclick="triggerOrchestrator()" class="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-rose-600 to-indigo-600 hover:from-rose-500 hover:to-indigo-500 font-semibold text-sm rounded-lg shadow-md transition-all active:scale-95 disabled:opacity-50">
          <span>⚡ Ejecutar Orquestador</span>
        </button>
        <button onclick="pingKeepAlive()" class="px-3 py-2 bg-slate-900 hover:bg-slate-800 text-slate-300 text-xs rounded-lg border border-slate-800 transition">
          🛡️ Ping Keep-Alive
        </button>
        <button onclick="window.location.reload()" class="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg border border-slate-700 transition">
          🔄 Refrescar
        </button>
      </div>
    </header>

    <!-- Database Connection Warning -->
    ${!dbConnected ? `
    <div class="mb-6 p-4 rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-300 flex items-center gap-3">
      <span class="text-2xl">⚠️</span>
      <div>
        <h4 class="font-semibold text-sm">Error de Conexión con Supabase</h4>
        <p class="text-xs text-rose-200/80 mt-0.5 font-mono">${escapeHtml(dbError)}</p>
        <p class="text-xs text-rose-300/80 mt-1">Verifica que las variables <code>SUPABASE_URL</code> y <code>SUPABASE_SERVICE_ROLE_KEY</code> estén configuradas en Vercel.</p>
      </div>
    </div>
    ` : ''}

    <!-- Quota Alert Banner -->
    <div id="quotaBanner" class="${pausedQuota > 0 ? '' : 'hidden'} mb-6 p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-300 flex items-center gap-3 shadow-sm">
      <span class="text-2xl">⏸️</span>
      <div>
        <h4 class="font-semibold text-sm">Pausa Automática de Cuota (Gemini 429)</h4>
        <p class="text-xs text-amber-200/80 mt-0.5" id="quotaBannerText">
          ${activePauseMinutes > 0 ? `Límite de Google alcanzado. Enfriamiento activo: ~${activePauseMinutes} minutos restantes. El orquestador descansa consumiendo 0 recursos.` : 'Límite de cuota activo.'}
        </p>
      </div>
    </div>

    <!-- Alert / Toast Banner -->
    <div id="messageAlert" class="hidden mb-6 p-4 rounded-xl text-sm transition"></div>

    <!-- Metrics Grid -->
    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-8">
      <div class="bg-slate-900/80 border border-slate-800 p-4 rounded-xl">
        <span class="text-xs font-medium text-slate-400 uppercase tracking-wider">Pendientes</span>
        <div class="text-2xl font-bold text-amber-400 mt-1" id="countPending">${pending}</div>
      </div>
      <div class="bg-slate-900/80 border border-slate-800 p-4 rounded-xl">
        <span class="text-xs font-medium text-slate-400 uppercase tracking-wider">En Proceso</span>
        <div class="text-2xl font-bold text-blue-400 mt-1" id="countProcessing">${processing}</div>
      </div>
      <div class="bg-slate-900/80 border border-slate-800 p-4 rounded-xl">
        <span class="text-xs font-medium text-slate-400 uppercase tracking-wider">Pausa Cuota</span>
        <div class="text-2xl font-bold text-orange-400 mt-1" id="countQuota">${pausedQuota}</div>
      </div>
      <div class="bg-slate-900/80 border border-slate-800 p-4 rounded-xl">
        <span class="text-xs font-medium text-slate-400 uppercase tracking-wider">Listos para PC</span>
        <div class="text-2xl font-bold text-emerald-400 mt-1" id="countReady">${readyForPc}</div>
      </div>
      <div class="bg-slate-900/80 border border-slate-800 p-4 rounded-xl">
        <span class="text-xs font-medium text-slate-400 uppercase tracking-wider">Completados</span>
        <div class="text-2xl font-bold text-purple-400 mt-1" id="countCompleted">${completed}</div>
      </div>
    </div>

    <!-- Add Topic Form -->
    <section class="bg-slate-900/50 border border-slate-800 rounded-2xl p-6 mb-8">
      <h2 class="text-base font-semibold text-slate-200 mb-1">➕ Añadir Nuevo Tema a la Cola</h2>
      <p class="text-xs text-slate-400 mb-4">El orquestador en Vercel lo procesará con Gemini 1.5 Pro y lo preparará para renderizar en tu PC.</p>
      <form id="addTopicForm" onsubmit="addTopic(event)" class="flex flex-col sm:flex-row gap-3">
        <input 
          type="text" 
          id="topicInput" 
          placeholder="Ej: Los 5 misterios más increíbles del espacio profundo" 
          required
          class="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-rose-500 focus:ring-1 focus:ring-rose-500 placeholder-slate-500 text-slate-200"
        >
        <button type="submit" id="btnAdd" class="px-5 py-2 bg-rose-600 hover:bg-rose-500 text-white font-medium text-sm rounded-lg transition active:scale-95">
          Añadir a la Cola
        </button>
      </form>
    </section>

    <!-- Pipeline Jobs Table -->
    <section class="bg-slate-900/40 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
      <div class="p-4 border-b border-slate-800 flex justify-between items-center">
        <h3 class="font-semibold text-sm text-slate-200">Cola de Producción (Últimos Trabajos)</h3>
        <span class="text-xs text-slate-500" id="lastUpdated">Actualizado: ${new Date().toLocaleTimeString()}</span>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm text-slate-300">
          <thead class="text-xs uppercase bg-slate-950/60 text-slate-400 border-b border-slate-800">
            <tr>
              <th class="px-6 py-3">Tema / Título</th>
              <th class="px-6 py-3">Estado</th>
              <th class="px-6 py-3">Fecha</th>
              <th class="px-6 py-3">Detalle / Error</th>
            </tr>
          </thead>
          <tbody id="jobsTableBody" class="divide-y divide-slate-800/60 text-xs">
            ${recentItems.length === 0 ? `
              <tr><td colspan="4" class="px-6 py-8 text-center text-slate-500">No hay elementos en la cola. Añade uno arriba para comenzar.</td></tr>
            ` : recentItems.map(item => {
              const statusColors: Record<string, string> = {
                'pending': 'bg-amber-500/10 text-amber-400 border-amber-500/20',
                'processing': 'bg-blue-500/10 text-blue-400 border-blue-500/20',
                'paused_quota': 'bg-orange-500/10 text-orange-400 border-orange-500/20',
                'ready_for_pc': 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
                'completed': 'bg-purple-500/10 text-purple-400 border-purple-500/20',
                'error': 'bg-rose-500/10 text-rose-400 border-rose-500/20',
              };
              const badgeColor = statusColors[item.status] || 'bg-slate-800 text-slate-400 border-slate-700';

              return `
                <tr class="hover:bg-slate-800/30 transition">
                  <td class="px-6 py-4">
                    <div class="font-medium text-slate-200 text-sm">${escapeHtml(item.title || item.topic)}</div>
                    ${item.title ? `<div class="text-xs text-slate-500 mt-0.5">Tema original: ${escapeHtml(item.topic)}</div>` : ''}
                  </td>
                  <td class="px-6 py-4">
                    <span class="inline-flex items-center px-2.5 py-0.5 rounded-full font-mono text-[11px] font-semibold border ${badgeColor}">
                      ${item.status}
                    </span>
                  </td>
                  <td class="px-6 py-4 text-slate-400 font-mono text-[11px]">
                    ${new Date(item.created_at).toLocaleString()}
                  </td>
                  <td class="px-6 py-4 text-slate-400">
                    ${item.error_message ? `<span class="text-rose-400 font-mono text-[11px]">${escapeHtml(item.error_message)}</span>` : '<span class="text-slate-600">—</span>'}
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </section>

    <!-- Footer info -->
    <footer class="mt-8 text-center text-xs text-slate-500">
      <p>Orchestrator activo en Vercel Serverless. Ejecuciones cada 15 min protegidas con límite de cuota inteligente.</p>
    </footer>

  </div>

  <script>
    async function triggerOrchestrator() {
      const btn = document.getElementById('btnTrigger');
      const alertBox = document.getElementById('messageAlert');
      btn.disabled = true;
      btn.innerHTML = '<span>⏳ Procesando con Gemini...</span>';

      try {
        const res = await fetch('/api/orchestrator');
        const data = await res.json();

        alertBox.className = 'mb-6 p-4 rounded-xl text-sm transition ' + (data.success ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300' : 'bg-rose-500/10 border border-rose-500/20 text-rose-300');
        alertBox.innerText = 'Resultado [' + (data.action || 'OK') + ']: ' + (data.message || data.title || JSON.stringify(data));
        alertBox.classList.remove('hidden');

        setTimeout(() => window.location.reload(), 2500);
      } catch (err) {
        alertBox.className = 'mb-6 p-4 rounded-xl text-sm bg-rose-500/10 border border-rose-500/20 text-rose-300';
        alertBox.innerText = 'Error al ejecutar: ' + err.message;
        alertBox.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>⚡ Ejecutar Orquestador</span>';
      }
    }

    async function pingKeepAlive() {
      const alertBox = document.getElementById('messageAlert');
      try {
        const res = await fetch('/api/keep-alive');
        const data = await res.json();
        alertBox.className = 'mb-6 p-4 rounded-xl text-sm bg-indigo-500/10 border border-indigo-500/20 text-indigo-300';
        alertBox.innerText = '🛡️ Keep-Alive OK: ' + (data.message || 'Supabase & Vercel activos.') + ' (Latencia: ' + (data.latency_ms || 0) + 'ms)';
        alertBox.classList.remove('hidden');
      } catch (e) {
        alert('Keep-alive falló: ' + e.message);
      }
    }

    async function addTopic(e) {
      e.preventDefault();
      const input = document.getElementById('topicInput');
      const btn = document.getElementById('btnAdd');
      const topic = input.value.trim();
      if (!topic) return;

      btn.disabled = true;
      btn.innerText = 'Añadiendo...';
      try {
        const res = await fetch('/api/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic }),
        });
        const data = await res.json();
        if (data.success) {
          input.value = '';
          window.location.reload();
        } else {
          alert('Error: ' + (data.error || 'No se pudo añadir'));
        }
      } catch (err) {
        alert('Error: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.innerText = 'Añadir a la Cola';
      }
    }

    // Auto-refresh every 30 seconds
    setTimeout(() => window.location.reload(), 30000);
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
}

function escapeHtml(str: any): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
