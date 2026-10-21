const User = require('../models/user');
const Task = require('../models/task');
const api = require('../lib/api');

module.exports = function (router) {
    router.get('/users', (req, res) => api.list(User, req, res));
    router.get('/users/:id', (req, res) => api.single(User, req, res));

    async function write(req, res) {
        const data = await api.transaction(async session => {
            const user = req.method === 'PUT' ? await api.existing(User, req.params.id, session) : new User();
            const input = api.body(req);
            const name = api.text(input.name, 'name', true);
            const email = api.text(input.email, 'email', true);
            const pending = input.pendingTasks === undefined ? [] : input.pendingTasks;
            if (!Array.isArray(pending) || pending.some(value => !api.id(value))) api.bad('pendingTasks must be a list of valid task ids');
            const pendingTasks = [...new Set(pending.map(value => value.toLowerCase()))];
            if (await User.exists({ email, _id: { $ne: user._id } }).session(session)) api.bad('Email is already in use');
            const tasks = await Task.find({ _id: { $in: pendingTasks } }).session(session);
            if (tasks.some(task => task.completed)) api.bad('pendingTasks cannot contain completed tasks');
            if (tasks.length !== pendingTasks.length) throw new api.ApiError(404, 'A referenced task was not found');

            const userId = user._id.toString();
            const removed = user.pendingTasks.filter(value => !pendingTasks.includes(value));
            user.set({ name, email, pendingTasks });
            await user.save({ session });
            await Task.updateMany({ _id: { $in: removed }, assignedUser: userId }, { $set: { assignedUser: '', assignedUserName: 'unassigned' } }, { session });
            await User.updateMany({ _id: { $ne: user._id }, pendingTasks: { $in: pendingTasks } }, { $pull: { pendingTasks: { $in: pendingTasks } } }, { session });
            await Task.updateMany({ _id: { $in: pendingTasks } }, { $set: { assignedUser: userId, assignedUserName: name } }, { session });
            await Task.updateMany({ assignedUser: userId }, { $set: { assignedUserName: name } }, { session });
            return user.toObject();
        });
        res.status(req.method === 'POST' ? 201 : 200).json({ message: req.method === 'POST' ? 'User created' : 'User updated', data });
    }
    router.post('/users', write);
    router.put('/users/:id', write);
    router.delete('/users/:id', async (req, res) => {
        await api.transaction(async session => {
            const user = await api.existing(User, req.params.id, session);
            await Task.updateMany({ assignedUser: user._id.toString() }, { $set: { assignedUser: '', assignedUserName: 'unassigned' } }, { session });
            await user.deleteOne({ session });
        });
        res.status(204).end();
    });
};
