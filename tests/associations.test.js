const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
require('dotenv').config({ quiet: true });
const User = require('../models/user');
const Task = require('../models/task');

// Inject failures only in this test process.
test('Associations and transaction rollback against Atlas', async t => {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
    const app = require('../app');
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const prefix = `association-${randomUUID()}`;
    const deadline = '2026-11-03T23:59:00Z';
    t.after(async () => {
        // Only delete records owned by this test run.
        await Task.deleteMany({ name: { $regex: '^' + prefix } });
        await User.deleteMany({ email: { $regex: '^' + prefix } });
        await new Promise(resolve => server.close(resolve));
        await mongoose.disconnect();
    });
    await Promise.all([User.init(), Task.init()]);
    async function request(method, path, body, status = 200) {
        const response = await fetch(base + path, {
            method, headers: { 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(15000)
        });
        if (status === 204) {
            assert.equal(response.status, 204);
            assert.equal(await response.text(), '');
            return null;
        }
        const result = await response.json();
        assert.equal(response.status, status, `${method} ${path}: ${result.message}`);
        assert.equal(typeof result.message, 'string');
        assert.ok(Object.hasOwn(result, 'data'));
        return result.data;
    }
    const getUser = id => request('GET', `/users/${id}`);
    const getTask = id => request('GET', `/tasks/${id}`);
    async function makeUser(suffix, pendingTasks = []) {
        const user = await request('POST', '/users', { name: prefix + suffix, email: prefix + suffix + '@example.com', pendingTasks }, 201);
        return user;
    }
    async function makeTask(suffix, fields = {}) {
        const task = await request('POST', '/tasks', { name: prefix + suffix, deadline, ...fields }, 201);
        return task;
    }
    const a = await makeUser('-A');
    const b = await makeUser('-B');
    const task = await makeTask('-pending', { assignedUser: a._id });
    const completed = await makeTask('-completed', { assignedUser: a._id, completed: true });
    const spare = await makeTask('-spare');
    const putTask = (id, fields) => request('PUT', `/tasks/${id}`, { name: prefix + '-pending', deadline, ...fields });
    async function consistent() {
        const users = await User.find({ email: { $regex: '^' + prefix } }).lean();
        const tasks = await Task.find({ name: { $regex: '^' + prefix } }).lean();
        for (const user of users) {
            const expected = tasks.filter(task => task.assignedUser === String(user._id) && !task.completed).map(task => String(task._id)).sort();
            assert.deepEqual([...user.pendingTasks].sort(), expected);
            assert.equal(new Set(user.pendingTasks).size, user.pendingTasks.length);
        }
        for (const task of tasks) {
            if (!task.assignedUser) assert.equal(task.assignedUserName, 'unassigned');
            else {
                const owner = users.find(user => String(user._id) === task.assignedUser);
                assert.ok(owner);
                assert.equal(task.assignedUserName, owner.name);
            }
        }
    }
    await t.test('Assignment and explicit unassignment keep both sides synchronized', async () => {
        assert.deepEqual((await getUser(a._id)).pendingTasks, [task._id]);
        await putTask(task._id, { assignedUser: '' });
        assert.deepEqual((await getUser(a._id)).pendingTasks, []);
        assert.equal((await getTask(task._id)).assignedUserName, 'unassigned');
        await putTask(task._id, { assignedUser: a._id });
        await putTask(task._id, { assignedUser: a._id });
        await consistent();
    });
    await t.test('Complete and reopen for the same user without losing assignment', async () => {
        await putTask(task._id, { assignedUser: a._id, completed: true });
        assert.deepEqual((await getUser(a._id)).pendingTasks, []);
        assert.equal((await getTask(task._id)).assignedUser, a._id);
        await putTask(task._id, { assignedUser: a._id, completed: false });
        assert.deepEqual((await getUser(a._id)).pendingTasks, [task._id]);
        await consistent();
    });
    await t.test('Task PUT transfers pending and completed tasks', async () => {
        await putTask(task._id, { assignedUser: b._id });
        assert.deepEqual((await getUser(a._id)).pendingTasks, []);
        assert.deepEqual((await getUser(b._id)).pendingTasks, [task._id]);
        await putTask(completed._id, { assignedUser: b._id, completed: true });
        assert.deepEqual((await getUser(b._id)).pendingTasks, [task._id]);
        await consistent();
    });
    await t.test('User rename synchronizes pending and completed task names', async () => {
        await request('PUT', `/users/${b._id}`, { name: prefix + '-renamed', email: b.email, pendingTasks: [task._id] });
        assert.equal((await getTask(task._id)).assignedUserName, prefix + '-renamed');
        assert.equal((await getTask(completed._id)).assignedUserName, prefix + '-renamed');
        await consistent();
    });
    await t.test('User PUT moves pending tasks and unassigns omitted tasks', async () => {
        await request('PUT', `/users/${a._id}`, { name: a.name, email: a.email, pendingTasks: [task._id] });
        assert.deepEqual((await getUser(b._id)).pendingTasks, []);
        await request('PUT', `/users/${a._id}`, { name: a.name, email: a.email });
        assert.equal((await getTask(task._id)).assignedUser, '');
        await consistent();
    });
    await t.test('User POST adopts a task and removes it from its former owner', async () => {
        await putTask(spare._id, { assignedUser: a._id });
        const c = await makeUser('-C', [spare._id]);
        assert.equal((await getTask(spare._id)).assignedUser, c._id);
        assert.deepEqual((await getUser(a._id)).pendingTasks, []);
        await consistent();
    });
    async function snapshot() {
        const users = await User.find({ email: { $regex: '^' + prefix } }).sort({ _id: 1 }).lean();
        const tasks = await Task.find({ name: { $regex: '^' + prefix } }).sort({ _id: 1 }).lean();
        return JSON.stringify({ users, tasks });
    }
    async function rollback(target, method, operation) {
        const before = await snapshot();
        const original = target[method];
        let injected = false;
        target[method] = async function (...args) {
            const result = await original.apply(this, args);
            injected = true;
            throw new Error('Injected test failure after a database write');
        };
        try { await operation(); } finally { target[method] = original; }
        assert.ok(injected, 'Failure must happen after a real database write');
        assert.equal(await snapshot(), before, 'All database writes must roll back');
        await consistent();
    }
    await t.test('Task PUT rolls back after saving task and editing pendingTasks', async () => {
        await rollback(User, 'updateMany', () => request('PUT', `/tasks/${task._id}`, { name: prefix + '-changed', deadline, assignedUser: b._id }, 500));
    });
    await t.test('User PUT rolls back after saving user and editing tasks', async () => {
        await rollback(Task, 'updateMany', () => request('PUT', `/users/${b._id}`, { name: prefix + '-changed', email: b.email, pendingTasks: [task._id] }, 500));
    });
    await t.test('Task POST rolls back the newly inserted task', async () => {
        await rollback(User, 'updateMany', () => request('POST', '/tasks', { name: prefix + '-aborted-task', deadline, assignedUser: a._id }, 500));
    });
    await t.test('User POST rolls back the newly inserted user', async () => {
        await rollback(Task, 'updateMany', () => request('POST', '/users', { name: prefix + '-aborted-user', email: prefix + '-aborted@example.com', pendingTasks: [task._id] }, 500));
    });
    await t.test('Task DELETE rolls back removal and user reference cleanup', async () => {
        await putTask(task._id, { assignedUser: a._id });
        await rollback(Task.prototype, 'deleteOne', () => request('DELETE', `/tasks/${task._id}`, undefined, 500));
    });
    await t.test('User DELETE rolls back removal and all task unassignments', async () => {
        await putTask(completed._id, { assignedUser: a._id, completed: true });
        await rollback(User.prototype, 'deleteOne', () => request('DELETE', `/users/${a._id}`, undefined, 500));
    });
    await t.test('Task DELETE cleans pendingTasks', async () => {
        await request('DELETE', `/tasks/${task._id}`, undefined, 204);
        await request('GET', `/tasks/${task._id}`, undefined, 404);
        assert.deepEqual((await getUser(a._id)).pendingTasks, []);
        await consistent();
    });
    await t.test('User DELETE unassigns pending and completed tasks', async () => {
        await putTask(spare._id, { assignedUser: a._id });
        await request('DELETE', `/users/${a._id}`, undefined, 204);
        for (const id of [spare._id, completed._id]) {
            const task = await getTask(id);
            assert.equal(task.assignedUser, '');
            assert.equal(task.assignedUserName, 'unassigned');
        }
        await consistent();
    });
});
