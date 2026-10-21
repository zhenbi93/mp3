var mongoose = require('mongoose');

var TaskSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, cast: false },
    description: { type: String, default: '', cast: false },
    deadline: { type: Date, required: true },
    completed: { type: Boolean, default: false },
    assignedUser: { type: String, default: '', cast: false },
    assignedUserName: { type: String, default: 'unassigned', cast: false },
    dateCreated: { type: Date, default: Date.now, immutable: true }
});

TaskSchema.pre('validate', function () {
    if (this.isNew) this.dateCreated = new Date();
});

module.exports = mongoose.model('Task', TaskSchema);
