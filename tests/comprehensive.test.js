const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
require('dotenv').config({ quiet: true });
const app = require('../app');
const User = require('../models/user');
const Task = require('../models/task');

test('HTTP statuses, all query subsets, and unchanged database on errors', async t => {
    // No application records are used or modified by this suite.
    const dbName = 'mp3_test_' + randomUUID().replaceAll('-', '').slice(0, 24);
    await mongoose.connect(process.env.MONGODB_URI, { dbName, serverSelectionTimeoutMS: 15000 });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const report = { querySubsetsPerEndpoint: 64, queryCases: 0, errorSnapshots: 0, requests: 0, statuses: [], failures: [], passed: false };
    async function check(name, run) {
        await t.test(name, async () => {
            try { await run(); }
            catch (err) { report.failures.push({name, message:err.message}); throw err; }
        });
    }
    const statuses = new Set();
    t.after(async () => {
        try {
            assert.equal(mongoose.connection.name, dbName);
            assert.match(dbName, /^mp3_test_[a-f0-9]{24}$/);
            await mongoose.connection.dropDatabase();
            report.temporaryDatabaseRemoved = true;
        } finally {
            await new Promise(resolve => server.close(resolve));
            await mongoose.disconnect();
            report.statuses = [...statuses].sort((a,b) => a-b);
            t.diagnostic(`Query cases: ${report.queryCases}; unchanged database checks: ${report.errorSnapshots}; temporary database removed: ${report.temporaryDatabaseRemoved === true}`);
        }
    });
    await Promise.all([User.init(), Task.init()]);
    const users = await User.insertMany(Array.from({length: 105}, (_, i) => ({name: `User${String(i).padStart(3, '0')}`,email: `user${i}@example.com`})));
    const tasks = await Task.insertMany(Array.from({length: 105}, (_, i) => ({name: `Task${String(i).padStart(3, '0')}`,deadline: '2026-11-03',completed: i % 2 === 0})));
    async function request(method, url, body, status = 200, raw = false) {
        const response = await fetch(base + url, {
            method, headers: {'Content-Type':'application/json'},
            ...(body === undefined ? {} : {body:raw ? body : JSON.stringify(body)}),
            signal:AbortSignal.timeout(15000)
        });
        report.requests++;
        statuses.add(response.status);
        assert.equal(response.status, status, method + ' ' + url);
        if (status === 204) { assert.equal(await response.text(), ''); return; }
        const result = await response.json();
        assert.equal(typeof result.message, 'string');
        assert.ok(Object.hasOwn(result, 'data'));
        return result;
    }
    async function snapshot() {
        return JSON.stringify({users:await User.find().sort({_id:1}).lean(),tasks:await Task.find().sort({_id:1}).lean()});
    }
    async function unchanged(method, url, body, status, raw = false) {
        const before = await snapshot();
        const result = await request(method, url, body, status, raw);
        if (status === 503) assert.equal(result.data.status, 'unavailable');
        else assert.equal(result.data, null);
        assert.doesNotMatch(result.message, /Mongoose|MongoServer|CastError|Injected|stack/i);
        assert.equal(await snapshot(), before, 'An error must leave the entire test database unchanged');
        report.errorSnapshots++;
    }
    for (const [kind, fixtures] of [['users', users], ['tasks', tasks]]) {
        await check(`${kind}: all 64 parameter subsets, both count values`, async () => {
            const keys = ['where','sort','select','skip','limit','count'];
            for (let mask = 0; mask < 64; mask++) {
                for (const count of mask & 32 ? [false, true] : [false]) {
                    const values = {where:{_id:{$in:fixtures.slice(0,5).map(doc=>String(doc._id))}},sort:{name:-1},select:{name:1,_id:0},skip:1,limit:3,count};
                    const chosen = Object.fromEntries(keys.filter((key,index)=>mask & (1 << index)).map(key=>[key,values[key]]));
                    const query = new URLSearchParams(Object.entries(chosen).map(([key,value])=>[key,JSON.stringify(value)]));
                    const {data} = await request('GET', `/${kind}?${query}`);
                    const candidates = (chosen.where ? fixtures.slice(0,5) : fixtures).map(doc=>({name:doc.name,_id:String(doc._id)}));
                    if (chosen.count) assert.equal(data, candidates.length);
                    else {
                        if (chosen.sort) candidates.sort((a,b)=>a.name < b.name ? 1 : a.name > b.name ? -1 : 0);
                        const start = chosen.skip || 0;
                        const limit = chosen.limit === undefined ? (kind === 'tasks' ? 100 : 0) : chosen.limit;
                        const page = candidates.slice(start,limit ? start+limit : undefined);
                        assert.equal(data.length,page.length);
                        assert.ok(data.every(row=>candidates.some(candidate=>candidate.name===row.name)));
                        if (chosen.sort) assert.deepEqual(data.map(row=>row.name),page.map(row=>row.name));
                        if (chosen.select) data.forEach(row=>assert.deepEqual(Object.keys(row),['name']));
                        else data.forEach(row=>{assert.ok(row._id);assert.ok(row.dateCreated);});
                    }
                    report.queryCases++;
                }
            }
        });
    }
    await check('Malformed JSON with all other parameters present returns 400 without writes', async () => {
        const valid = {where:'{}',sort:'{"name":1}',select:'{"name":1}',skip:'0',limit:'3',count:'false'};
        for (const kind of ['users','tasks']) for (const key of Object.keys(valid)) {
            const query = new URLSearchParams({...valid,[key]:'{'});
            await unchanged('GET',`/${kind}?${query}`,undefined,400);
        }
    });
    await check('200/201/204, CORS preflight, and health success', async () => {
        await request('GET','/health');
        await request('OPTIONS','/users',undefined,204);
        const {data} = await request('POST','/users',{name:'Created',email:'created@example.com'},201);
        await request('DELETE',`/users/${data._id}`,undefined,204);
    });
    await check('400 and 404 requests preserve the whole database', async () => {
        const validTask = {name:'Task',deadline:'2026-11-03'};
        const missing = '000000000000000000000001';
        for (const [method,url,body,status,raw] of [
            ['POST','/users',{},400],
            ['POST','/users',{name:'Duplicate',email:users[0].email},400],
            ['POST','/users','{"name":',400,true],
            ['POST','/tasks',{...validTask,assignedUser:'invalid'},400],
            ['POST','/tasks',{...validTask,assignedUser:missing},404],
            ['PUT',`/users/${users[0]._id}`,{name:12,email:users[0].email,pendingTasks:[missing]},400],
            ['PUT',`/users/${missing}`,{name:12,pendingTasks:['invalid']},404],
            ['PUT',`/tasks/${tasks[0]._id}`,{...validTask,assignedUser:missing,completed:'true'},400],
            ['GET','/users/invalid',undefined,404],
            ['DELETE','/tasks/invalid',undefined,404],
            ['DELETE',`/users/${missing}`,undefined,404],
            ['GET','/unknown',undefined,404]
        ]) await unchanged(method,url,body,status,raw);
    });
    await check('413 request too large preserves the whole database', async () => {
        await unchanged('POST','/tasks',{name:'Large',deadline:'2026-11-03',description:'x'.repeat(110000)},413);
    });
    await check('500 after a real write rolls back, without internal error details', async () => {
        const original = Task.updateMany;
        let injected = false;
        Task.updateMany = async function (...args) {
            await original.apply(this,args);
            injected = true;
            throw new Error('Injected test failure after write');
        };
        try { await unchanged('PUT',`/users/${users[0]._id}`,{name:'Changed',email:users[0].email},500); }
        finally { Task.updateMany = original; }
        assert.ok(injected);
    });
    await check('503 health ping failure preserves the whole database', async () => {
        const original = mongoose.connection.db.command;
        mongoose.connection.db.command = async function () { throw new Error('Injected database ping failure'); };
        try { await unchanged('GET','/health',undefined,503); }
        finally { mongoose.connection.db.command = original; }
    });
    assert.deepEqual([...statuses].sort((a,b)=>a-b),[200,201,204,400,404,413,500,503]);
    assert.equal(report.queryCases,192);
    report.passed = report.failures.length === 0;
});
