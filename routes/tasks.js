const User = require('../models/user');
const Task = require('../models/task');
const api = require('../lib/api');

module.exports = function (router) {
    router.get('/tasks', (req, res) => api.list(Task, req, res));
    router.get('/tasks/:id', (req, res) => api.single(Task, req, res));

    async function write(req, res) {
        const data = await api.transaction(async session => {
            const task = req.method === 'PUT' ? await api.existing(Task, req.params.id, session) : new Task();
            const input = api.body(req);
            const name = api.text(input.name, 'name', true);
            const description = api.text(input.description, 'description');
            if (!['string', 'number'].includes(typeof input.deadline) || input.deadline === '' || !Number.isFinite(new Date(input.deadline).getTime())) api.bad('deadline must be a valid date');
            let completed = input.completed === undefined ? false : input.completed;
            // Form fields arrive as strings; JSON must use a real boolean.
            if (req.is('application/x-www-form-urlencoded') && (completed === 'true' || completed === 'false')) {
                completed = completed === 'true';
            }
            if (typeof completed !== 'boolean') api.bad('completed must be a boolean');
            const assignedUser = api.text(input.assignedUser, 'assignedUser').toLowerCase();
            if (assignedUser && !api.id(assignedUser)) api.bad('assignedUser must be a valid user id');
            let assignedUserName = api.text(input.assignedUserName, 'assignedUserName', false, 'unassigned');
            if (assignedUser) {
                const user = await api.existing(User, assignedUser, session);
                if (input.assignedUserName !== undefined && assignedUserName !== user.name) api.bad('assignedUserName must match the assigned user');
                // Conflict with user deletion/rename, even for completed tasks.
                await User.updateOne({ _id: user._id }, { $inc: { __v: 1 } }, { session });
                assignedUserName = user.name;
            } else {
                assignedUserName = 'unassigned';
            }
            task.set({ name, description, deadline: new Date(input.deadline), completed, assignedUser, assignedUserName });
            await task.save({ session });
            const taskId = task._id.toString();
            await User.updateMany({ pendingTasks: taskId }, { $pull: { pendingTasks: taskId } }, { session });
            if (assignedUser && !task.completed) await User.updateOne({ _id: assignedUser }, { $addToSet: { pendingTasks: taskId } }, { session });
            return task.toObject();
        });
        res.status(req.method === 'POST' ? 201 : 200).json({ message: req.method === 'POST' ? 'Task created' : 'Task updated', data });
    }
    router.post('/tasks', write);
    router.put('/tasks/:id', write);
    router.delete('/tasks/:id', async (req, res) => {
        await api.transaction(async session => {
            const task = await api.existing(Task, req.params.id, session);
            await User.updateMany({ pendingTasks: task._id.toString() }, { $pull: { pendingTasks: task._id.toString() } }, { session });
            await task.deleteOne({ session });
        });
        res.status(204).end();
    });
};
