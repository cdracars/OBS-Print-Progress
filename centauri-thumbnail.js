/* Read-only Centauri Carbon task-thumbnail fallback. No printer controls. */
(function (root) {
    'use strict';
    const cache = new Map();

    function basename(value) {
        return String(value || '').split('/').pop();
    }

    function thumbnailFromDetail(message, taskId, filename, origin) {
        const response = message.Data;
        if (response?.Cmd !== 321 || response.Data?.Ack !== 0) return null;
        const detail = response.Data.HistoryDetailList?.find(task =>
            task.TaskId === taskId && basename(task.TaskName) === basename(filename));
        if (!detail?.Thumbnail) return null;
        try {
            const url = new URL(detail.Thumbnail, origin);
            if (url.origin !== origin || url.username || url.password ||
                url.pathname !== `/board-resource/history_image/${taskId}.png` || url.search || url.hash) return null;
            return { url: url.href };
        } catch {
            return null;
        }
    }

    function readTaskThumbnail(printer, filename, Socket = root.WebSocket) {
        if (printer.type !== 'elegoo-cc' || !printer.mainboardId || !basename(filename)) return Promise.resolve(null);
        let origin, socketUrl;
        try {
            const source = new URL(/^https?:\/\//i.test(printer.ip) ? printer.ip : 'http://' + printer.ip);
            if (source.username || source.password || source.pathname !== '/' || source.search || source.hash) return Promise.resolve(null);
            origin = source.origin;
            source.protocol = source.protocol === 'https:' ? 'wss:' : 'ws:';
            source.port = '3030';
            source.pathname = '/websocket';
            socketUrl = source.href;
        } catch {
            return Promise.resolve(null);
        }
        return new Promise(resolve => {
            let socket, done = false, taskId = null;
            const finish = result => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                if (socket) socket.close();
                resolve(result);
            };
            const timer = setTimeout(() => finish(null), 5000);
            try {
                socket = new Socket(socketUrl);
                const request = (cmd, data) => socket.send(JSON.stringify({
                    Id: '',
                    Data: { Cmd: cmd, Data: data, RequestID: root.crypto.randomUUID(),
                        MainboardID: printer.mainboardId, TimeStamp: Math.floor(Date.now() / 1000), From: 1 },
                    Topic: 'sdcp/request/' + printer.mainboardId
                }));
                // Only GET_STATUS (0) and GET_TASK_DETAIL (321) are sent.
                socket.onopen = () => request(0, {});
                socket.onmessage = event => {
                    if (done) return;
                    let message;
                    try { message = JSON.parse(event.data); } catch { return; }
                    const board = message.MainboardID || message.Data?.MainboardID;
                    if (board && board !== printer.mainboardId) return finish(null);
                    const status = message.Status || message.Data?.Status;
                    if (!taskId && status?.PrintInfo) {
                        const info = status.PrintInfo;
                        if (!info.TaskId || basename(info.Filename) !== basename(filename)) return finish(null);
                        taskId = info.TaskId;
                        request(321, { Id: [taskId] });
                    } else if (taskId && message.Data?.Cmd === 321) {
                        finish(thumbnailFromDetail(message, taskId, filename, origin));
                    }
                };
                socket.onerror = socket.onclose = () => finish(null);
            } catch {
                finish(null);
            }
        });
    }

    async function getThumbnail(id, filename, bridgeHost) {
        // Only the configured local hub's matching printer may supply this fallback.
        if (!id || bridgeHost !== `${root.location.host}/p/${id}`) return null;
        const key = JSON.stringify([id, filename]);
        const previous = cache.get(key);
        if (previous && Date.now() - previous.time < 30000) return previous.promise;
        const promise = (async () => {
            try {
                const response = await root.fetch('/api/printers', { signal: AbortSignal.timeout(3000) });
                if (!response.ok) return null;
                const printer = (await response.json()).printers?.find(p => p.id === id);
                return printer ? await readTaskThumbnail(printer, filename) : null;
            } catch {
                return null;
            }
        })();
        cache.set(key, { time: Date.now(), promise });
        if (cache.size > 20) cache.delete(cache.keys().next().value);
        return promise;
    }

    const api = { getThumbnail, readTaskThumbnail, thumbnailFromDetail };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.CentauriThumbnail = api;
})(typeof window !== 'undefined' ? window : globalThis);
