'use strict';
const assert = require('node:assert/strict');
const { readTaskThumbnail, thumbnailFromDetail } = require('../centauri-thumbnail.js');
const printer = { type: 'elegoo-cc', ip: '192.0.2.91', mainboardId: 'board' };
const origin = 'http://192.0.2.91';
const detail = (taskId = 'active', filename = '/local/job.gcode', url = origin + '/board-resource/history_image/active.png') => ({
    Data: { Cmd: 321, MainboardID: 'board', Data: { Ack: 0, HistoryDetailList: [
        { TaskId: taskId, TaskName: filename, Thumbnail: url }
    ] } }
});
assert.deepEqual(thumbnailFromDetail(detail(), 'active', 'job.gcode', origin), { url: origin + '/board-resource/history_image/active.png' });
for (const message of [detail('old'), detail('active', 'other.gcode'),
    detail('active', 'job.gcode', 'http://other-host/board-resource/history_image/active.png'),
    detail('active', 'job.gcode', origin + '/board-resource/history_image/old.png'),
    detail('active', 'job.gcode', origin + '/board-resource/history_image/active.png?command=anything')]) {
    assert.equal(thumbnailFromDetail(message, 'active', 'job.gcode', origin), null);
}

let sent, closed, connectedUrl;
function fakeSocket(statusFilename = 'job.gcode', board = 'board') {
    return class {
        constructor(url) {
            connectedUrl = url; sent = []; closed = false;
            queueMicrotask(() => this.onopen());
        }
        send(text) {
            const message = JSON.parse(text); sent.push(message);
            queueMicrotask(() => this.onmessage({ data: JSON.stringify(message.Data.Cmd === 0
                ? { MainboardID: board, Status: { PrintInfo: { Filename: statusFilename, TaskId: 'active' } } }
                : detail()) }));
        }
        close() { closed = true; }
    };
}
(async () => {
    assert.deepEqual(await readTaskThumbnail(printer, 'job.gcode', fakeSocket()), { url: origin + '/board-resource/history_image/active.png' });
    assert.equal(connectedUrl, 'ws://192.0.2.91:3030/websocket');
    assert.deepEqual(sent.map(m => m.Data.Cmd), [0, 321], 'Only read-only status and task detail queries');
    assert.deepEqual(sent[1].Data.Data, { Id: ['active'] });
    assert.ok(closed);
    assert.equal(await readTaskThumbnail(printer, 'job.gcode', fakeSocket('different.gcode')), null);
    assert.deepEqual(sent.map(m => m.Data.Cmd), [0]);
    assert.equal(await readTaskThumbnail(printer, 'job.gcode', fakeSocket('job.gcode', 'different-board')), null);
    assert.equal(await readTaskThumbnail({ ...printer, type: 'klipper' }, 'job.gcode', class { constructor() { throw Error('Must not connect'); } }), null);
    console.log('CC thumbnails: active task/file/source matching, stale-image rejection, read-only queries and socket cleanup passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
