/* NTGD Monitor - Clean version with last year stats */
(() => {
  // --- Element refs ---
  const els = {
    totalRaised: document.getElementById('totalRaised'),
    totalDonors: document.getElementById('totalDonors'),
    avgGift: document.getElementById('avgGift'),
    orgCount: document.getElementById('orgCount'),
    orgs: document.getElementById('organizationsContainer'),
    startBtn: document.getElementById('startBtn'),
    stopBtn: document.getElementById('stopBtn'),
    refreshNowBtn: document.getElementById('refreshNowBtn'),
    exportBtn: document.getElementById('exportBtn'),
    statusIndicator: document.getElementById('statusIndicator'),
    statusText: document.getElementById('statusText'),
    lastUpdate: document.getElementById('lastUpdate'),
    refreshInterval: document.getElementById('refreshInterval'),
    headerDescription: document.getElementById('headerDescription'),
    lastYearContainer: document.getElementById('lastYearStatsContainer')
  };

  // --- State ---
  let orgs = {};
  let prevOrgs = {};
  let isRefreshing = false;
  let isMonitoring = false;
  let timer = null;
  let lastYearStats = null;

  // --- Formatters ---
  const $fmt = n => new Intl.NumberFormat('en-US', { 
    style: 'currency', 
    currency: 'USD', 
    maximumFractionDigits: 0 
  }).format(n || 0);
  
  const nfmt = n => new Intl.NumberFormat('en-US').format(n || 0);

  // --- Toast ---
  let toastTimer;
  function toast(msg, ok = true) {
    clearTimeout(toastTimer);
    document.querySelectorAll('.toast').forEach(t => t.remove());
    const t = document.createElement('div');
    t.className = 'toast ' + (ok ? 'success' : 'error');
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    toastTimer = setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 300);
    }, 2500);
  }

  // --- HTTP helper with timeout ---
  async function api(path, opts = {}) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(path, { 
        headers: { 'Content-Type': 'application/json' }, 
        signal: ctrl.signal, 
        ...opts 
      });
      clearTimeout(to);
      if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(()=>'Error')}`);
      return res.json();
    } catch (e) {
      clearTimeout(to);
      if (e.name === 'AbortError') throw new Error('Request timed out');
      throw e;
    }
  }

  // --- Load last year data ---
  async function loadLastYear() {
    try {
      const res = await fetch('/data/ntxgd_last_year.json?v=ly-4', { cache: 'no-store' });
      lastYearStats = await res.json();
      renderLastYearStats();
    } catch (e) {
      console.log('Last year data not available:', e);
      if (els.lastYearContainer) {
        els.lastYearContainer.innerHTML = '<p style="text-align:center;color:#7f8c8d;">Last year data not available</p>';
      }
    }
  }

  // --- Render last year stats block ---
  function renderLastYearStats() {
    if (!lastYearStats || !lastYearStats.length || !els.lastYearContainer) {
      if (els.lastYearContainer) {
        els.lastYearContainer.innerHTML = '<p style="text-align:center;color:#7f8c8d;">No last year data available</p>';
      }
      return;
    }

    const statsHTML = lastYearStats.map(org => {
      const timeBarsHTML = (org.dayOf || []).map(timeSlot => {
        const height = Math.max(4, Math.min(100, timeSlot.percent || 0));
        return `
          <div class="time-bar">
            <div class="time-bar-col" style="height: ${height}%"></div>
            <div class="time-bar-percent">${Math.round(timeSlot.percent || 0)}%</div>
            <div class="time-bar-label">${timeSlot.label}</div>
          </div>
        `;
      }).join('');

      return `
        <div class="stat-org-card">
          <div class="stat-org-name">${org.orgName}</div>
          <div class="stat-totals">
            <div class="stat-total-item">
              <div class="stat-total-value">${$fmt(org.totals?.dollars || 0)}</div>
              <div class="stat-total-label">Raised</div>
            </div>
            <div class="stat-total-item">
              <div class="stat-total-value">${nfmt(org.totals?.donors || 0)}</div>
              <div class="stat-total-label">Donors</div>
            </div>
            <div class="stat-total-item">
              <div class="stat-total-value">${nfmt(org.totals?.gifts || 0)}</div>
              <div class="stat-total-label">Gifts</div>
            </div>
          </div>
          <div class="time-breakdown">
            <h4>Time of Day Breakdown</h4>
            <div class="time-bars">
              ${timeBarsHTML}
            </div>
          </div>
        </div>
      `;
    }).join('');

    els.lastYearContainer.innerHTML = `<div class="stats-grid">${statsHTML}</div>`;
  }

  // --- Last year matching functions ---
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  
  function matchLastYear(org) {
    if (!lastYearStats) return null;
    
    // Try exact ID match first
    const bySlug = lastYearStats.find(d => 
      (d.orgId || '').toLowerCase() === (org.id || '').toLowerCase()
    );
    if (bySlug) return bySlug;
    
    // Try name matching
    const key = norm(org.name);
    return lastYearStats.find(d => norm(d.orgName) === key) || null;
  }

  function lyFooterHTML(ly) {
    if (!ly) return '';
    
    const donors = ly.totals?.donors || 0;
    const dollars = ly.totals?.dollars || 0;
    const gifts = ly.totals?.gifts || 0;
    
    const barsHTML = (ly.dayOf || []).map(b => {
      const pct = Number(b.percent) || 0;
      const h = Math.max(2, Math.min(100, pct));
      return `
        <div class="ly-bar">
          <div class="col" style="height:${h}%"></div>
          <div class="pct">${pct}%</div>
          <div class="lab">${b.label}</div>
        </div>`;
    }).join('');

    return `
      <div class="ly-footer">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
          <div style="font:600 12px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto;color:#7f8c8d;">
            Last year: <span style="color:#2c3e50">${$fmt(dollars)}</span> • <span style="color:#2c3e50">${nfmt(donors)}</span> donors • <span style="color:#2c3e50">${nfmt(gifts)}</span> gifts
          </div>
          <div style="font:600 12px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto;color:#7f8c8d;">Time of day</div>
        </div>
        <div class="ly-chart">
          <div class="ly-bars">${barsHTML}</div>
        </div>
      </div>`;
  }

  // --- Freshness ---
  function getFreshness(org) {
    if (!org.lastUpdated) return null;
    const secs = (Date.now() - new Date(org.lastUpdated).getTime()) / 1000;
    if (secs < 300) return 'fresh';
    if (secs < 900) return 'stale';
    return 'very-stale';
  }

  function wasUpdated(id) {
    const a = orgs[id], b = prevOrgs[id];
    if (!a || !b) return false;
    return a.total !== b.total || a.donors !== b.donors || a.goal !== b.goal;
  }

  // --- Summary ---
  let lastSummary = {};
  function updateSummary() {
    const arr = Object.values(orgs);
    const totalRaised = arr.reduce((s, o) => s + (o.total || 0), 0);
    const totalDonors = arr.reduce((s, o) => s + (o.donors || 0), 0);
    const avgGift = totalDonors ? totalRaised / totalDonors : 0;
    const orgCount = arr.length;
    const next = { totalRaised, totalDonors, avgGift, orgCount };
    
    if (JSON.stringify(next) !== JSON.stringify(lastSummary)) {
      els.totalRaised.textContent = $fmt(totalRaised);
      els.totalDonors.textContent = nfmt(totalDonors);
      els.avgGift.textContent = $fmt(avgGift);
      els.orgCount.textContent = nfmt(orgCount);
      lastSummary = next;
    }
  }

  // --- Render ---
  function render() {
    const list = Object.values(orgs).sort((a, b) => (b.total || 0) - (a.total || 0));
    els.orgs.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'org-grid';
    els.orgs.appendChild(grid);

    if (!list.length) {
      grid.innerHTML = `
        <div class="gentle-start" style="grid-column:1/-1;">
          <h3>Ready to track your organizations</h3>
          <p>Click "Start Auto-Refresh" to begin monitoring donation progress in real-time, or "Refresh Now" for a one-time update.</p>
          <div style="display:flex;gap:12px;justify-content:center;">
            <button class="btn btn-success" id="__start">Start Auto-Refresh</button>
            <button class="btn btn-primary" id="__now">Refresh Now</button>
          </div>
        </div>`;
      grid.querySelector('#__start')?.addEventListener('click', () => els.startBtn?.click());
      grid.querySelector('#__now')?.addEventListener('click', () => els.refreshNowBtn?.click());
      if (els.headerDescription) els.headerDescription.textContent = 'Ready to track your organizations';
      return;
    }

    if (els.headerDescription) els.headerDescription.textContent = `Tracking ${list.length} organizations`;

    for (const org of list) {
      const card = document.createElement('div');
      const classes = ['org-card'];
      if (org.error) classes.push('has-error');
      if (wasUpdated(org.id)) classes.push('recently-updated');
      card.className = classes.join(' ');
      card.setAttribute('data-org-id', org.id);

      const avg = org.donors ? org.total / org.donors : 0;
      const pct = org.goal ? Math.round((org.total / org.goal) * 100) : 0;
      const pctCapped = Math.min(pct, 100);
      const fresh = getFreshness(org);
      const dot = fresh ? `<span class="freshness-indicator ${fresh}"></span>` : '';

      const ly = matchLastYear(org);

      card.innerHTML = `
        <div class="org-name">${org.name}${dot}</div>
        ${org.error ? `<div class="error">${org.error} <button class="btn btn-small" data-retry="${org.id}">Retry</button></div>` : ''}
        <div class="org-total">${$fmt(org.total)}</div>
        <div class="org-stats">
          <div class="stat-item">
            <div class="stat-value">${nfmt(org.donors || 0)}</div>
            <div class="stat-label">Donors</div>
          </div>
          <div class="stat-item">
            <div class="stat-value">${$fmt(avg)}</div>
            <div class="stat-label">Avg Gift</div>
          </div>
          <div class="stat-item goal-progress">
            <div class="stat-label">Goal Progress</div>
            <div class="progress-container">
              <div class="progress-bar" style="width:${pctCapped}%"></div>
              <div class="progress-text">${pct}%</div>
            </div>
          </div>
        </div>
        ${lyFooterHTML(ly)}
        <div class="org-actions">
          <div class="last-updated">${org.lastUpdated ? 'Updated: ' + new Date(org.lastUpdated).toLocaleTimeString() : 'Not yet updated'}</div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-primary btn-small" data-refresh="${org.id}">Refresh</button>
            <a class="btn btn-primary btn-small" target="_blank" rel="noopener noreferrer" href="${org.url}">View Page</a>
          </div>
        </div>
      `;
      grid.appendChild(card);
    }
  }

  // --- Actions ---
  async function loadAll() {
    try {
      const data = await api('/api/organizations');
      orgs = data || {};
      updateSummary();
      render();
    } catch (e) {
      toast(`Failed to load: ${e.message}`, false);
    }
  }

  async function refreshOne(id, btn) {
    if (isRefreshing) return;
    try {
      btn.disabled = true;
      btn.textContent = 'Refreshing…';
      if (orgs[id]) prevOrgs[id] = { ...orgs[id] };
      const data = await api(`/api/organizations/${id}/refresh`, { method: 'PUT' });
      orgs[id] = data;
      updateSummary();
      render();
      toast(`${data.name} refreshed`);
    } catch (e) {
      toast(`Refresh failed: ${e.message}`, false);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Refresh';
    }
  }

  async function refreshAll() {
    if (isRefreshing) return;
    isRefreshing = true;
    try {
      els.refreshNowBtn && (els.refreshNowBtn.disabled = true, els.refreshNowBtn.textContent = 'Refreshing…');
      prevOrgs = JSON.parse(JSON.stringify(orgs));
      const res = await api('/api/organizations/refresh', { method: 'PUT' });
      orgs = res.data || orgs;
      els.lastUpdate.textContent = 'Updated: ' + new Date().toLocaleTimeString();
      updateSummary();
      render();
      if (res.summary) {
        const { success, total, errors } = res.summary;
        toast(`Refreshed ${success}/${total}${errors ? ` (${errors} errors)` : ''}`);
      } else {
        toast('All organizations refreshed');
      }
    } catch (e) {
      toast(`Bulk refresh failed: ${e.message}`, false);
    } finally {
      isRefreshing = false;
      if (els.refreshNowBtn) {
        els.refreshNowBtn.disabled = false;
        els.refreshNowBtn.textContent = 'Refresh Now';
      }
    }
  }

  function start() {
    const secs = Math.max(30, parseInt(els.refreshInterval.value) || 90);
    els.refreshInterval.value = secs;
    if (timer) clearInterval(timer);
    timer = setInterval(refreshAll, secs * 1000);
    isMonitoring = true;
    els.startBtn.style.display = 'none';
    els.stopBtn.style.display = 'inline-block';
    els.statusIndicator.classList.add('active');
    els.statusText.textContent = `Auto-refreshing every ${secs}s`;
    refreshAll();
    toast(`Auto-refresh started (${secs}s)`);
  }

  function stop() {
    isMonitoring = false;
    if (timer) clearInterval(timer);
    timer = null;
    els.startBtn.style.display = 'inline-block';
    els.stopBtn.style.display = 'none';
    els.statusIndicator.classList.remove('active');
    els.statusText.textContent = 'Auto-refresh stopped';
    toast('Auto-refresh stopped');
  }

  function exportCSV() {
    try {
      const rows = [['Organization','Total Raised','Donors','Avg Gift','Goal','Goal %','Last Updated','Status','URL']];
      for (const o of Object.values(orgs)) {
        const avg = o.donors ? Math.round((o.total / o.donors) * 100) / 100 : 0;
        const pct = o.goal ? Math.round((o.total / o.goal) * 100) : 0;
        const last = o.lastUpdated ? new Date(o.lastUpdated).toLocaleString() : 'Never';
        rows.push([o.name, o.total||0, o.donors||0, avg, o.goal||0, pct, last, o.error ? 'Error' : 'OK', o.url]);
      }
      const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `ntgd-${new Date().toISOString().replace(/[:T]/g,'-').slice(0,16)}.csv`;
      document.body.appendChild(a); 
      a.click(); 
      a.remove();
      toast('Data exported');
    } catch (e) { 
      toast(`Export failed: ${e.message}`, false); 
    }
  }

  // --- Events ---
  function handleClicks(e) {
    const r = e.target.closest('[data-refresh]');
    const retry = e.target.closest('[data-retry]');
    if (r) refreshOne(r.getAttribute('data-refresh'), r);
    if (retry) {
      const id = retry.getAttribute('data-retry');
      const btn = els.orgs.querySelector(`[data-refresh="${id}"]`);
      if (btn) refreshOne(id, btn);
    }
  }

  // --- Init ---
  document.addEventListener('DOMContentLoaded', async () => {
    els.orgs?.addEventListener('click', handleClicks);
    els.startBtn?.addEventListener('click', start);
    els.stopBtn?.addEventListener('click', stop);
    els.refreshNowBtn?.addEventListener('click', refreshAll);
    els.exportBtn?.addEventListener('click', exportCSV);
    
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'r') {
        e.preventDefault(); 
        refreshAll(); 
        toast('Refreshed via keyboard');
      }
    });

    await loadLastYear();
    await loadAll();

    // Background top-up every 10 mins when idle
    setInterval(() => { 
      if (!isMonitoring) refreshAll(); 
    }, 600000);
  });
})();