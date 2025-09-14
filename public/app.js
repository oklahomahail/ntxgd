// public/app.js
(() => {
  'use strict';

  // ===== Config =====
  const API_BASE = `${window.location.origin}/api`;
  const URL_ = window.URL || window.webkitURL; // safe blob URL helper

  // ===== State =====
  let organizations = {};           // id -> org
  let isMonitoring = false;
  let monitoringInterval = null;

  // ===== Utils =====
  const $ = (sel) => document.querySelector(sel);

  const formatCurrency = (amount) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(amount || 0);

  const formatNumber = (num) =>
    new Intl.NumberFormat('en-US').format(num || 0);

  function showToast(message, type = 'success') {
    const container = $('#toast-container') || document.body;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    // trigger animation
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  async function apiCall(endpoint, options = {}) {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options
    });
    let data;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  // ===== Rendering =====
  function renderOrganizations() {
    const container = $('#organizationsContainer');
    const orgArray = Object.values(organizations);

    if (orgArray.length === 0) {
      container.innerHTML = `
        <div class="loading">
          <div class="spinner"></div>
          <p>No organizations configured yet.</p>
        </div>`;
      $('#headerDescription') && ($('#headerDescription').textContent = 'No organizations configured yet');
      $('#orgCount') && ($('#orgCount').textContent = '0');
      return;
    }

    // Sort by amount raised desc
    orgArray.sort((a, b) => (b.total || 0) - (a.total || 0));

    container.innerHTML = `
      <div class="org-grid">
        ${orgArray
          .map((org) => {
            const avg = org.donors > 0 ? org.total / org.donors : 0;
            const progress = org.goal > 0 ? Math.round((org.total / org.goal) * 100) : 0;
            const updated = org.lastUpdated
              ? new Date(org.lastUpdated).toLocaleTimeString()
              : 'Not yet updated';
            return `
              <div class="org-card" data-org-id="${org.id}">
                <div class="org-name">${org.name || org.id}</div>

                ${org.error ? `
                  <div class="error">
                    ${org.error}
                    <button class="btn btn-small" data-retry="${org.id}">Retry</button>
                  </div>` : ''}

                <div class="org-total" aria-label="Total raised: ${formatCurrency(org.total)}">
                  ${formatCurrency(org.total)}
                </div>

                <div class="org-stats">
                  <div class="stat-item">
                    <div class="stat-value">${formatNumber(org.donors)}</div>
                    <div class="stat-label">Donors</div>
                  </div>
                  <div class="stat-item">
                    <div class="stat-value">${formatCurrency(avg)}</div>
                    <div class="stat-label">Avg Gift</div>
                  </div>
                  <div class="stat-item">
                    <div class="stat-value">${progress}%</div>
                    <div class="stat-label">Goal Progress</div>
                  </div>
                </div>

                <div class="org-actions">
                  <div class="last-updated">Updated: ${updated}</div>
                  <div style="display:flex; gap:8px;">
                    <button class="btn btn-primary btn-small" data-refresh="${org.id}">Refresh</button>
                    <a class="btn btn-primary btn-small" href="${org.url}" target="_blank" rel="noopener noreferrer">View Page</a>
                  </div>
                </div>
              </div>
            `;
          })
          .join('')}
      </div>
    `;

    // Hook up per-card buttons
    container.querySelectorAll('[data-refresh]').forEach((btn) => {
      btn.addEventListener('click', () => refreshOrganization(btn.getAttribute('data-refresh')));
    });
    container.querySelectorAll('[data-retry]').forEach((btn) => {
      btn.addEventListener('click', () => refreshOrganization(btn.getAttribute('data-retry')));
    });
  }

  function updateSummary() {
    const orgArray = Object.values(organizations);
    const totalRaised = orgArray.reduce((sum, org) => sum + (org.total || 0), 0);
    const totalDonors = orgArray.reduce((sum, org) => sum + (org.donors || 0), 0);
    const avgGift = totalDonors > 0 ? totalRaised / totalDonors : 0;

    $('#totalRaised') && ($('#totalRaised').textContent = formatCurrency(totalRaised));
    $('#totalDonors') && ($('#totalDonors').textContent = formatNumber(totalDonors));
    $('#avgGift') && ($('#avgGift').textContent = formatCurrency(avgGift));
    $('#orgCount') && ($('#orgCount').textContent = formatNumber(orgArray.length));
    $('#headerDescription') && ($('#headerDescription').textContent = `Tracking your ${formatNumber(orgArray.length)} selected North Texas organizations`);
  }

  function setStatusActive(active, intervalSec) {
    const indicator = $('#statusIndicator');
    const statusText = $('#statusText');
    if (!indicator || !statusText) return;
    indicator.classList.toggle('active', !!active);
    statusText.textContent = active ? `Auto-refreshing every ${intervalSec}s` : 'Auto-refresh stopped';
  }

  function markLastUpdate() {
    const el = $('#lastUpdate');
    if (el) el.textContent = `Updated at ${new Date().toLocaleTimeString()}`;
  }

  // ===== Data Flow =====
  async function loadOrganizations() {
    try {
      const data = await apiCall('/organizations');
      organizations = data || {};
      renderOrganizations();
      updateSummary();
    } catch (e) {
      showToast(`Failed to load organizations: ${e.message}`, 'error');
    }
  }

  async function refreshAll() {
    const btn = $('#refreshNowBtn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Refreshing…';
    }
    try {
      const result = await apiCall('/organizations/refresh', { method: 'PUT' });
      if (result && result.data) {
        organizations = result.data;
        renderOrganizations();
        updateSummary();
        markLastUpdate();
        showToast('All organizations refreshed');
      } else {
        throw new Error('Unexpected response');
      }
    } catch (e) {
      showToast(`Bulk refresh failed: ${e.message}`, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Refresh Now';
      }
    }
  }

  async function refreshOrganization(id) {
    const card = document.querySelector(`.org-card[data-org-id="${id}"]`);
    const btn = card ? card.querySelector('[data-refresh]') : null;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Refreshing…';
      btn.setAttribute('aria-busy', 'true');
    }
    try {
      const org = await apiCall(`/organizations/${encodeURIComponent(id)}/refresh`, { method: 'PUT' });
      organizations[id] = org;
      renderOrganizations();
      updateSummary();
      markLastUpdate();
      showToast(`${org.name || id} refreshed`);
    } catch (e) {
      if (organizations[id]) {
        organizations[id].error = `Failed to refresh: ${e.message}`;
        organizations[id].lastUpdated = new Date().toISOString();
        renderOrganizations();
      }
      showToast(`Failed to refresh ${id}: ${e.message}`, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Refresh';
        btn.removeAttribute('aria-busy');
      }
    }
  }

  function startMonitoring() {
    if (Object.keys(organizations).length === 0) {
      showToast('No organizations loaded yet', 'error');
      return;
    }
    const input = $('#refreshInterval');
    const seconds = Math.max(30, Math.min(600, parseInt(input?.value || '90', 10) || 90));

    if (monitoringInterval) clearInterval(monitoringInterval);
    isMonitoring = true;
    setStatusActive(true, seconds);
    $('#startBtn') && ($('#startBtn').style.display = 'none');
    $('#stopBtn') && ($('#stopBtn').style.display = 'inline-block');

    refreshAll(); // do one immediately
    monitoringInterval = setInterval(refreshAll, seconds * 1000);
    showToast(`Auto-refresh started (${seconds}s)`);
  }

  function stopMonitoring() {
    isMonitoring = false;
    if (monitoringInterval) clearInterval(monitoringInterval);
    monitoringInterval = null;
    setStatusActive(false);
    $('#startBtn') && ($('#startBtn').style.display = 'inline-block');
    $('#stopBtn') && ($('#stopBtn').style.display = 'none');
    showToast('Auto-refresh stopped');
  }

  function exportData() {
    const orgArray = Object.values(organizations);
    const totalRaised = orgArray.reduce((sum, org) => sum + (org.total || 0), 0);
    const totalDonors = orgArray.reduce((sum, org) => sum + (org.donors || 0), 0);

    const payload = {
      exportDate: new Date().toISOString(),
      timestamp: new Date().toLocaleString(),
      organizations,
      summary: {
        totalRaised,
        totalDonors,
        organizationCount: orgArray.length,
        averageGift: totalDonors > 0 ? Math.round((totalRaised / totalDonors) * 100) / 100 : 0
      }
    };

    // JSON file
    const jsonBlob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const jsonUrl = URL_.createObjectURL(jsonBlob);
    const jsonLink = document.createElement('a');
    jsonLink.href = jsonUrl;
    jsonLink.download = `ntgd-data-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

    // CSV file
    const headers = ['Organization', 'Total Raised', 'Donors', 'Average Gift', 'Goal Progress %', 'Last Updated', 'Status'];
    const rows = orgArray.map((o) => [
      o.name || o.id,
      o.total || 0,
      o.donors || 0,
      o.donors > 0 ? Math.round((o.total / o.donors) * 100) / 100 : 0,
      o.goal > 0 ? Math.round((o.total / o.goal) * 100) : 0,
      o.lastUpdated ? new Date(o.lastUpdated).toLocaleString() : 'Never',
      o.error ? 'Error' : 'OK'
    ]);
    const csvContent = [headers, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const csvBlob = new Blob([csvContent], { type: 'text/csv' });
    const csvUrl = URL_.createObjectURL(csvBlob);
    const csvLink = document.createElement('a');
    csvLink.href = csvUrl;
    csvLink.download = `ntgd-data-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;

    // Trigger downloads (JSON then CSV)
    document.body.appendChild(jsonLink);
    document.body.appendChild(csvLink);
    jsonLink.click();
    setTimeout(() => csvLink.click(), 100);
    jsonLink.remove();
    csvLink.remove();

    URL_.revokeObjectURL(jsonUrl);
    URL_.revokeObjectURL(csvUrl);

    showToast('Exported JSON + CSV');
  }

  // ===== Wire up UI =====
  function bindEvents() {
    $('#startBtn')?.addEventListener('click', startMonitoring);
    $('#stopBtn')?.addEventListener('click', stopMonitoring);
    $('#refreshNowBtn')?.addEventListener('click', refreshAll);
    $('#exportBtn')?.addEventListener('click', exportData);

    // Background refresh every 10 minutes when not monitoring
    setInterval(() => {
      if (!isMonitoring && Object.keys(organizations).length > 0) {
        refreshAll();
      }
    }, 600_000);
  }

  // ===== Init =====
  document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    await loadOrganizations();
  });
})();
