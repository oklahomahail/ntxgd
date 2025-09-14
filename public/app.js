/* NTXGD front-end */
(() => {
  const els = {
    totalRaised: document.getElementById('totalRaised'),
    totalDonors: document.getElementById('totalDonors'),
    avgGift: document.getElementById('avgGift'),
    orgCount: document.getElementById('orgCount'),
    orgsContainer: document.getElementById('organizationsContainer'),
    startBtn: document.getElementById('startBtn'),
    stopBtn: document.getElementById('stopBtn'),
    refreshNowBtn: document.getElementById('refreshNowBtn'),
    exportBtn: document.getElementById('exportBtn'),
    statusIndicator: document.getElementById('statusIndicator'),
    statusText: document.getElementById('statusText'),
    lastUpdate: document.getElementById('lastUpdate'),
    refreshInterval: document.getElementById('refreshInterval'),
    headerDescription: document.getElementById('headerDescription')
  };

  let orgs = {};
  let isMonitoring = false;
  let timer = null;

  const fmt$ = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits:0, maximumFractionDigits:0 }).format(n||0);
  const fmtN = n => new Intl.NumberFormat('en-US').format(n||0);

  const toast = (msg, ok=true) => {
    const t = document.createElement('div');
    t.className = 'toast ' + (ok ? 'success':'error');
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(()=>t.classList.add('show'));
    setTimeout(()=>{ t.classList.remove('show'); setTimeout(()=>t.remove(),300); }, 2500);
  };

  async function api(path, opts) {
    const res = await fetch(path, { headers: { 'Content-Type':'application/json' }, ...opts });
    if (!res.ok) throw new Error(await res.text().catch(()=>res.statusText));
    return res.json();
  }

  function updateSummary() {
    const arr = Object.values(orgs);
    const totalRaised = arr.reduce((s,o)=>s+(o.total||0), 0);
    const totalDonors = arr.reduce((s,o)=>s+(o.donors||0), 0);
    const avgGift = totalDonors>0 ? totalRaised/totalDonors : 0;

    els.totalRaised.textContent = fmt$(totalRaised);
    els.totalDonors.textContent = fmtN(totalDonors);
    els.avgGift.textContent = fmt$(avgGift);
    els.orgCount.textContent = fmtN(arr.length);
  }

  function render() {
    const arr = Object.values(orgs).sort((a,b)=>(b.total||0)-(a.total||0));
    if (!arr.length) {
      els.orgsContainer.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading your organizations…</p></div>';
      els.headerDescription && (els.headerDescription.textContent = 'Loading your organizations…');
      return;
    }
    els.headerDescription && (els.headerDescription.textContent = `Tracking ${arr.length} organizations`);
    els.orgsContainer.innerHTML = `
      <div class="org-grid">
        ${arr.map(o => `
          <div class="org-card" data-org-id="${o.id}">
            <div class="org-name">${o.name}</div>
            ${o.error ? `<div class="error">${o.error}<button class="btn btn-small" data-retry="${o.id}">Retry</button></div>` : ''}
            <div class="org-total">${fmt$(o.total)}</div>
            <div class="org-stats">
              <div class="stat-item"><div class="stat-value">${fmtN(o.donors||0)}</div><div class="stat-label">Donors</div></div>
              <div class="stat-item"><div class="stat-value">${fmt$(o.donors? (o.total/o.donors) : 0)}</div><div class="stat-label">Avg Gift</div></div>
              <div class="stat-item"><div class="stat-value">${o.goal? Math.round((o.total/o.goal)*100) : 0}%</div><div class="stat-label">Goal Progress</div></div>
            </div>
            <div class="org-actions">
              <div class="last-updated">${o.lastUpdated ? 'Updated: ' + new Date(o.lastUpdated).toLocaleTimeString() : 'Not yet updated'}</div>
              <div style="display:flex;gap:8px;">
                <button class="btn btn-primary btn-small" data-refresh="${o.id}">Refresh</button>
                <a class="btn btn-primary btn-small" target="_blank" rel="noopener noreferrer" href="${o.url}">View Page</a>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `;
    els.orgsContainer.querySelectorAll('[data-refresh]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-refresh');
        try {
          btn.disabled = true; btn.textContent = 'Refreshing…';
          const data = await api(`/api/organizations/${id}/refresh`, { method: 'PUT' });
          orgs[id] = data; updateSummary(); render(); toast(`${data.name} refreshed`);
        } catch (e) {
          toast(`Refresh failed: ${e.message}`, false);
        } finally {
          btn.disabled = false; btn.textContent = 'Refresh';
        }
      });
    });
    els.orgsContainer.querySelectorAll('[data-retry]').forEach(btn => btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-retry');
      const r = els.orgsContainer.querySelector(`[data-refresh="${id}"]`);
      r && r.click();
    }));
  }

  async function load() {
    try {
      const data = await api('/api/organizations');
      orgs = data || {};
      updateSummary(); render();
    } catch (e) {
      toast(`Failed to load organizations: ${e.message}`, false);
    }
  }

  async function refreshAll() {
    try {
      if (els.refreshNowBtn) { els.refreshNowBtn.disabled = true; els.refreshNowBtn.textContent = 'Refreshing…'; }
      const res = await api('/api/organizations/refresh', { method: 'PUT' });
      orgs = res.data || orgs; updateSummary(); render();
      els.lastUpdate.textContent = 'Updated: ' + new Date().toLocaleTimeString();
      toast('All organizations refreshed');
    } catch (e) {
      toast(`Bulk refresh failed: ${e.message}`, false);
    } finally {
      if (els.refreshNowBtn) { els.refreshNowBtn.disabled = false; els.refreshNowBtn.textContent = 'Refresh Now'; }
    }
  }

  function start() {
    const secs = Math.max(30, parseInt(els.refreshInterval.value)||90);
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
    if (timer) clearInterval(timer), (timer = null);
    els.startBtn.style.display = 'inline-block';
    els.stopBtn.style.display = 'none';
    els.statusIndicator.classList.remove('active');
    els.statusText.textContent = 'Auto-refresh stopped';
    toast('Auto-refresh stopped');
  }

  function exportData() {
    const rows = [['Organization','Total Raised','Donors','Avg Gift','Goal %','Last Updated','Status']];
    const arr = Object.values(orgs);
    arr.forEach(o => rows.push([
      o.name, o.total||0, o.donors||0, (o.donors? (Math.round((o.total/o.donors)*100)/100):0),
      (o.goal? Math.round((o.total/o.goal)*100):0), (o.lastUpdated? new Date(o.lastUpdated).toLocaleString():'Never'), (o.error?'Error':'OK')
    ]));
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type:'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ntgd-${new Date().toISOString().replace(/[:T]/g,'-').slice(0,16)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  document.addEventListener('DOMContentLoaded', () => {
    els.startBtn && els.startBtn.addEventListener('click', start);
    els.stopBtn && els.stopBtn.addEventListener('click', stop);
    els.refreshNowBtn && els.refreshNowBtn.addEventListener('click', refreshAll);
    els.exportBtn && els.exportBtn.addEventListener('click', exportData);
    load();
    setInterval(() => { if (!isMonitoring) refreshAll(); }, 600000);
  });
})();
// bump Sun Sep 14 17:06:40 CDT 2025
