/* Enhanced NTXGD front-end with performance optimizations */
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
  let isRefreshing = false;
  let failedAttempts = 0;

  // Cache formatters for better performance
  const currencyFormatter = new Intl.NumberFormat('en-US', { 
    style: 'currency', 
    currency: 'USD', 
    minimumFractionDigits: 0, 
    maximumFractionDigits: 0 
  });
  const numberFormatter = new Intl.NumberFormat('en-US');

  const fmt$ = n => currencyFormatter.format(n || 0);
  const fmtN = n => numberFormatter.format(n || 0);

  // Debounced toast to prevent spam
  let toastTimeout;
  const toast = (msg, ok = true) => {
    clearTimeout(toastTimeout);
    
    // Remove existing toasts
    document.querySelectorAll('.toast').forEach(t => t.remove());
    
    const t = document.createElement('div');
    t.className = 'toast ' + (ok ? 'success' : 'error');
    t.textContent = msg;
    document.body.appendChild(t);
    
    requestAnimationFrame(() => t.classList.add('show'));
    
    toastTimeout = setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 300);
    }, 2500);
  };

  // Enhanced API function with timeout and better error handling
  async function api(path, opts = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout
    
    try {
      const res = await fetch(path, { 
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        ...opts 
      });
      
      clearTimeout(timeoutId);
      
      if (!res.ok) {
        const errorText = await res.text().catch(() => res.statusText);
        throw new Error(`${res.status}: ${errorText}`);
      }
      
      return res.json();
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error('Request timed out - server may be busy');
      }
      throw error;
    }
  }

  // Optimized summary update with change detection
  let lastSummary = {};
  function updateSummary() {
    const arr = Object.values(orgs);
    const totalRaised = arr.reduce((s, o) => s + (o.total || 0), 0);
    const totalDonors = arr.reduce((s, o) => s + (o.donors || 0), 0);
    const avgGift = totalDonors > 0 ? totalRaised / totalDonors : 0;
    const orgCount = arr.length;

    const newSummary = { totalRaised, totalDonors, avgGift, orgCount };
    
    // Only update DOM if values changed
    if (JSON.stringify(newSummary) !== JSON.stringify(lastSummary)) {
      els.totalRaised.textContent = fmt$(totalRaised);
      els.totalDonors.textContent = fmtN(totalDonors);
      els.avgGift.textContent = fmt$(avgGift);
      els.orgCount.textContent = fmtN(orgCount);
      lastSummary = newSummary;
    }
  }

  // Use DocumentFragment for better performance on large updates
  function render() {
    const arr = Object.values(orgs).sort((a, b) => (b.total || 0) - (a.total || 0));
    
    if (!arr.length) {
      els.orgsContainer.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading your organizations…</p></div>';
      if (els.headerDescription) {
        els.headerDescription.textContent = 'Loading your organizations…';
      }
      return;
    }

    if (els.headerDescription) {
      els.headerDescription.textContent = `Tracking ${arr.length} organizations`;
    }

    // Use template for better performance
    const fragment = document.createDocumentFragment();
    const gridDiv = document.createElement('div');
    gridDiv.className = 'org-grid';

    arr.forEach(org => {
      const card = document.createElement('div');
      card.className = 'org-card';
      card.setAttribute('data-org-id', org.id);
      
      const avgGift = org.donors ? (org.total / org.donors) : 0;
      const goalProgress = org.goal ? Math.round((org.total / org.goal) * 100) : 0;
      
      card.innerHTML = `
        <div class="org-name">${org.name}</div>
        ${org.error ? `<div class="error">${org.error}<button class="btn btn-small" data-retry="${org.id}">Retry</button></div>` : ''}
        <div class="org-total">${fmt$(org.total)}</div>
        <div class="org-stats">
          <div class="stat-item">
            <div class="stat-value">${fmtN(org.donors || 0)}</div>
            <div class="stat-label">Donors</div>
          </div>
          <div class="stat-item">
            <div class="stat-value">${fmt$(avgGift)}</div>
            <div class="stat-label">Avg Gift</div>
          </div>
          <div class="stat-item">
            <div class="stat-value">${goalProgress}%</div>
            <div class="stat-label">Goal Progress</div>
          </div>
        </div>
        <div class="org-actions">
          <div class="last-updated">${org.lastUpdated ? 'Updated: ' + new Date(org.lastUpdated).toLocaleTimeString() : 'Not yet updated'}</div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-primary btn-small" data-refresh="${org.id}">Refresh</button>
            <a class="btn btn-primary btn-small" target="_blank" rel="noopener noreferrer" href="${org.url}">View Page</a>
          </div>
        </div>
      `;
      
      gridDiv.appendChild(card);
    });

    fragment.appendChild(gridDiv);
    els.orgsContainer.innerHTML = '';
    els.orgsContainer.appendChild(fragment);

    // Add event listeners using delegation for better performance
    els.orgsContainer.addEventListener('click', handleOrgActions);
  }

  // Event delegation for better performance
  function handleOrgActions(e) {
    if (e.target.hasAttribute('data-refresh')) {
      refreshOrganization(e.target.getAttribute('data-refresh'), e.target);
    } else if (e.target.hasAttribute('data-retry')) {
      const id = e.target.getAttribute('data-retry');
      const refreshBtn = els.orgsContainer.querySelector(`[data-refresh="${id}"]`);
      if (refreshBtn) refreshOrganization(id, refreshBtn);
    }
  }

  async function refreshOrganization(id, button) {
    if (isRefreshing) return;
    
    try {
      button.disabled = true;
      button.textContent = 'Refreshing…';
      
      const data = await api(`/api/organizations/${id}/refresh`, { method: 'PUT' });
      orgs[id] = data;
      updateSummary();
      render();
      toast(`${data.name} refreshed`);
    } catch (e) {
      toast(`Refresh failed: ${e.message}`, false);
    } finally {
      button.disabled = false;
      button.textContent = 'Refresh';
    }
  }

  async function load() {
    try {
      const data = await api('/api/organizations');
      orgs = data || {};
      updateSummary();
      render();
    } catch (e) {
      toast(`Failed to load organizations: ${e.message}`, false);
    }
  }

  async function refreshAll() {
    if (isRefreshing) return;
    isRefreshing = true;
    
    try {
      if (els.refreshNowBtn) {
        els.refreshNowBtn.disabled = true;
        els.refreshNowBtn.textContent = 'Refreshing…';
      }
      
      const res = await api('/api/organizations/refresh', { method: 'PUT' });
      orgs = res.data || orgs;
      updateSummary();
      render();
      els.lastUpdate.textContent = 'Updated: ' + new Date().toLocaleTimeString();
      
      // Show summary of results
      if (res.summary) {
        const { success, errors, total } = res.summary;
        toast(`Refreshed ${success}/${total} organizations${errors > 0 ? ` (${errors} errors)` : ''}`);
      } else {
        toast('All organizations refreshed');
      }
      
      failedAttempts = 0; // Reset on success
    } catch (e) {
      failedAttempts++;
      toast(`Bulk refresh failed: ${e.message}`, false);
    } finally {
      isRefreshing = false;
      if (els.refreshNowBtn) {
        els.refreshNowBtn.disabled = false;
        els.refreshNowBtn.textContent = 'Refresh Now';
      }
    }
  }

  // Enhanced auto-refresh with exponential backoff on errors
  function start() {
    const secs = Math.max(30, parseInt(els.refreshInterval.value) || 90);
    els.refreshInterval.value = secs;
    
    if (timer) clearInterval(timer);
    
    timer = setInterval(async () => {
      try {
        await refreshAll();
        failedAttempts = 0; // Reset on success
      } catch (e) {
        failedAttempts++;
        // Exponential backoff: 90s, 180s, 360s, max 600s
        const delay = Math.min(secs * Math.pow(2, failedAttempts), 600);
        clearInterval(timer);
        timer = setTimeout(() => start(), delay * 1000);
        toast(`Auto-refresh failed, retrying in ${delay}s`, false);
      }
    }, secs * 1000);
    
    isMonitoring = true;
    els.startBtn.style.display = 'none';
    els.stopBtn.style.display = 'inline-block';
    els.statusIndicator.classList.add('active');
    els.statusText.textContent = `Auto-refreshing every ${secs}s`;
    
    // Initial refresh
    refreshAll();
    toast(`Auto-refresh started (${secs}s)`);
  }

  function stop() {
    isMonitoring = false;
    failedAttempts = 0;
    
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    
    els.startBtn.style.display = 'inline-block';
    els.stopBtn.style.display = 'none';
    els.statusIndicator.classList.remove('active');
    els.statusText.textContent = 'Auto-refresh stopped';
    toast('Auto-refresh stopped');
  }

  // Enhanced CSV export
  function exportData() {
    try {
      const rows = [['Organization', 'Total Raised', 'Donors', 'Avg Gift', 'Goal', 'Goal %', 'Last Updated', 'Status', 'URL']];
      const arr = Object.values(orgs);
      
      arr.forEach(o => {
        const avgGift = o.donors ? Math.round((o.total / o.donors) * 100) / 100 : 0;
        const goalPercent = o.goal ? Math.round((o.total / o.goal) * 100) : 0;
        const lastUpdated = o.lastUpdated ? new Date(o.lastUpdated).toLocaleString() : 'Never';
        const status = o.error ? 'Error' : 'OK';
        
        rows.push([
          o.name,
          o.total || 0,
          o.donors || 0,
          avgGift,
          o.goal || 0,
          goalPercent,
          lastUpdated,
          status,
          o.url
        ]);
      });
      
      const csv = rows.map(r => 
        r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')
      ).join('\n');
      
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      
      if (link.download !== undefined) {
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', `ntgd-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        toast('Data exported successfully');
      }
    } catch (e) {
      toast(`Export failed: ${e.message}`, false);
    }
  }

  // Check for server health on startup
  async function checkServerHealth() {
    try {
      const health = await api('/api/health');
      if (health.status === 'ok') {
        console.log('Server health check passed:', health);
      }
    } catch (e) {
      console.warn('Server health check failed:', e.message);
      toast('Server may be experiencing issues', false);
    }
  }

  // Initialize when DOM is ready
  document.addEventListener('DOMContentLoaded', () => {
    // Remove existing event listeners before adding new ones
    els.orgsContainer?.removeEventListener('click', handleOrgActions);
    
    els.startBtn?.addEventListener('click', start);
    els.stopBtn?.addEventListener('click', stop);
    els.refreshNowBtn?.addEventListener('click', refreshAll);
    els.exportBtn?.addEventListener('click', exportData);
    
    // Check server health and load initial data
    checkServerHealth();
    load();
    
    // Fallback refresh every 10 minutes when not monitoring
    setInterval(() => {
      if (!isMonitoring) {
        refreshAll();
      }
    }, 600000);
  });

  // Handle visibility change to optimize when tab is hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && isMonitoring) {
      console.log('Tab hidden, continuing background refresh');
    } else if (!document.hidden && isMonitoring) {
      console.log('Tab visible, refresh active');
      // Optionally trigger immediate refresh when tab becomes visible
    }
  });

  // Handle page unload cleanup
  window.addEventListener('beforeunload', () => {
    if (timer) {
      clearInterval(timer);
    }
  });

  // Global error handler for unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection:', event.reason);
    toast('An unexpected error occurred', false);
  });

})();
// Enhanced version - integrated improvements