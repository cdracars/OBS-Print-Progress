/* Verified browser dashboards for this local printer hub.
 * A link is withheld if a printer's configured address changes.
 */
(function (root) {
    'use strict';

    const CHECKED_AT = '2026-11-14';
    // Optional private records are kept in the ignored dashboard-links.local.js.
    const destinations = root.PrintDeskDestinations || {};

    function destination(printer) {
        const verified = Object.hasOwn(destinations, printer.id) ? destinations[printer.id] : null;
        if (!verified) return null;
        try {
            const raw = String(printer.ip || '').trim();
            const configured = new URL(/^https?:\/\//i.test(raw) ? raw : 'http://' + raw);
            const configuredUrl = 'http://' + verified.address + '/';
            const url = 'http://' + (verified.ethernetAddress || verified.address) + '/';
            if (!['http:', 'https:'].includes(new URL(url).protocol)) return null;
            if (configured.href !== configuredUrl && configured.href !== url) return null;
            const connection = verified.ethernetAddress ? 'Ethernet dashboard' : 'Wi-Fi dashboard; Ethernet address unverified';
            return { url, name: verified.name, checkedAt: CHECKED_AT, connection };
        } catch {
            return null;
        }
    }

    function html(printer) {
        const control = destination(printer);
        if (!control) {
            return '<div class="dashboard-nav"><span class="muted">Controls: no verified browser dashboard for this address.</span></div>';
        }
        // Escape local record labels before inserting them into markup.
        const escape = value => String(value).replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
        return `<div class="dashboard-nav">
            <a class="btn small" href="${escape(control.url)}" target="_blank" rel="noopener noreferrer">Open ${escape(control.name)} controls</a>
            <span class="dashboard-check">${control.connection} · HTTP 200 checked ${control.checkedAt}; availability may change.</span>
        </div>`;
    }

    function extraHtml(printers) {
        return Object.entries(destinations).filter(([id]) => !printers.some(p => p.id === id)).map(([id, record]) =>
            '<div class="note">Dashboard access only; no status view is configured in this hub.' + html({id, ip: record.address}) + '</div>'
        ).join('');
    }

    const api = { destination, html, extraHtml };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.PrinterDashboardLinks = api;
})(typeof window !== 'undefined' ? window : globalThis);
