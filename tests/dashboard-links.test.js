'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
global.PrintDeskDestinations = {
 hos:{address:'printer-a.example',ethernetAddress:'192.0.2.197',name:'Mainsail'},
 sam:{address:'printer-b.example',ethernetAddress:'192.0.2.199',name:'Mainsail'},
 pibeta:{address:'192.0.2.140',ethernetAddress:'192.0.2.220',name:'Mainsail'},
 eighttrack:{address:'192.0.2.111',ethernetAddress:'192.0.2.196',name:'Mainsail'},
 lucee:{address:'192.0.2.91',name:'Centauri Carbon dashboard'}
};
const links = require('../dashboard-links.js');

const expected = [
    ['hos', 'printer-a.example', '192.0.2.197', 'Mainsail'],
    ['sam', 'printer-b.example', '192.0.2.199', 'Mainsail'],
    ['eighttrack', '192.0.2.111', '192.0.2.196', 'Mainsail'],
    ['pibeta', '192.0.2.140', '192.0.2.220', 'Mainsail'],
    ['lucee', '192.0.2.91', '192.0.2.91', 'Centauri Carbon dashboard']
];
for (const [id, ip, preferredIp, name] of expected) {
    const p = { id, ip };
    assert.equal(links.destination(p).url, `http://${preferredIp}/`);
    assert.equal(links.destination({ id, ip: preferredIp }).url, `http://${preferredIp}/`);
    const html = links.html(p);
    assert.ok(html.includes(`href="http://${preferredIp}/"`));
    assert.ok(html.includes(`Open ${name} controls`));
    assert.ok(html.includes('rel="noopener noreferrer"'));
    assert.ok(html.includes('availability may change'));
    assert.ok(!html.includes('KlipperScreen controls'));
    assert.ok(html.includes(id === 'lucee' ? 'Wi-Fi dashboard; Ethernet address unverified' : 'Ethernet dashboard'));
}
for (const p of [
    { id: 'hos', ip: '192.0.2.99' },
    { id: 'hos', ip: '192.0.2.197:7125' },
    { id: 'hos', ip: 'https://192.0.2.197/' },
    { id: 'hos', ip: '192.0.2.197/unverified' },
    { id: 'unknown', ip: '192.0.2.197' },
    { id: '__proto__', ip: '192.0.2.197' },
    { id: 'hos', ip: 'javascript:alert(1)' }
]) {
    assert.equal(links.destination(p), null);
    assert.ok(!links.html(p).includes('<a '));
    assert.ok(links.html(p).includes('no verified browser dashboard'));
}
assert.equal(links.destination({ id: 'hos', ip: 'http://printer-a.example/' }).name, 'Mainsail');
const page = fs.readFileSync(path.join(__dirname, '../setup.html'), 'utf8');
assert.ok(page.indexOf('src="dashboard-links.js"') < page.indexOf('src="setup.js"'));
assert.ok(page.includes('KlipperScreen is the interface on an attached display'));
console.log('Dashboard links: five destinations, stale/unknown addresses and page integration passed.');

assert.ok(links.extraHtml([]).includes('Dashboard access only'));
assert.ok(links.extraHtml([]).includes('http://192.0.2.91/'));
assert.equal(links.extraHtml(expected.map(([id,ip])=>({id,ip}))), '');

assert.equal(links.destination({id:'pibeta',ip:'192.0.2.196'}),null, 'Reject a different verified printer address');
assert.equal(links.destination({id:'lucee',ip:'192.0.2.92'}),null, 'Do not guess a CC Ethernet address');
